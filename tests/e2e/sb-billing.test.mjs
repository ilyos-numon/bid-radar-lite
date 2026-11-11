import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { chromium } from 'playwright';
import { shot } from './helpers/app.mjs';
import { startMockToss } from './helpers/mock-commerce.mjs';
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

// Supabase 모드 요금제: 체험 시작, 카드 등록과 정기 결제, 결제 실패와 잠금, 웹훅 멱등, 구성원 한도
const PASSWORD = 'e2e-password-1';
const JOB_TOKEN = 'e2e-job';
const DAY_MS = 86400000;

let browser;
const cleanups = [];

async function newContext(opts = {}) {
  const context = await browser.newContext(opts);
  cleanups.push(() => context.close());
  return context;
}

/** 결제 잡은 날짜마다 한 번만 돈다(공유 DB 에 남는다). 실행마다 겹치지 않는 먼 미래 날짜를 쓴다 */
const uniqueJobDate = () => `${randomInt(3000, 9000)}-${String(randomInt(1, 13)).padStart(2, '0')}-${String(randomInt(1, 29)).padStart(2, '0')}`;

async function startBillingApp(toss, env = {}) {
  const app = await startSbApp({
    env: {
      TOSS_API_BASE: toss.baseUrl,
      TOSS_CLIENT_KEY: 'test_ck_mock',
      TOSS_SECRET_KEY: 'test_sk_mock',
      BUSINESS_NAME: '예시 상사',
      APP_WORKER: '0',
      ...env,
    },
  });
  cleanups.push(() => app.stop());
  return app;
}

async function newCompany(app, tag) {
  const first = await signupAndVerify(app.baseUrl, { email: randomEmail(tag), password: PASSWORD, name: `${tag}대표` });
  const made = await createWorkspace(app.baseUrl, first.cookie, { company: `${tag} 조경`, name: `${tag}대표` });
  return { cookie: made.cookie, workspaceId: made.workspaceId };
}

const call = (app, method, pathname, cookie, fields) => {
  const init = withOrigin(app.baseUrl, { method, headers: { cookie }, redirect: 'manual' });
  if (fields) init.body = new URLSearchParams(fields);
  return fetch(`${app.baseUrl}${pathname}`, init);
};

const sub = (workspaceId) =>
  withPg(adminDbUrl(), async (c) => (await c.query('SELECT * FROM public.subscriptions WHERE workspace_id = $1', [workspaceId])).rows[0]);

const payments = (workspaceId) =>
  withPg(adminDbUrl(), async (c) => (await c.query('SELECT * FROM public.payments WHERE workspace_id = $1 ORDER BY id', [workspaceId])).rows);

const sql = (text, params) => withPg(adminDbUrl(), (c) => c.query(text, params));

const chargeRequests = (toss) => toss.received.filter((r) => r.method === 'POST' && /^\/v1\/billing\/(?!authorizations)/.test(r.path));

/** 체험 구독 만들기 + 카드 등록(콜백) */
async function registerCard(app, toss, company) {
  await call(app, 'GET', '/billing', company.cookie);
  const s = await sub(company.workspaceId);
  const res = await call(app, 'GET', `/billing/card/success?customerKey=${encodeURIComponent(s.customer_key)}&authKey=ok_1`, company.cookie);
  assert.equal(res.status, 303, `card success status ${res.status}`);
  assert.match(res.headers.get('location') ?? '', /^\/billing\?card=1/);
  return s;
}

