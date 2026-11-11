import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { shot } from './helpers/app.mjs';
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
} from './helpers/supabase.mjs';

const opts = { skip: skipIfDown, timeout: 180000 };

// Supabase 모드: 회사별 인증키 저장·마스킹·연결 확인·회사 간 분리, 가져오기에서 회사 키 사용
const PASSWORD = 'e2e-password-1';
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const NARA_KEY = 'e2e-nara-key-7f3a';
const MASKED = '등록됨 e2e…3a';
const NOT_SET = '등록 안 됨';

let browser;
const cleanups = [];

async function newMock() {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync('tests/fixtures/nara-bids.json', 'utf8') });
  return mock;
}

async function newApp(mock) {
  const app = await startSbApp({ env: { NARA_API_BASE: mock.baseUrl } });
  cleanups.push(() => app.stop());
  return app;
}

async function newCompany(app, tag, company) {
  const { cookie } = await signupAndVerify(app.baseUrl, { email: randomEmail(tag), password: PASSWORD, name: `대표${tag}` });
  return createWorkspace(app.baseUrl, cookie, { company, name: `대표${tag}` });
}

async function pageFor(app, cookie) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  cleanups.push(() => context.close());
  await context.addCookies(toPlaywrightCookies(app.baseUrl, cookie));
  return context.newPage();
}

function cookieValue(cookie, name) {
  const part = cookie.split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : '';
}

