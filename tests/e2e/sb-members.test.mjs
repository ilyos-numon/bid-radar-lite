import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';
import {
  SB,
  skipIfDown,
  startSbApp,
  randomEmail,
  signupAndVerify,
  createWorkspace,
  toPlaywrightCookies,
  withOrigin,
  adminDbUrl,
  withPg,
} from './helpers/supabase.mjs';

// Supabase 모드 구성원: 대표가 내보내기, 구성원은 못 함, 계정 삭제 뒤 회사 데이터 0행
const PASSWORD = 'e2e-password-1';
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const ONLY_OWNER = '구성원 내보내기는 대표만 할 수 있습니다.';

let browser;
const cleanups = [];

async function newContext(opts = {}) {
  const context = await browser.newContext(opts);
  cleanups.push(() => context.close());
  return context;
}

const cookieHeader = async (context) => (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');

async function postRemove(app, cookie, memberId) {
  const res = await fetch(
    `${app.baseUrl}/assign/members/${memberId}/remove`,
    withOrigin(app.baseUrl, { method: 'POST', headers: { cookie }, redirect: 'manual' }),
  );
  return { status: res.status, text: await res.text() };
}

const bidCount = (workspaceId) =>
  withPg(adminDbUrl(), async (c) => Number((await c.query('SELECT count(*)::int AS n FROM public.bids WHERE workspace_id = $1', [workspaceId])).rows[0].n));

describe('sb members', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('sb-members: owner removes a member, who lands on new company screen; account delete leaves no bids', { skip: skipIfDown, timeout: 240000 }, async () => {
    const mock = await startMockHttp();
    cleanups.push(() => mock.close());
    mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
    const app = await startSbApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key', APP_SHARED_KEYS: '1', APP_WORKER: '0' } });
    cleanups.push(() => app.stop());

    // 대표: 회사 만들기 → 공고 가져오기
    const ownerEmail = randomEmail('memo');
    const first = await signupAndVerify(app.baseUrl, { email: ownerEmail, password: PASSWORD, name: '멤버대표' });
    const made = await createWorkspace(app.baseUrl, first.cookie, { company: '구성원 조경', name: '멤버대표' });
    const ownerCtx = await newContext({ viewport: { width: 1280, height: 900 } });
    await ownerCtx.addCookies(toPlaywrightCookies(app.baseUrl, made.cookie));
    const owner = await ownerCtx.newPage();
    await owner.goto(`${app.baseUrl}/settings`);
    await owner.fill('#keywords', '조경, 수목, 가로수, 공원');
    await owner.fill('#regions', '경기, 서울');
    await owner.fill('#budgetMin', '30000000');
    await owner.fill('#budgetMax', '500000000');
    await owner.getByRole('button', { name: '저장', exact: true }).click();
    await owner.getByText('저장했습니다.').waitFor();
    await owner.goto(`${app.baseUrl}/today`);
    await owner.getByRole('button', { name: '오늘 공고 가져오기' }).click();
    await owner.waitForSelector('ol.bids li.card');
    const href = await owner.locator('ol.bids li.card a[href^="/assign/"]').first().getAttribute('href');
    const bidPath = href;
    assert.ok((await bidCount(made.workspaceId)) > 0, 'bids exist before deletion');

    // 구성원 초대 → 초대 대기 표시
    await owner.goto(`${app.baseUrl}/assign/members`);
    await owner.fill('input[name=name]', '새식구');
    await owner.getByRole('button', { name: '초대 링크 만들기' }).click();
    await owner.getByText('이 링크는 지금만 보입니다').waitFor();
    const link = await owner.locator('input[readonly]').inputValue();
    assert.match(await owner.locator('main').innerText(), /초대 대기/);

    // 구성원: 가입 → 초대 수락
    const staffEmail = randomEmail('mems');
    const staffSignup = await signupAndVerify(app.baseUrl, { email: staffEmail, password: PASSWORD, name: '새식구' });
    const staffCtx = await newContext({ viewport: { width: 1280, height: 900 } });
    await staffCtx.addCookies(toPlaywrightCookies(app.baseUrl, staffSignup.cookie));
    const staff = await staffCtx.newPage();
    await staff.goto(link);
    await staff.getByRole('button', { name: '들어가기' }).click();
    await staff.waitForURL(`${app.baseUrl}/today`);
    const staffCookie = await cookieHeader(staffCtx);

    // 대표가 공고를 새식구에게 맡긴다
    await owner.goto(`${app.baseUrl}/assign/members`);
    const removeForm = owner.locator('form[action$="/remove"]', { has: owner.getByRole('button', { name: '새식구 내보내기' }) });
    const staffId = (await removeForm.getAttribute('action')).split('/').at(-2);
    assert.equal(await owner.getByText('초대 대기').count(), 0, 'accepted member is no longer pending');
    await owner.goto(`${app.baseUrl}${bidPath}`);
    await owner.selectOption('select[name=assignee]', staffId);
    await owner.getByRole('button', { name: '저장', exact: true }).click();
    await owner.waitForURL('**/assign');
    await owner.locator('li.card', { hasText: '담당 새식구' }).first().waitFor();

    // 구성원은 내보낼 수 없다
    const denied = await postRemove(app, staffCookie, '1');
    assert.equal(denied.status, 403);
    assert.ok(denied.text.includes(ONLY_OWNER), 'staff sees the owner-only message');
    // 대표 본인은 내보낼 수 없다
    const self = await postRemove(app, await cookieHeader(ownerCtx), '1');
    assert.equal(self.status, 400);

    // 대표 화면: 내보내기 버튼 → 누르면 안내
    await owner.goto(`${app.baseUrl}/assign/members`);
    await removeForm.getByRole('button', { name: '새식구 내보내기' }).waitFor();
    await shot(owner, 'members-owner');
    await removeForm.getByRole('button', { name: '새식구 내보내기' }).click();
    await owner.getByText('새식구 님을 내보냈습니다.').waitFor();
    assert.ok(!(await owner.locator('main table').innerText()).includes('새식구'), 'removed member is gone from the list');

    // 담당은 미정으로 돌아간다
    await owner.goto(`${app.baseUrl}/assign`);
    await owner.locator('li.card', { hasText: '담당 미정' }).first().waitFor();
    assert.equal(await owner.locator('li.card', { hasText: '담당 새식구' }).count(), 0);

    // 내보낸 사용자는 회사 화면 대신 새 회사 만들기로 간다
    const gone = await fetch(`${app.baseUrl}/today`, { headers: { cookie: staffCookie }, redirect: 'manual' });
    assert.ok(gone.status === 302 || gone.status === 303, `redirect status ${gone.status}`);
    assert.equal(new URL(gone.headers.get('location'), app.baseUrl).pathname, '/workspaces/new');
    await staff.goto(`${app.baseUrl}/today`);
    await staff.waitForURL(`${app.baseUrl}/workspaces/new`);

    // 대표가 계정을 삭제하면 회사 데이터가 남지 않는다
    await owner.goto(`${app.baseUrl}/account`);
    const del = owner.locator('#delete');
    await del.locator('input[name=password]').fill(PASSWORD);
    await del.locator('input[name=confirm]').check();
    await del.locator('button[type=submit]').click();
    await owner.waitForURL(`${app.baseUrl}/welcome?deleted=1`);
    assert.equal(await bidCount(made.workspaceId), 0, 'no bids left for the deleted company');
    await withPg(adminDbUrl(), async (c) => {
      const left = await c.query('SELECT (SELECT count(*) FROM public.assign_items WHERE workspace_id = $1)::int AS n', [made.workspaceId]);
      assert.equal(left.rows[0].n, 0, 'no assignments left');
    });
  });

  it('sb-members: removing a missing member and a pending invite are handled', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startSbApp({ env: { APP_WORKER: '0' } });
    cleanups.push(() => app.stop());
    const first = await signupAndVerify(app.baseUrl, { email: randomEmail('memp'), password: PASSWORD, name: '대기대표' });
    const made = await createWorkspace(app.baseUrl, first.cookie, { company: '대기 조경', name: '대기대표' });

    const missing = await postRemove(app, made.cookie, '999');
    assert.equal(missing.status, 404);
    const notNumber = await postRemove(app, made.cookie, 'abc');
    assert.equal(notNumber.status, 404);

    // 아직 수락하지 않은 초대도 내보낼 수 있다
    const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(toPlaywrightCookies(app.baseUrl, made.cookie));
    const page = await ctx.newPage();
    await page.goto(`${app.baseUrl}/assign/members`);
    await page.fill('input[name=name]', '대기식구');
    await page.getByRole('button', { name: '초대 링크 만들기' }).click();
    await page.getByText('이 링크는 지금만 보입니다').waitFor();
    assert.match(await page.locator('main').innerText(), /초대 대기/);
    await page.getByRole('button', { name: '대기식구 내보내기' }).click();
    await page.getByText('대기식구 님을 내보냈습니다.').waitFor();
    assert.equal(await page.getByText('초대 대기').count(), 0, 'pending invite is gone');
  });
});
