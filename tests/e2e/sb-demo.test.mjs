import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { shot } from './helpers/app.mjs';
import { startMockMailApi } from './helpers/mock-guard.mjs';
import {
  SB,
  skipIfDown,
  startSbApp,
  randomEmail,
  signupAndVerify,
  toPlaywrightCookies,
  withOrigin,
  adminDbUrl,
  withPg,
} from './helpers/supabase.mjs';
import { DEMO_BIDS, DEMO_INTERESTS, DEMO_TEXT } from '../../app/core/demo/fixture.mjs';

// Supabase 모드 데모: 가입 없이 예시 회사로 들어가기, 막힌 동작, 매일 초기화, 상태·운영 화면, 메일 미리보기
const PASSWORD = 'e2e-password-1';
const JOB_TOKEN = 'e2e-job';
const DOMAIN = `demo-${randomBytes(3).toString('hex')}.example.com`;
const OWNER_EMAIL = `demo-owner@${DOMAIN}`;

let browser;
const cleanups = [];

async function newContext(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, ...opts });
  cleanups.push(() => context.close());
  return context;
}

/** 예시 회사 표는 공유 DB 에 하나뿐이다. 앞선 실행이나 개발 중 만든 것까지 지우고 이 파일 전용으로 시작·정리한다 */
async function purgeDemo() {
  const rows = await withPg(adminDbUrl(), async (c) => {
    const found = (await c.query('SELECT workspace_id, owner_user_id, staff_user_ids FROM public.demo_workspaces')).rows;
    await c.query('DELETE FROM public.demo_workspaces');
    for (const r of found) await c.query('DELETE FROM public.workspaces WHERE id = $1', [r.workspace_id]);
    return found;
  });
  const admin = createClient(SB.url, SB.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ids = new Set();
  for (const r of rows) for (const id of [r.owner_user_id, ...(r.staff_user_ids ?? [])]) ids.add(id);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
}

async function startDemoApp(env = {}) {
  const app = await startSbApp({
    env: {
      APP_DEMO: '1',
      APP_DEMO_EMAIL_DOMAIN: DOMAIN,
      APP_PLATFORM_ADMIN_EMAILS: OWNER_EMAIL,
      APP_WORKER: '0',
      ...env,
    },
  });
  cleanups.push(() => app.stop());
  return app;
}

const reset = (app) => fetch(`${app.baseUrl}/api/jobs/demo-reset`, { headers: { 'x-job-token': JOB_TOKEN } });

/** 예시 회사를 만들어 둔다(첫 초기화). 이미 있으면 한 번 더 초기화 */
async function seeded(app) {
  const res = await reset(app);
  assert.equal(res.status, 200, `demo-reset status ${res.status}`);
  return res.json();
}

const cookieFrom = (res) =>
  res.headers
    .getSetCookie()
    .map((s) => s.split(';')[0])
    .filter((s) => !/=$/.test(s))
    .join('; ');

/** POST /demo/login → 쿠키 */
async function demoLogin(app) {
  const res = await fetch(`${app.baseUrl}/demo/login`, withOrigin(app.baseUrl, { method: 'POST', redirect: 'manual' }));
  await res.arrayBuffer();
  assert.equal(res.status, 303, `demo login status ${res.status}`);
  assert.equal(res.headers.get('location'), '/today');
  return cookieFrom(res);
}

const post = (app, pathname, cookie, fields = {}) =>
  fetch(`${app.baseUrl}${pathname}`, withOrigin(app.baseUrl, { method: 'POST', headers: { cookie }, body: new URLSearchParams(fields), redirect: 'manual' }));

const demoRow = () => withPg(adminDbUrl(), async (c) => (await c.query('SELECT * FROM public.demo_workspaces LIMIT 1')).rows[0]);

describe('sb demo', () => {
  before(async () => {
    if (!SB.up) return;
    browser = await chromium.launch();
    await purgeDemo();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
    if (SB.up) await purgeDemo().catch(() => process.stderr.write('warning: e2e demo cleanup failed\n'));
  });

  it('sb-demo: button on landing opens the example company with banner, chips and cards', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startDemoApp();
    await seeded(app);
    const ctx = await newContext();
    const page = await ctx.newPage();

    await page.goto(`${app.baseUrl}/`);
    await page.getByRole('button', { name: DEMO_TEXT.button }).waitFor();
    assert.ok((await page.locator('body').innerText()).includes(DEMO_TEXT.caption));
    await shot(page, 'demo-landing');

    await page.getByRole('button', { name: DEMO_TEXT.button }).click();
    await page.waitForURL(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const banner = page.locator('.banner.demo');
    assert.equal(await banner.count(), 1, 'one banner');
    const bannerText = await banner.innerText();
    assert.ok(bannerText.includes('예시 데이터로 둘러보는 중입니다'), bannerText);
    await banner.getByRole('link', { name: DEMO_TEXT.bannerLink }).waitFor();
    const cards = await page.locator('main li.card').count();
    assert.ok(cards >= 5, `at least 5 cards (${cards})`);
    assert.ok((await page.locator('.chip.example').count()) >= 1, 'example chip is shown');
    assert.equal((await page.locator('.chip.example').first().innerText()).trim(), DEMO_TEXT.chip);
    assert.ok((await page.locator('body').innerText()).includes('새봄조경(예시)'), 'company name is shown');
    await shot(page, 'demo-today');

    const first = page.locator('details.explain').first();
    await first.locator('summary').click();
    const items = await first.locator('li').allInnerTexts();
    assert.ok(items.length === 4, `4 checks (${items.length})`);
    assert.ok(items.some((t) => t.includes('맞음') || /일치|없음|안/.test(t)), items.join('|'));
    assert.match(await first.innerText(), /왜 추천됐나 · \d\/4 조건 맞음/);
    await shot(page, 'demo-explain');
  });

  it('sb-demo: saving a key is blocked with 403 and no key row is written', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startDemoApp();
    await seeded(app);
    const cookie = await demoLogin(app);
    const ws = (await demoRow()).workspace_id;
    const keyRows = () => withPg(adminDbUrl(), async (c) => (await c.query('SELECT 1 FROM public.workspace_keys WHERE workspace_id = $1', [ws])).rowCount);
    assert.equal(await keyRows(), 0);

    const res = await fetch(`${app.baseUrl}/connections/nara`, {
      ...withOrigin(app.baseUrl, { method: 'POST', headers: { cookie, accept: 'text/html' }, body: new URLSearchParams({ NARA_API_KEY: 'dummy-key-for-e2e' }) }),
    });
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes(DEMO_TEXT.blocked));
    const asJson = await fetch(`${app.baseUrl}/connections/nara`, {
      ...withOrigin(app.baseUrl, { method: 'POST', headers: { cookie, accept: 'application/json' }, body: new URLSearchParams({ NARA_API_KEY: 'dummy-key-for-e2e' }) }),
    });
    assert.equal(asJson.status, 403);
    assert.deepEqual(await asJson.json(), { error: 'demo_blocked' });
    assert.equal(await keyRows(), 0, 'workspace_keys stays empty');

    // 화면에서도 같은 안내가 보인다
    const ctx = await newContext();
    await ctx.addCookies(toPlaywrightCookies(app.baseUrl, cookie));
    const page = await ctx.newPage();
    await page.goto(`${app.baseUrl}/connections`);
    await page.locator('form[action="/connections/nara"] input[name=NARA_API_KEY]').fill('dummy-key-for-e2e');
    await page.locator('form[action="/connections/nara"] button[type=submit]').first().click();
    await page.getByText(DEMO_TEXT.blocked).waitFor();
    await shot(page, 'demo-banner-blocked');
    assert.equal(await keyRows(), 0, 'still empty after the browser submit');
  });

  it('sb-demo: an added interest is gone after the daily reset and the count goes up', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startDemoApp();
    await seeded(app);
    const cookie = await demoLogin(app);
    const taken = new Set(DEMO_INTERESTS.map((i) => i.bidId));
    const bid = DEMO_BIDS.find((b) => !taken.has(b.bidId));
    assert.ok(bid, 'a bid without interest exists');
    const before = Number((await demoRow()).reset_count);

    const added = await post(app, `/interest/add/${bid.bidId}`, cookie);
    assert.equal(added.status, 303);
    const list = await fetch(`${app.baseUrl}/interest`, { headers: { cookie } });
    assert.ok((await list.text()).includes(bid.title), 'interest list shows the added bid');

    const body = await seeded(app);
    assert.equal(body.ok, true);
    assert.equal(Number((await demoRow()).reset_count), before + 1, 'reset_count went up by one');
    const after1 = await fetch(`${app.baseUrl}/interest`, { headers: { cookie } });
    assert.ok(!(await after1.text()).includes(bid.title), 'added interest is gone');
  });

  it('sb-demo: account delete and password change are refused and reset needs the job token', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startDemoApp();
    await seeded(app);
    const cookie = await demoLogin(app);

    const del = await post(app, '/account/delete', cookie, { confirm: '1' });
    assert.equal(del.status, 403);
    const pw = await post(app, '/account/password', cookie, { password: 'another-password-9' });
    assert.equal(pw.status, 403);
    const still = await fetch(`${app.baseUrl}/today`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(still.status, 200, 'the demo session still works');

    const account = await fetch(`${app.baseUrl}/account`, { headers: { cookie } });
    assert.ok((await account.text()).includes(DEMO_TEXT.accountLocked));

    const noToken = await fetch(`${app.baseUrl}/api/jobs/demo-reset`);
    assert.equal(noToken.status, 403);
    assert.deepEqual(await noToken.json(), { error: 'forbidden' });
  });

  it('sb-demo: plan change, cancel and resume are refused and the subscription stays as it was', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startDemoApp();
    await seeded(app);
    const cookie = await demoLogin(app);
    const ws = (await demoRow()).workspace_id;
    const sub = () => withPg(adminDbUrl(), async (c) => (await c.query('SELECT plan, status FROM public.subscriptions WHERE workspace_id = $1', [ws])).rows[0] ?? null);
    const before = await sub();

    const plan = await post(app, '/billing/plan', cookie, { plan: 'team' });
    assert.equal(plan.status, 403);
    assert.equal((await post(app, '/billing/cancel', cookie)).status, 403);
    assert.equal((await post(app, '/billing/resume', cookie)).status, 403);
    assert.deepEqual(await sub(), before, 'subscription unchanged');
    const still = await fetch(`${app.baseUrl}/today`, { headers: { cookie }, redirect: 'manual' });
    assert.equal(still.status, 200, 'the demo is not locked');
  });

  it('sb-demo: notification addresses cannot be changed in the example company', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startDemoApp();
    await seeded(app);
    const cookie = await demoLogin(app);
    const ws = (await demoRow()).workspace_id;
    const addr = () =>
      withPg(adminDbUrl(), async (c) =>
        (await c.query("SELECT key, value FROM public.settings WHERE workspace_id = $1 AND key IN ('notify_webhook_url', 'notify_emails') AND value <> '' ORDER BY key", [ws])).rows,
      );
    assert.deepEqual(await addr(), []);
    const fields = { keywords: '조경, 수목', regions: '경기', excludeKeywords: '철거', budgetMin: '0', budgetMax: '500000000' };

    const hook = await post(app, '/settings', cookie, { ...fields, webhookUrl: 'https://example.com/hook', notifyEmails: '' });
    assert.equal(hook.status, 403);
    const mail = await post(app, '/settings', cookie, { ...fields, webhookUrl: '', notifyEmails: 'someone@example.com' });
    assert.equal(mail.status, 403);
    assert.deepEqual(await addr(), [], 'no address stored');

    // 조건만 바꾸면 그대로 저장된다
    const ok = await post(app, '/settings', cookie, { ...fields, webhookUrl: '', notifyEmails: '' });
    assert.equal(ok.status, 303);
  });

  it('sb-demo: demo is off by default (no button, routes answer 404)', { skip: skipIfDown, timeout: 120000 }, async () => {
    const app = await startSbApp({ env: { APP_WORKER: '0' } });
    cleanups.push(() => app.stop());
    const landing = await (await fetch(`${app.baseUrl}/`)).text();
    assert.ok(!landing.includes(DEMO_TEXT.button), 'no demo button');
    const login = await post(app, '/demo/login', '');
    assert.equal(login.status, 404);
    const rst = await fetch(`${app.baseUrl}/api/jobs/demo-reset`, { headers: { 'x-job-token': JOB_TOKEN } });
    assert.equal(rst.status, 404);
  });

  it('sb-demo: /status shows example figures without ids or addresses', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startDemoApp();
    await seeded(app);
    const ws = (await demoRow()).workspace_id;
    const ctx = await newContext({ viewport: { width: 1000, height: 700 } });
    const page = await ctx.newPage();
    const res = await page.goto(`${app.baseUrl}/status`);
    assert.equal(res.status(), 200);
    const text = await page.locator('body').innerText();
    for (const t of ['서비스 현황', '오늘 수집한 공고', '마지막 수집 시각', '오늘 보낸 알림']) assert.ok(text.includes(t), `missing ${t}`);
    assert.ok(text.includes('예시 수치'), 'example figures label');
    await shot(page, 'status');

    const j = await (await fetch(`${app.baseUrl}/status.json`)).json();
    assert.equal(j.example, true);
    assert.ok(j.bids >= 1, `bids ${j.bids}`);
    const raw = JSON.stringify(j) + text;
    assert.ok(!raw.includes(ws), 'no workspace id');
    assert.ok(!raw.includes('@'), 'no email address');
  });

  it('sb-demo: /admin shows 7 tiles to an allowed email and 404 to everyone else', { skip: skipIfDown, timeout: 240000 }, async () => {
    const app = await startDemoApp();
    await seeded(app);
    const cookie = await demoLogin(app);
    const ctx = await newContext({ viewport: { width: 1100, height: 800 } });
    await ctx.addCookies(toPlaywrightCookies(app.baseUrl, cookie));
    const page = await ctx.newPage();
    const res = await page.goto(`${app.baseUrl}/admin`);
    assert.equal(res.status(), 200);
    await page.getByRole('heading', { name: '운영 현황' }).waitFor();
    assert.equal(await page.locator('dl.tiles dt').count(), 7);
    const labels = await page.locator('dl.tiles dt').allInnerTexts();
    for (const t of ['회사 수', '구독', '월 반복 매출', '최근 30일 결제 실패', '오늘 작업', '대기열', '데모 초기화']) assert.ok(labels.includes(t), `tile ${t} in ${labels}`);
    await shot(page, 'admin');
    const json = await fetch(`${app.baseUrl}/admin.json`, { headers: { cookie } });
    assert.equal(json.status, 200);

    // 로그인 없이: 로그인 화면으로
    const anon = await fetch(`${app.baseUrl}/admin`, { redirect: 'manual' });
    assert.equal(anon.status, 302);
    // 허용 목록에 없는 사용자: 없는 페이지
    const other = await signupAndVerify(app.baseUrl, { email: randomEmail('adm'), password: PASSWORD, name: '일반' });
    const denied = await fetch(`${app.baseUrl}/admin`, { headers: { cookie: other.cookie }, redirect: 'manual' });
    assert.equal(denied.status, 404);
    const deniedJson = await fetch(`${app.baseUrl}/admin.json`, { headers: { cookie: other.cookie }, redirect: 'manual' });
    assert.equal(deniedJson.status, 404);
  });

  it('sb-demo: mail preview shows 3 sections and sends no mail', { skip: skipIfDown, timeout: 180000 }, async () => {
    const mailApi = await startMockMailApi();
    cleanups.push(() => mailApi.close());
    const app = await startDemoApp({ EMAIL_API_KEY: 'mock-key', EMAIL_API_BASE: mailApi.baseUrl, EMAIL_FROM: 'noreply@example.com' });
    await seeded(app);
    const cookie = await demoLogin(app);
    const ctx = await newContext({ viewport: { width: 1100, height: 1400 } });
    await ctx.addCookies(toPlaywrightCookies(app.baseUrl, cookie));
    const page = await ctx.newPage();
    await page.goto(`${app.baseUrl}/settings/mail-preview`);
    await page.getByRole('heading', { name: '오늘 보낼 메일 미리보기' }).first().waitFor();
    assert.equal(await page.locator('section.mail-preview').count(), 3);
    const kinds = await page.locator('section.mail-preview').evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')));
    assert.deepEqual(kinds, ['bids', 'reminder', 'support']);
    await shot(page, 'mail-preview');
    assert.equal(mailApi.requests.length, 0, 'preview never calls the mail API');
  });
});