/** 대표가 구성원 초대 링크를 만들고, 새 사용자가 가입·수락해 구성원 쿠키를 돌려준다 */
async function inviteStaff(app, ownerCookie) {
  const res = await fetch(
    `${app.baseUrl}/assign/members`,
    withOrigin(app.baseUrl, { method: 'POST', body: new URLSearchParams({ name: '직원' }), headers: { cookie: ownerCookie } }),
  );
  const html = await res.text();
  assert.equal(res.status, 200, 'invite page answers 200');
  const m = /value="(https?:\/\/[^"]*\/join\/([^"/]+))"/.exec(html);
  assert.ok(m, 'invite link is shown once');
  const token = m[2];

  const { cookie } = await signupAndVerify(app.baseUrl, { email: randomEmail('staff'), password: PASSWORD, name: '직원' });
  const join = await fetch(
    `${app.baseUrl}/join/${token}`,
    withOrigin(app.baseUrl, { method: 'POST', headers: { cookie }, redirect: 'manual' }),
  );
  await join.arrayBuffer();
  assert.equal(join.status, 303, 'invite accepted');
  const ws = join.headers.getSetCookie().map((s) => s.split(';')[0]).find((s) => s.startsWith('br_ws='));
  assert.ok(ws, 'workspace cookie is set for the staff');
  const base = cookie.split(';').map((s) => s.trim()).filter((s) => !s.startsWith('br_ws='));
  return [...base, ws].join('; ');
}

describe('sb connections', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('sb-connections: save keys, masked, check connection, isolated', opts, async () => {
    const mock = await newMock();
    const app = await newApp(mock);
    const a = await newCompany(app, 'a', '연결 가 조경');
    const page = await pageFor(app, a.cookie);

    await page.goto(`${app.baseUrl}/connections`);
    const card = page.locator('#conn-nara');
    assert.equal((await card.locator('[data-status]').innerText()).trim(), NOT_SET);
    assert.equal(await card.getByRole('button', { name: '연결 확인' }).isDisabled(), true, 'check disabled before a key exists');
    await shot(page, 'sb-connections');

    // 저장 → 마스킹 상태
    await card.locator('input[name=NARA_API_KEY]').fill(NARA_KEY);
    await card.getByRole('button', { name: '저장', exact: true }).click();
    await page.waitForURL(/\/connections\?saved=nara/);
    assert.equal((await card.locator('[data-status]').innerText()).trim(), MASKED);
    assert.equal(await card.locator('input[name=NARA_API_KEY]').inputValue(), '', 'input never holds the saved value');
    await shot(page, 'sb-connections-masked');

    // 페이지 소스에 평문 없음
    const source = await (await fetch(`${app.baseUrl}/connections`, { headers: { cookie: a.cookie } })).text();
    assert.ok(!source.includes(NARA_KEY), 'page source has no key plaintext');
    assert.ok(!(await page.content()).includes(NARA_KEY), 'rendered DOM has no key plaintext');

    // 연결 확인: 200 → 연결됨
    await card.getByRole('button', { name: '연결 확인' }).click();
    await page.waitForURL(/\/connections\?check=nara/);
    const ok = page.locator('#conn-nara [data-check-result=ok]');
    await ok.waitFor();
    assert.match(await ok.innerText(), /연결됨/);
    assert.ok(mock.requests.some((r) => r.path === NARA_PATH), 'mock nara was called');

    // 401 → 인증키가 맞지 않습니다
    mock.set(NARA_PATH, { status: 401, body: '{}' });
    await card.getByRole('button', { name: '연결 확인' }).click();
    const bad = page.locator('#conn-nara [data-check-result=badkey]');
    await bad.waitFor();
    assert.match(await bad.innerText(), /인증키가 맞지 않습니다/);

    // 회사 B 는 등록 안 됨
    const b = await newCompany(app, 'b', '연결 나 조경');
    const pageB = await pageFor(app, b.cookie);
    await pageB.goto(`${app.baseUrl}/connections`);
    assert.equal((await pageB.locator('#conn-nara [data-status]').innerText()).trim(), NOT_SET);
    assert.equal(await pageB.locator('#conn-nara').getByRole('button', { name: '연결 확인' }).isDisabled(), true);

    // A 의 구성원: 값은 보이되 폼은 disabled + 안내
    const staffCookie = await inviteStaff(app, a.cookie);
    assert.ok(cookieValue(staffCookie, 'br_ws') !== '', 'staff cookie has workspace');
    const pageS = await pageFor(app, staffCookie);
    await pageS.goto(`${app.baseUrl}/connections`);
    assert.match(await pageS.locator('[data-owner-only]').innerText(), /인증키는 대표만 바꿀 수 있습니다/);
    assert.equal((await pageS.locator('#conn-nara [data-status]').innerText()).trim(), MASKED);
    assert.equal(await pageS.locator('#conn-nara input[name=NARA_API_KEY]').isDisabled(), true);
    const save = pageS.locator('#conn-nara').getByRole('button', { name: '저장', exact: true });
    assert.equal(await save.isDisabled(), true);
    assert.equal(await pageS.locator('#conn-nara').getByRole('button', { name: '삭제' }).isDisabled(), true);
    const forced = await fetch(
      `${app.baseUrl}/connections/nara/remove`,
      withOrigin(app.baseUrl, { method: 'POST', headers: { cookie: staffCookie } }),
    );
    assert.equal(forced.status, 403, 'staff cannot delete by direct POST');
    await forced.arrayBuffer();

    // 삭제 → 등록 안 됨
    await card.getByRole('button', { name: '삭제' }).click();
    await page.waitForURL(/\/connections\?removed=nara/);
    assert.equal((await card.locator('[data-status]').innerText()).trim(), NOT_SET);
  });

  it('sb-connections: today run uses workspace key', opts, async () => {
    const mock = await newMock();
    const app = await newApp(mock);
    const a = await newCompany(app, 'run', '가져오기 조경');

    const saved = await fetch(
      `${app.baseUrl}/connections/nara`,
      withOrigin(app.baseUrl, {
        method: 'POST',
        body: new URLSearchParams({ NARA_API_KEY: NARA_KEY }),
        headers: { cookie: a.cookie },
        redirect: 'manual',
      }),
    );
    await saved.arrayBuffer();
    assert.equal(saved.status, 303, 'key saved');

    const run = await fetch(
      `${app.baseUrl}/today/run`,
      withOrigin(app.baseUrl, { method: 'POST', headers: { cookie: a.cookie }, redirect: 'manual' }),
    );
    await run.arrayBuffer();
    assert.ok(run.status === 303 || run.status === 200, `today run answers (status ${run.status})`);

    const calls = mock.requests.filter((r) => r.path === NARA_PATH);
    assert.ok(calls.length >= 1, 'mock nara received the fetch');
    assert.ok(
      calls.every((r) => r.query.serviceKey === NARA_KEY),
      'every fetch used the workspace key',
    );
  });
});
