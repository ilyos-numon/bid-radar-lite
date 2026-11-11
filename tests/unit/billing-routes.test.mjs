import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { openDb } from '../../app/core/db.mjs';
import { createHtml } from '../../app/core/html.mjs';
import { createBillingStore } from '../../app/core/billing/store.mjs';
import { createToss } from '../../app/core/billing/toss.mjs';
import { createBillingCycle } from '../../app/core/billing/cycle.mjs';
import { registerBillingRoutes } from '../../app/core/billing/routes.mjs';
import manifest from '../../app/modules/billing/manifest.mjs';
import { startMockToss } from './helpers/mock-toss.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BASE = 'http://localhost:8820';
const SECRET = 'test_sk_route_secret';
const CLIENT = 'test_ck_route_client';
const T0 = new Date('2026-11-04T00:00:00.000Z');

let db;
let mock;
before(async () => {
  db = await openDb({ memory: true });
  await db.applySchema(path.join(ROOT, 'app/core/billing/schema.sql'));
  mock = await startMockToss();
});
after(async () => {
  await mock.close();
  await db.close();
});
beforeEach(async () => {
  for (const t of ['subscriptions', 'payments', 'billing_events', 'billing_jobs']) await db.admin(`DELETE FROM ${t}`);
  mock.requests.length = 0;
});

function memVault() {
  const keys = new Map();
  return {
    keys,
    setKey: async (ws, k) => void keys.set(ws, k),
    getKey: async (ws) => keys.get(ws) ?? null,
    deleteKey: async (ws) => void keys.delete(ws),
  };
}

function setup({ tossEnv = { TOSS_SECRET_KEY: SECRET, TOSS_CLIENT_KEY: CLIENT, TOSS_API_BASE: mock.base }, jobToken = 'jt' } = {}) {
  const now = () => T0;
  const store = createBillingStore({ db, now });
  const toss = createToss({ env: tossEnv, fetch: globalThis.fetch });
  const vault = memVault();
  const cycle = createBillingCycle({ store, toss, vault, now });
  return { store, toss, vault, cycle, now, env: { APP_JOB_TOKEN: jobToken, APP_BASE_URL: BASE, ...tossEnv } };
}

describe('billing routes: webhook', () => {
  function app(s) {
    const a = new Hono();
    registerBillingRoutes(a, { env: s.env, billing: { store: s.store, toss: s.toss, cycle: s.cycle, vault: s.vault }, db });
    return a;
  }
  const hook = (a, body) =>
    a.fetch(new Request(`${BASE}/webhooks/toss`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));

  async function paidAtToss(s, ws) {
    const orderId = `br_test_${randomUUID().slice(0, 8)}`;
    const r = await s.toss.charge({ billingKey: 'bk_x', customerKey: 'ck', amount: 29000, orderId, orderName: 'x' });
    assert.equal(r.ok, true);
    await s.store.insertPayment({ workspaceId: ws, orderId, plan: 'starter', amount: 29000, status: 'ready', paymentKey: r.paymentKey });
    return { orderId, paymentKey: r.paymentKey };
  }
  const statusOf = async (orderId) => (await db.admin('SELECT status FROM payments WHERE order_id = $1', [orderId])).rows[0].status;

  test('webhook: body status is ignored, GET result decides; duplicate is idempotent', async () => {
    const s = setup();
    const a = app(s);
    const ws = randomUUID();
    const { orderId, paymentKey } = await paidAtToss(s, ws);
    const body = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-11-04T00:00:01', data: { paymentKey, orderId, status: 'CANCELED' } };
    const r1 = await hook(a, body);
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).result, 'synced:paid');
    assert.equal(await statusOf(orderId), 'paid');
    assert.ok(mock.requests.some((q) => q.method === 'GET' && q.path === `/v1/payments/${paymentKey}`));

    const lookups = mock.requests.filter((q) => q.method === 'GET').length;
    const r2 = await hook(a, body);
    assert.equal(r2.status, 200);
    assert.deepEqual(await r2.json(), { ok: true, duplicate: true });
    assert.equal(mock.requests.filter((q) => q.method === 'GET').length, lookups, 'duplicate must not look up again');
    assert.equal(Number((await db.admin('SELECT count(*) AS n FROM billing_events')).rows[0].n), 1);
    const ev = (await db.admin('SELECT result, processed_at FROM billing_events')).rows[0];
    assert.equal(ev.result, 'synced:paid');
    assert.ok(ev.processed_at);
  });

  test('webhook: canceled at toss → payments canceled even if body says DONE', async () => {
    const s = setup();
    const a = app(s);
    const { orderId, paymentKey } = await paidAtToss(s, randomUUID());
    mock.payments.get(paymentKey).status = 'CANCELED';
    const r = await hook(a, { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: 't2', data: { paymentKey, orderId, status: 'DONE' } });
    assert.equal(r.status, 200);
    assert.equal(await statusOf(orderId), 'canceled');
  });

  test('webhook: unknown payment, bad JSON and missing key all answer 200', async () => {
    const s = setup();
    const a = app(s);
    const r1 = await hook(a, { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: 't', data: { paymentKey: 'pk_none', status: 'DONE' } });
    assert.equal(r1.status, 200);
    assert.equal((await r1.json()).result, 'lookup_failed:NOT_FOUND_PAYMENT');
    assert.equal((await hook(a, '{not json')).status, 200);
    assert.equal((await hook(a, { data: {} })).status, 200);
  });
});