describe('sb billing', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('sb-billing: trial starts on first visit and plan page shows 14 days', { skip: skipIfDown, timeout: 180000 }, async () => {
    const toss = await startMockToss();
    cleanups.push(() => toss.close());
    const app = await startBillingApp(toss);
    const company = await newCompany(app, 'bltr');
    const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(toPlaywrightCookies(app.baseUrl, company.cookie));
    const page = await ctx.newPage();
    await page.goto(`${app.baseUrl}/billing`);
    const text = await page.locator('main').innerText();
    assert.match(text, /체험/);
    assert.match(text, /1[34]일/);
    await shot(page, 'billing-trial');

    const s = await sub(company.workspaceId);
    assert.equal(s.plan, 'trial');
    assert.equal(s.status, 'trialing');
    const days = (new Date(s.trial_ends_at).getTime() - new Date(s.created_at).getTime()) / DAY_MS;
    assert.ok(days > 13.5 && days < 14.5, `trial lasts about 14 days from creation (${days})`);
    assert.equal(toss.received.length, 0, 'no payment call on a trial visit');
  });

  it('sb-billing: card success callback activates plan and billing job charges after period', { skip: skipIfDown, timeout: 240000 }, async () => {
    const toss = await startMockToss();
    cleanups.push(() => toss.close());
    const app = await startBillingApp(toss);
    const company = await newCompany(app, 'blac');

    // 남의 customerKey 는 거부
    await call(app, 'GET', '/billing', company.cookie);
    const bad = await call(app, 'GET', '/billing/card/success?customerKey=not-mine&authKey=ok_1', company.cookie);
    assert.equal(bad.status, 403);
    assert.equal(toss.received.length, 0, 'toss is not called for a foreign customerKey');

    await registerCard(app, toss, company);
    assert.equal(chargeRequests(toss).length, 0, 'card registration during the trial does not charge');
    const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(toPlaywrightCookies(app.baseUrl, company.cookie));
    const page = await ctx.newPage();
    await page.goto(`${app.baseUrl}/billing?card=1`);
    assert.match(await page.locator('main').innerText(), /\*\*\*\*/, 'card summary is masked');

    // 요금제 선택 -> 카드가 있으니 바로 결제해 active
    const chosen = await call(app, 'POST', '/billing/plan', company.cookie, { plan: 'starter' });
    assert.equal(chosen.status, 303);
    assert.match(chosen.headers.get('location') ?? '', /charge=paid/);
    const afterPlan = await sub(company.workspaceId);
    assert.equal(afterPlan.status, 'active');
    assert.equal(afterPlan.plan, 'starter');
    assert.equal(chargeRequests(toss).length, 1, 'plan choice charged once');
    assert.equal((await payments(company.workspaceId)).length, 1, 'one payment for the first period');
    // active 에서 요금제를 바꿔도 즉시 청구하지 않는다(다음 결제부터)
    const switched = await call(app, 'POST', '/billing/plan', company.cookie, { plan: 'starter' });
    assert.match(switched.headers.get('location') ?? '', /plan=1/);
    assert.equal(chargeRequests(toss).length, 1, 'no charge for a plan change while active');

    // 결제 기간이 끝난 뒤의 잡: 한 번 더 결제
    // 앱 시계는 APP_FAKE_NOW(2026-10-29)에 고정이라 그보다 앞선 날짜로 당긴다
    await sql("UPDATE public.subscriptions SET current_period_end = '2026-10-01T00:00:00Z', next_charge_at = '2026-10-01T00:00:00Z' WHERE workspace_id = $1", [company.workspaceId]);
    const job = await fetch(`${app.baseUrl}/api/jobs/billing?date=${uniqueJobDate()}`, { headers: { 'x-job-token': JOB_TOKEN } });
    assert.equal(job.status, 200);
    const out = await job.json();
    assert.equal(out.charged, 1, JSON.stringify(out));
    assert.equal(out.skipped, false);
    const charges = chargeRequests(toss);
    assert.equal(charges.length, 2, 'the job added exactly one charge');
    for (const r of charges) assert.ok(r.headers['idempotency-key'], 'Idempotency-Key header is sent');
    assert.notEqual(charges[0].headers['idempotency-key'], charges[1].headers['idempotency-key']);
    const rows = await payments(company.workspaceId);
    assert.equal(rows.filter((p) => p.status === 'paid').length, 2);
    assert.equal(rows.length, 2, 'one payment per period (plan choice + the job after the period end)');
    assert.equal(new Set(rows.map((p) => p.order_id)).size, 2);
    assert.equal(rows[0].amount, 29000);

    await page.goto(`${app.baseUrl}/billing`);
    const text = await page.locator('main').innerText();
    assert.match(text, /다음 결제일/);
    assert.match(text, /\*\*\*\*/);
    await shot(page, 'billing-active');

    // 잘못된 요금제와 토큰 없는 잡
    const wrongPlan = await call(app, 'POST', '/billing/plan', company.cookie, { plan: 'trial' });
    assert.equal(wrongPlan.status, 400);
    assert.equal((await fetch(`${app.baseUrl}/api/jobs/billing`)).status, 403);
  });

  it('sb-billing: failed charge goes past_due and expired workspace is locked', { skip: skipIfDown, timeout: 240000 }, async () => {
    const toss = await startMockToss();
    cleanups.push(() => toss.close());
    const app = await startBillingApp(toss);
    const company = await newCompany(app, 'bllk');
    await registerCard(app, toss, company);

    // 결제 실패: 요금제를 고르는 즉시 결제는 체험 상태를 그대로 두고 실패 기록만 남긴다
    await toss.setFail(true);
    const chosen = await call(app, 'POST', '/billing/plan', company.cookie, { plan: 'starter' });
    assert.equal(chosen.status, 303);
    assert.match(chosen.headers.get('location') ?? '', /charge=failed/);
    assert.equal((await sub(company.workspaceId)).status, 'trialing');
    assert.equal((await payments(company.workspaceId)).filter((p) => p.status === 'failed').length, 1);

    // 체험이 끝난 날의 결제 잡이 실패하면 past_due
    await sql("UPDATE public.subscriptions SET trial_ends_at = '2026-10-01T00:00:00Z' WHERE workspace_id = $1", [company.workspaceId]);
    const job = await fetch(`${app.baseUrl}/api/jobs/billing?date=${uniqueJobDate()}`, { headers: { 'x-job-token': JOB_TOKEN } });
    assert.equal(job.status, 200);
    assert.ok((await job.json()).failed >= 1);
    const s = await sub(company.workspaceId);
    assert.equal(s.status, 'past_due');
    assert.equal(s.retry_count, 1);
    assert.equal((await payments(company.workspaceId)).filter((p) => p.status === 'failed').length, 2);

    // 미납 중에는 아직 쓸 수 있다
    assert.equal((await call(app, 'GET', '/today', company.cookie)).status, 200);

    // 멈춘 회사: 화면은 요금제로, 쓰기 요청은 402, 요금제 화면은 열린다
    await sql("UPDATE public.subscriptions SET status = 'expired' WHERE workspace_id = $1", [company.workspaceId]);
    const redirected = await call(app, 'GET', '/today', company.cookie);
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get('location'), '/billing?locked=1');
    assert.equal((await call(app, 'POST', '/settings', company.cookie, { keywords: '조경' })).status, 402);
    const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(toPlaywrightCookies(app.baseUrl, company.cookie));
    const page = await ctx.newPage();
    await page.goto(`${app.baseUrl}/today`);
    await page.waitForURL(/\/billing\?locked=1/);
    const text = await page.locator('main').innerText();
    assert.match(text, /이용이 멈췄습니다/);
    await shot(page, 'billing-locked');

    // 일일 잡은 멈춘 회사를 큐에 넣지 않는다
    const date = '2026-12-21';
    const daily = await fetch(`${app.baseUrl}/api/jobs/daily?all=1&date=${date}`, { headers: { 'x-job-token': JOB_TOKEN } });
    assert.equal(daily.status, 202);
    const runs = await (await fetch(`${app.baseUrl}/api/jobs/daily/runs?date=${date}`, { headers: { 'x-job-token': JOB_TOKEN } })).json();
    assert.ok(!runs.some((r) => r.workspaceId === company.workspaceId), 'locked company is not enqueued');
  });

  it('sb-billing: webhook is idempotent and does not trust body', { skip: skipIfDown, timeout: 240000 }, async () => {
    const toss = await startMockToss();
    cleanups.push(() => toss.close());
    const app = await startBillingApp(toss);
    const company = await newCompany(app, 'blwh');
    await registerCard(app, toss, company);
    await call(app, 'POST', '/billing/plan', company.cookie, { plan: 'starter' });
    const [paid] = await payments(company.workspaceId);
    assert.equal(paid.status, 'paid');
    assert.ok(paid.payment_key);

    // 모의 서버의 결제 키는 실행마다 같아서(pk_mock_N) 이벤트 키가 겹치지 않게 시각을 실행마다 다르게 한다
    const stamp = (day) => `2026-12-${day}T00:00:00.${String(randomInt(0, 1000)).padStart(3, '0')}${String(randomInt(0, 1000)).padStart(3, '0')}Z`;
    const at1 = stamp('01');
    const hook = (createdAt, status) =>
      fetch(`${app.baseUrl}/webhooks/toss`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt, data: { paymentKey: paid.payment_key, orderId: paid.order_id, status } }),
      });
    const first = await hook(at1, 'DONE');
    assert.equal(first.status, 200);
    assert.notEqual((await first.json()).duplicate, true);
    const second = await hook(at1, 'DONE');
    assert.equal(second.status, 200);
    assert.equal((await second.json()).duplicate, true);
    assert.equal((await payments(company.workspaceId))[0].status, 'paid');
    const events = await sql("SELECT count(*)::int AS n FROM public.billing_events WHERE event_key = $1", [`${paid.payment_key}:DONE:${at1}`]);
    assert.equal(events.rows[0].n, 1, 'one event row');

    // 본문은 DONE 이지만 토스 조회는 CANCELED -> 조회 결과를 따른다
    await toss.cancelPayment(paid.payment_key);
    const third = await hook(stamp('02'), 'DONE');
    assert.equal(third.status, 200);
    assert.notEqual((await third.json()).duplicate, true);
    assert.equal((await payments(company.workspaceId))[0].status, 'canceled', 'status comes from the lookup, not the body');
    assert.ok(toss.received.some((r) => r.method === 'GET' && r.path === `/v1/payments/${paid.payment_key}`), 'the app looked the payment up');

    // 모르는 결제 키: 200 으로 받고 아무것도 바꾸지 않는다
    const unknown = await fetch(`${app.baseUrl}/webhooks/toss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: stamp('03'), data: { paymentKey: 'pk_unknown', orderId: 'x', status: 'DONE' } }),
    });
    assert.equal(unknown.status, 200);
    assert.equal((await payments(company.workspaceId))[0].status, 'canceled');
  });

  it('sb-billing: member limit of trial plan is enforced', { skip: skipIfDown, timeout: 240000 }, async () => {
    const toss = await startMockToss();
    cleanups.push(() => toss.close());
    const app = await startBillingApp(toss);
    const company = await newCompany(app, 'blmb');
    const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addCookies(toPlaywrightCookies(app.baseUrl, company.cookie));
    const page = await ctx.newPage();
    await page.goto(`${app.baseUrl}/assign/members`);

    // 대표 1명 + 초대 2명 = 3명까지, 그다음 초대는 막힌다
    for (const name of ['식구하나', '식구둘']) {
      await page.fill('input[name=name]', name);
      await page.getByRole('button', { name: '초대 링크 만들기' }).click();
      await page.getByText('이 링크는 지금만 보입니다').waitFor();
    }
    await page.fill('input[name=name]', '식구셋');
    await page.getByRole('button', { name: '초대 링크 만들기' }).click();
    await page.getByText('무료 체험 요금제에서 3개까지').waitFor();
    assert.equal(await page.getByText('이 링크는 지금만 보입니다').count(), 0, 'no invite link is shown for the refused invite');
  });
});
