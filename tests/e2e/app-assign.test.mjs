import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';
const ERR_OWNER_ONLY = '구성원 초대는 대표만 할 수 있습니다.';
const ERR_STATUS = '상태는 검토중 / 참여 / 패스 중 하나입니다.';
const ERR_LIMIT = '구성원은 5명까지 둘 수 있습니다.';

let browser;
const cleanups = [];

async function newApp() {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  const app = await startApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key' } });
  cleanups.push(() => app.stop());
  return app;
}

async function newPage(baseUrl, cookie) {
  const { context, page } = await openAs(browser, baseUrl, cookie);
  cleanups.push(() => context.close());
  return page;
}

// 알림 조건을 저장하고 daily 잡으로 공고를 모은다
async function seedBids(app, page) {
  await page.goto(`${app.baseUrl}/settings`);
  await page.fill('#keywords', '조경, 수목, 가로수, 공원');
  await page.fill('#regions', '경기, 서울');
  await page.fill('#budgetMin', '30000000');
  await page.fill('#budgetMax', '500000000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했습니다.').waitFor();
  const job = await runJob(app.baseUrl, 'daily');
  assert.equal(job.status, 200);
  await page.goto(`${app.baseUrl}/today`);
  await page.waitForSelector('ol.bids li.card');
}

// 오늘 화면 첫 공고의 id (배정 링크에서 읽는다)
async function firstBidId(page) {
  const href = await page.locator('ol.bids li.card a[href^="/assign/"]').first().getAttribute('href');
  assert.ok(href, 'first bid has an assign link');
  return decodeURIComponent(href.slice('/assign/'.length));
}

async function invite(page, baseUrl, name) {
  await page.goto(`${baseUrl}/assign/members`);
  await page.fill('input[name=name]', name);
  await page.getByRole('button', { name: '초대 링크 만들기' }).click();
}

describe('app assign', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('assign: invite staff then assign and share status', { timeout: 120000 }, async () => {
    const app = await newApp();
    const { cookie } = await setupOwner(app.baseUrl);
    const owner = await newPage(app.baseUrl, cookie);
    await seedBids(app, owner);
    const bidId = await firstBidId(owner);

    // 초대
    await invite(owner, app.baseUrl, '사무담당');
    await owner.getByText('이 링크는 지금만 보입니다').waitFor();
    const link = await owner.locator('input[readonly]').inputValue();
    assert.match(link, /\/join\/[^/\s]+$/);
    assert.equal(await owner.locator('input[readonly]').count(), 1);
    await shot(owner, 'assign-members-invite');

    // 쿠키 없는 두 번째 컨텍스트로 링크 접속 → staff 로그인
    const staff = await newPage(app.baseUrl);
    await staff.goto(link);
    await staff.waitForURL('**/today');
    await staff.waitForSelector('ol.bids li.card');

    // 배정
    await owner.goto(`${app.baseUrl}/assign/${encodeURIComponent(bidId)}`);
    await owner.selectOption('select[name=assignee]', { label: '사무담당 (구성원)' });
    await owner.selectOption('select[name=status]', { label: '검토중' });
    await owner.getByRole('button', { name: '저장', exact: true }).click();
    await owner.waitForURL('**/assign');
    const section = owner.locator('section', { has: owner.getByRole('heading', { name: '검토중' }) });
    await section.locator('li.card', { hasText: '담당 사무담당' }).waitFor();
    await shot(owner, 'assign-board');

    // staff 의 오늘 화면에 담당·상태 공유
    await staff.reload();
    await staff.locator('ol.bids li.card', { hasText: '담당 사무담당 · 검토중' }).waitFor();

    // 링크는 다시 보이지 않는다
    await owner.goto(`${app.baseUrl}/assign/members`);
    assert.equal(await owner.locator('input[readonly]').count(), 0);
    assert.ok(!(await owner.locator('main').innerText()).includes('/join/'));

    // 6번째 구성원 거부 (대표 + 사무담당 + 3명 = 5명)
    for (const n of ['구성원A', '구성원B', '구성원C']) {
      await invite(owner, app.baseUrl, n);
      await owner.getByText('이 링크는 지금만 보입니다').waitFor();
    }
    await invite(owner, app.baseUrl, '구성원D');
    await owner.getByText(ERR_LIMIT).waitFor();
  });

  it('assign: staff cannot invite', { timeout: 60000 }, async () => {
    const app = await newApp();
    const { cookie } = await setupOwner(app.baseUrl);
    const owner = await newPage(app.baseUrl, cookie);
    await invite(owner, app.baseUrl, '사무담당');
    const link = await owner.locator('input[readonly]').inputValue();

    const staff = await newPage(app.baseUrl);
    await staff.goto(link);
    await staff.waitForURL('**/today');
    const res = await staff.request.post(`${app.baseUrl}/assign/members`, { form: { name: '몰래추가' }, maxRedirects: 0 });
    assert.equal(res.status(), 403);
    assert.ok((await res.text()).includes(ERR_OWNER_ONLY));

    // 화면에서도 같은 문구가 보인다 (브라우저 폼 제출)
    await staff.goto(`${app.baseUrl}/assign/members`);
    await staff.getByText(ERR_OWNER_ONLY).first().waitFor();
    await staff.evaluate(async () => {
      const r = await fetch('/assign/members', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=%EB%AA%B0%EB%9E%98' });
      document.open();
      document.write(await r.text());
      document.close();
    });
    await staff.getByText(ERR_OWNER_ONLY).first().waitFor();
    assert.ok(!/MEMBER_|OWNER_|Error:|stack/i.test(await staff.locator('main').innerText()));
    await shot(staff, 'assign-403');

    // 추가되지 않았다
    await owner.goto(`${app.baseUrl}/assign/members`);
    assert.ok(!(await owner.locator('main').innerText()).includes('몰래추가'));
  });

  it('assign: invalid status is rejected', { timeout: 120000 }, async () => {
    const app = await newApp();
    const { cookie } = await setupOwner(app.baseUrl);
    const owner = await newPage(app.baseUrl, cookie);
    await seedBids(app, owner);
    const bidId = await firstBidId(owner);

    const res = await owner.request.post(`${app.baseUrl}/assign/${encodeURIComponent(bidId)}`, {
      form: { assignee: '1', status: 'maybe', note: '' },
      maxRedirects: 0,
    });
    assert.equal(res.status(), 400);
    assert.ok((await res.text()).includes(ERR_STATUS));

    await owner.goto(`${app.baseUrl}/assign`);
    await owner.getByText('담당자를 정한 공고가 없습니다.').waitFor();
    assert.ok(!(await owner.locator('main').innerText()).includes('담당 '));
  });
});