describe('billing routes: /api/jobs/billing', () => {
  function app(s, env = s.env) {
    const a = new Hono();
    registerBillingRoutes(a, { env, billing: { store: s.store, toss: s.toss, cycle: s.cycle, vault: s.vault }, db });
    return a;
  }
  const job = (a, token, q = '') => {
    const h = new Headers();
    if (token !== undefined) h.set('x-job-token', token);
    return a.fetch(new Request(`${BASE}/api/jobs/billing${q}`, { headers: h }));
  };

  test('jobs: no token / wrong token / no configured token → 403', async () => {
    const s = setup();
    assert.equal((await job(app(s))).status, 403);
    assert.equal((await job(app(s), 'nope')).status, 403);
    assert.equal((await job(app(s), 'jtx')).status, 403);
    assert.equal((await job(app(s, { ...s.env, APP_JOB_TOKEN: '' }), '')).status, 403);
    assert.equal(Number((await db.admin('SELECT count(*) AS n FROM billing_jobs')).rows[0].n), 0);
  });

  test('jobs: right token runs the cycle once per date', async () => {
    const s = setup();
    const a = app(s);
    const ws = randomUUID();
    await s.store.ensure(ws);
    await s.store.update(ws, { trialEndsAt: new Date(T0.getTime() - 1000).toISOString() });
    const r1 = await job(a, 'jt', '?date=2026-11-04');
    assert.equal(r1.status, 200);
    assert.deepEqual(await r1.json(), { charged: 0, failed: 0, expired: 1, skipped: false });
    const r2 = await job(a, 'jt', '?date=2026-11-04');
    assert.deepEqual(await r2.json(), { charged: 0, failed: 0, expired: 1, skipped: true });
    assert.equal((await job(a, 'jt', '?date=bad')).status, 400);
  });
});

describe('billing module: screens', () => {
  const OWNER = { id: 1, name: '김대표', role: 'owner' };
  const STAFF = { id: 2, name: '박직원', role: 'staff' };

  function moduleApp(s, ws) {
    const routes = new Map();
    const router = {
      get: (p, h) => void routes.set(`GET ${p}`, h),
      post: (p, h) => void routes.set(`POST ${p}`, h),
    };
    const ctx = {
      now: s.now,
      log: () => {},
      html: createHtml({ menus: () => [] }),
      auth: { required: (h) => (req, params, c, member) => (member ? h(req, params, c, member) : new Response(null, { status: 302, headers: { location: '/welcome' } })) },
      billing: { store: s.store, toss: s.toss, vault: s.vault, workspaceId: ws, env: s.env },
    };
    assert.equal(manifest.when(ctx), true);
    assert.equal(manifest.when({}), false);
    manifest.routes(router, ctx);
    return async (method, url, member, form) => {
      const u = new URL(BASE + url);
      const h = routes.get(`${method} ${u.pathname}`);
      assert.ok(h, `no route ${method} ${u.pathname}`);
      const init = { method };
      if (form) init.body = new URLSearchParams(form);
      return h(new Request(u, init), {}, ctx, member);
    };
  }

  test('screen: owner sees 3 plans, trial days left, buttons enabled', async () => {
    const s = setup();
    const ws = randomUUID();
    const call = moduleApp(s, ws);
    const res = await call('GET', '/billing', OWNER);
    assert.equal(res.status, 200);
    const html = await res.text();
    for (const p of ['trial', 'starter', 'team']) assert.ok(html.includes(`data-plan="${p}"`), p);
    assert.match(html, /무료 체험 14일 남음/);
    assert.match(html, /등록된 카드 없음/);
    assert.match(html, /href="\/billing\/card"/);
    assert.ok(!html.includes('data-owner-only'));
    assert.ok(!html.includes(SECRET));
  });

  test('screen: staff reads only (buttons disabled), ?locked=1 shows lock notice', async () => {
    const s = setup();
    const call = moduleApp(s, randomUUID());
    const html = await (await call('GET', '/billing?locked=1', STAFF)).text();
    assert.ok(html.includes('data-owner-only'));
    assert.ok(html.includes('data-locked'));
    assert.ok(!html.includes('href="/billing/card"'));
    assert.equal((html.match(/ disabled data-busy="바꾸는 중…">이 요금제로<\/button>/g) ?? []).length, 2);
    assert.equal((await call('POST', '/billing/plan', STAFF, { plan: 'team' })).status, 403);
    assert.equal((await call('POST', '/billing/cancel', STAFF)).status, 403);
    assert.equal((await call('GET', '/billing/card', STAFF)).status, 403);
  });

  test('card page: SDK script with client key, customerKey and URLs only; not ready when keys missing', async () => {
    const s = setup();
    const ws = randomUUID();
    const call = moduleApp(s, ws);
    const html = await (await call('GET', '/billing/card', OWNER)).text();
    const sub = await s.store.get(ws);
    assert.ok(html.includes('<script src="https://js.tosspayments.com/v2/standard"></script>'));
    assert.ok(html.includes(CLIENT));
    assert.ok(html.includes(sub.customerKey));
    assert.ok(html.includes(`${BASE}/billing/card/success`));
    assert.ok(html.includes(`${BASE}/billing/card/fail`));
    assert.ok(!html.includes(SECRET));

    const off = setup({ tossEnv: {} });
    const call2 = moduleApp(off, randomUUID());
    const html2 = await (await call2('GET', '/billing/card', OWNER)).text();
    assert.match(html2, /결제 준비 안 됨/);
    assert.match(html2, /id="card-start" disabled/);
    assert.ok(!html2.includes('js.tosspayments.com'));
    const main = await (await call2('GET', '/billing', OWNER)).text();
    assert.match(main, /결제 준비 안 됨/);
    assert.match(main, /id="billing-card-link" disabled/);
  });

  test('card success: staff 403, customerKey mismatch 403, bad authKey 400', async () => {
    const s = setup();
    const ws = randomUUID();
    const call = moduleApp(s, ws);
    const sub = await s.store.ensure(ws);
    assert.equal((await call('GET', `/billing/card/success?customerKey=${sub.customerKey}&authKey=a1`, STAFF)).status, 403);
    assert.equal((await call('GET', `/billing/card/success?customerKey=other&authKey=a1`, OWNER)).status, 403);
    assert.equal((await call('GET', `/billing/card/success?customerKey=${sub.customerKey}&authKey=bad_1`, OWNER)).status, 400);
    assert.equal(s.vault.keys.size, 0);
    assert.equal(mock.requests.filter((q) => q.path === '/v1/billing/authorizations/issue').length, 1);
    assert.equal((await call('GET', '/billing/card/fail?code=PAY_PROCESS_CANCELED&message=<b>x</b>', OWNER)).status, 400);
  });

  test('card success: stores key and card summary; trialing is not charged yet', async () => {
    const s = setup();
    const ws = randomUUID();
    const call = moduleApp(s, ws);
    const sub = await s.store.ensure(ws);
    const res = await call('GET', `/billing/card/success?customerKey=${sub.customerKey}&authKey=a1`, OWNER);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/billing?card=1');
    assert.match(s.vault.keys.get(ws), /^bk_mock_\d+$/);
    const after = await s.store.get(ws);
    assert.equal(after.cardSummary, '신한 ****1234');
    assert.equal(after.status, 'trialing');
    assert.equal((await s.store.listPayments(ws)).length, 0);
  });

  test('card success on expired → charged right away → active', async () => {
    const s = setup();
    const ws = randomUUID();
    const call = moduleApp(s, ws);
    const sub = await s.store.ensure(ws);
    await s.store.update(ws, { status: 'expired', plan: 'team' });
    const res = await call('GET', `/billing/card/success?customerKey=${sub.customerKey}&authKey=a1`, OWNER);
    assert.equal(res.headers.get('location'), '/billing?card=1&charge=paid');
    const after = await s.store.get(ws);
    assert.equal(after.status, 'active');
    assert.equal(after.plan, 'team');
    const pays = await s.store.listPayments(ws);
    assert.equal(pays[0].status, 'paid');
    assert.equal(pays[0].amount, 79000);
  });

  test('plan: no card → saved only; with card while trialing → paid and active; failure keeps trial', async () => {
    const s = setup();
    const ws = randomUUID();
    const call = moduleApp(s, ws);
    const sub = await s.store.ensure(ws);
    let res = await call('POST', '/billing/plan', OWNER, { plan: 'starter' });
    assert.equal(res.headers.get('location'), '/billing?plan=nocard');
    assert.equal((await s.store.get(ws)).plan, 'starter');
    assert.equal((await s.store.get(ws)).status, 'trialing');
    assert.equal((await call('POST', '/billing/plan', OWNER, { plan: 'trial' })).status, 400);

    await call('GET', `/billing/card/success?customerKey=${sub.customerKey}&authKey=a1`, OWNER);
    mock.failAmount = 79000;
    try {
      res = await call('POST', '/billing/plan', OWNER, { plan: 'team' });
      assert.equal(res.headers.get('location'), '/billing?charge=failed');
      const kept = await s.store.get(ws);
      assert.equal(kept.status, 'trialing');
      assert.equal(kept.retryCount, 0);
    } finally {
      mock.failAmount = 13;
    }
    res = await call('POST', '/billing/plan', OWNER, { plan: 'starter' });
    assert.equal(res.headers.get('location'), '/billing?charge=paid');
    const now = await s.store.get(ws);
    assert.equal(now.status, 'active');
    assert.equal(now.plan, 'starter');
    const html = await (await call('GET', '/billing?charge=paid', OWNER)).text();
    assert.match(html, /다음 결제일 2026-12-04/);
    assert.match(html, /결제됨/);
  });

  test('plan change while active → saved for the next charge, no immediate charge', async () => {
    const s = setup();
    const ws = randomUUID();
    const call = moduleApp(s, ws);
    const sub = await s.store.ensure(ws);
    await call('GET', `/billing/card/success?customerKey=${sub.customerKey}&authKey=a1`, OWNER);
    assert.equal((await call('POST', '/billing/plan', OWNER, { plan: 'starter' })).headers.get('location'), '/billing?charge=paid');
    const paid = await s.store.get(ws);
    const n = mock.requests.filter((q) => q.method === 'POST' && !q.path.endsWith('/issue')).length;
    for (const plan of ['team', 'starter']) {
      const res = await call('POST', '/billing/plan', OWNER, { plan });
      assert.equal(res.headers.get('location'), '/billing?plan=1');
    }
    // 카드 다시 등록해도 active 는 청구하지 않는다
    await call('GET', `/billing/card/success?customerKey=${sub.customerKey}&authKey=a2`, OWNER);
    assert.equal(mock.requests.filter((q) => q.method === 'POST' && !q.path.endsWith('/issue')).length, n, 'no new charge');
    const after = await s.store.get(ws);
    assert.equal(after.status, 'active');
    assert.equal(after.currentPeriodEnd, paid.currentPeriodEnd);
    assert.equal((await s.store.listPayments(ws)).filter((p) => p.status === 'paid').length, 1, 'one payment for the period');
  });

  test('plan: repeated immediate charges after a failure use new keys; one paid row', async () => {
    const s = setup();
    const ws = randomUUID();
    const call = moduleApp(s, ws);
    const sub = await s.store.ensure(ws);
    await call('GET', `/billing/card/success?customerKey=${sub.customerKey}&authKey=a1`, OWNER);
    mock.failAmount = 29000;
    try {
      for (let i = 0; i < 2; i += 1) assert.equal((await call('POST', '/billing/plan', OWNER, { plan: 'starter' })).headers.get('location'), '/billing?charge=failed');
    } finally {
      mock.failAmount = 13;
    }
    assert.equal((await call('POST', '/billing/plan', OWNER, { plan: 'starter' })).headers.get('location'), '/billing?charge=paid');
    const ids = mock.requests.filter((q) => q.method === 'POST' && !q.path.endsWith('/issue')).map((q) => q.headers['idempotency-key']);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
    const pays = await s.store.listPayments(ws);
    assert.deepEqual(pays.map((p) => p.status).sort(), ['failed', 'failed', 'paid']);
  });

  test('cancel and resume toggle cancel_at_period_end', async () => {
    const s = setup();
    const ws = randomUUID();
    const call = moduleApp(s, ws);
    await s.store.ensure(ws);
    await s.store.update(ws, { status: 'active', plan: 'starter', currentPeriodEnd: '2026-12-01T00:00:00Z', nextChargeAt: '2026-12-01T00:00:00Z' });
    let res = await call('POST', '/billing/cancel', OWNER);
    assert.equal(res.headers.get('location'), '/billing?canceled=1');
    assert.equal((await s.store.get(ws)).cancelAtPeriodEnd, true);
    assert.match(await (await call('GET', '/billing', OWNER)).text(), /해지 취소/);
    res = await call('POST', '/billing/resume', OWNER);
    assert.equal(res.headers.get('location'), '/billing?resumed=1');
    assert.equal((await s.store.get(ws)).cancelAtPeriodEnd, false);
  });
});
