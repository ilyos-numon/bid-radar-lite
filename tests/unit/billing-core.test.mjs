import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../app/core/db.mjs';
import { PLANS, PAID_PLANS, LIMIT_KINDS, PERIOD_DAYS, planOf } from '../../app/core/billing/plans.mjs';
import { createBillingStore } from '../../app/core/billing/store.mjs';
import { createToss, makeOrderId } from '../../app/core/billing/toss.mjs';
import { createBillingCycle } from '../../app/core/billing/cycle.mjs';
import { accessOf, isAllowedWhenLocked, LOCKED_ALLOW } from '../../app/core/billing/access.mjs';
import { startMockToss } from './helpers/mock-toss.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(path.join(ROOT, 'app/core/billing/schema.sql'), 'utf8');
const MIGRATION = readFileSync(path.join(ROOT, 'supabase/migrations/20261104000000_billing.sql'), 'utf8');
const DAY = 86400000;
const SECRET = 'test_sk_unit_secret';
const T0 = new Date('2026-11-04T00:00:00.000Z');

describe('billing: migration', () => {
  test('migration contains app/core/billing/schema.sql verbatim (no drift)', () => {
    assert.ok(MIGRATION.includes(SCHEMA.trim()), 'migration must include schema.sql body');
    assert.equal((MIGRATION.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length, 4);
  });

  test('migration: platform grants, workspace FK and service_role-only Vault RPCs', () => {
    assert.match(MIGRATION, /subscriptions_ws_fk[\s\S]*references public\.workspaces\(id\) on delete cascade/);
    assert.match(MIGRATION, /payments_ws_fk[\s\S]*references public\.workspaces\(id\) on delete cascade/);
    assert.match(MIGRATION, /revoke all on public\.subscriptions, public\.payments, public\.billing_events, public\.billing_jobs from public, anon, authenticated/);
    assert.match(MIGRATION, /grant select, insert, update, delete on public\.subscriptions, public\.payments, public\.billing_events, public\.billing_jobs to app_worker/);
    for (const fn of ['billing_set_key(uuid, text)', 'billing_get_key(uuid)', 'billing_delete_key(uuid)']) {
      assert.ok(MIGRATION.includes(`revoke all on function public.${fn} from public, anon, authenticated`), fn);
      assert.ok(MIGRATION.includes(`grant execute on function public.${fn} to service_role`), fn);
    }
    const defs = MIGRATION.split('create or replace function public.billing_').slice(1);
    assert.equal(defs.length, 3);
    for (const d of defs) assert.match(d, /security definer\s+set search_path = ''/);
  });
});

describe('billing: plans and access', () => {
  test('plans: prices, limits and planOf', () => {
    assert.deepEqual(PAID_PLANS, ['starter', 'team']);
    assert.deepEqual(LIMIT_KINDS, ['members', 'sources', 'keywords', 'emails']);
    assert.equal(PERIOD_DAYS, 30);
    assert.equal(PLANS.starter.price, 29000);
    assert.equal(PLANS.team.limits.members, 10);
    assert.equal(planOf('trial').limits.sources, 2);
    assert.equal(planOf('nope'), null);
    assert.equal(planOf('toString'), null);
  });

  test('access: active states, lock reasons, trial days left, allowed paths', () => {
    assert.deepEqual(accessOf(null, T0), { active: true, reason: null, plan: 'trial', trialDaysLeft: null });
    const trial = { plan: 'trial', status: 'trialing', retryCount: 0, trialEndsAt: new Date(T0.getTime() + 13.5 * DAY).toISOString() };
    assert.deepEqual(accessOf(trial, T0), { active: true, reason: null, plan: 'trial', trialDaysLeft: 14 });
    assert.equal(accessOf({ ...trial, status: 'past_due', retryCount: 1 }, T0).active, true);
    assert.deepEqual(accessOf({ ...trial, status: 'expired' }, T0), { active: false, reason: 'trial_expired', plan: 'trial', trialDaysLeft: null });
    assert.equal(accessOf({ ...trial, plan: 'starter', status: 'expired', retryCount: 3 }, T0).reason, 'past_due_expired');
    assert.equal(accessOf({ ...trial, status: 'canceled' }, T0).reason, 'canceled');
    assert.ok(LOCKED_ALLOW.includes('/billing'));
    for (const p of ['/billing', '/billing/card/success', '/api/billing/x', '/terms', '/healthz']) assert.equal(isAllowedWhenLocked(p), true, p);
    for (const p of ['/today', '/billingx', '/', '/api/jobs/daily']) assert.equal(isAllowedWhenLocked(p), false, p);
  });
});

describe('billing: store, toss, cycle', () => {
  let db;
  let mock;
  let clock;
  let keys;
  const now = () => new Date(clock);
  const env = () => ({ TOSS_SECRET_KEY: SECRET, TOSS_CLIENT_KEY: 'test_ck_unit', TOSS_API_BASE: mock.base });
  const vault = { getKey: async (ws) => keys.get(ws) ?? null, setKey: async (ws, k) => void keys.set(ws, k), deleteKey: async (ws) => void keys.delete(ws) };
  const charges = () => mock.requests.filter((r) => r.method === 'POST' && r.path.startsWith('/v1/billing/') && !r.path.endsWith('/issue'));

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
    clock = T0.getTime();
    keys = new Map();
    mock.requests.length = 0;
    mock.failAmount = 13;
    for (const t of ['subscriptions', 'payments', 'billing_events', 'billing_jobs']) await db.admin(`DELETE FROM ${t}`);
  });

  const setup = () => {
    const store = createBillingStore({ db, now, trialDays: 14 });
    const toss = createToss({ env: env(), fetch: globalThis.fetch });
    const cycle = createBillingCycle({ store, toss, vault, now, retryDays: [1, 3, 7] });
    return { store, toss, cycle };
  };

  test('store.ensure is idempotent and starts a 14-day trial', async () => {
    const { store } = setup();
    const ws = randomUUID();
    const a = await store.ensure(ws);
    clock += DAY;
    const b = await store.ensure(ws);
    assert.equal(a.customerKey, b.customerKey);
    assert.equal(b.plan, 'trial');
    assert.equal(b.status, 'trialing');
    assert.equal(b.trialEndsAt, new Date(T0.getTime() + 14 * DAY).toISOString());
    assert.equal(b.cancelAtPeriodEnd, false);
    assert.equal(b.retryCount, 0);
    assert.equal(await store.get(randomUUID()), null);
  });

  test('store.update only touches allowed columns; activeWorkspaceIds excludes expired/canceled', async () => {
    const { store } = setup();
    const [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    for (const ws of [a, b, c]) await store.ensure(ws);
    const before = await store.get(a);
    const u = await store.update(a, { plan: 'team', cancelAtPeriodEnd: true, customerKey: 'evil', workspace_id: d });
    assert.equal(u.plan, 'team');
    assert.equal(u.cancelAtPeriodEnd, true);
    assert.equal(u.customerKey, before.customerKey);
    assert.equal(u.workspaceId, a);
    await store.update(b, { status: 'expired' });
    await store.update(c, { status: 'canceled' });
    assert.deepEqual(await store.activeWorkspaceIds([a, b, c, d]), [a, d]);
    assert.deepEqual(await store.activeWorkspaceIds([]), []);
  });

  test('toss.issueBillingKey: Basic auth, Idempotency-Key, card summary; bad authKey fails', async () => {
    const { toss } = setup();
    assert.equal(toss.enabled, true);
    assert.equal(toss.clientKey, 'test_ck_unit');
    const r = await toss.issueBillingKey({ authKey: 'auth_ok', customerKey: 'cust_1' });
    assert.deepEqual(r, { ok: true, billingKey: 'bk_mock_1', cardSummary: '신한 ****1234' });
    const req = mock.requests[0];
    assert.equal(req.path, '/v1/billing/authorizations/issue');
    assert.equal(req.headers.authorization, `Basic ${Buffer.from(`${SECRET}:`).toString('base64')}`);
    assert.ok(req.headers['idempotency-key']);
    assert.deepEqual(req.body, { authKey: 'auth_ok', customerKey: 'cust_1' });
    const bad = await toss.issueBillingKey({ authKey: 'bad_x', customerKey: 'cust_1' });
    assert.deepEqual(bad, { ok: false, code: 'INVALID_AUTH_KEY', status: 400 });
    assert.ok(!JSON.stringify(bad).includes(SECRET));
  });

  test('toss.charge sends orderId as Idempotency-Key; disabled toss makes no request', async () => {
    const { toss } = setup();
    const ws = randomUUID();
    const orderId = makeOrderId(ws, 'starter', T0);
    assert.match(orderId, new RegExp(`^br_${ws.replace(/-/g, '').slice(0, 8)}_starter_20261104_[a-z0-9]{6}$`));
    assert.ok(orderId.length >= 6 && orderId.length <= 64);
    const r = await toss.charge({ billingKey: 'bk_1', customerKey: 'cust', amount: 29000, orderId, orderName: '입찰 레이더 스타터' });
    assert.equal(r.ok, true);
    assert.match(r.paymentKey, /^pk_mock_/);
    assert.equal(mock.requests[0].path, '/v1/billing/bk_1');
    assert.equal(mock.requests[0].headers['idempotency-key'], orderId);
    const fail = await toss.charge({ billingKey: 'bk_1', customerKey: 'cust', amount: 13, orderId: `${orderId}x`, orderName: 'x' });
    assert.deepEqual(fail, { ok: false, code: 'REJECT_CARD', status: 400 });
    const off = createToss({ env: { TOSS_API_BASE: mock.base }, fetch: globalThis.fetch });
    assert.equal(off.enabled, false);
    const n = mock.requests.length;
    assert.equal((await off.charge({ billingKey: 'b', customerKey: 'c', amount: 1, orderId: 'order_1', orderName: 'x' })).code, 'NOT_CONFIGURED');
    assert.equal(mock.requests.length, n);
  });

  test('cycle: trial ends with a card → charged as starter, 30-day period, payment paid', async () => {
    const { store, cycle } = setup();
    const ws = randomUUID();
    await store.ensure(ws);
    keys.set(ws, 'bk_trial');
    clock = T0.getTime() + 13 * DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'skipped');
    clock = T0.getTime() + 14 * DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'paid');
    const sub = await store.get(ws);
    assert.equal(sub.plan, 'starter');
    assert.equal(sub.status, 'active');
    assert.equal(sub.currentPeriodEnd, new Date(clock + PERIOD_DAYS * DAY).toISOString());
    assert.equal(sub.nextChargeAt, sub.currentPeriodEnd);
    const [p] = await store.listPayments(ws);
    assert.equal(p.status, 'paid');
    assert.equal(p.amount, 29000);
    assert.equal(p.plan, 'starter');
    assert.match(p.paymentKey, /^pk_mock_/);
    assert.equal(charges()[0].body.customerKey, sub.customerKey);
  });

  test('cycle: trial ends without a card → expired, no charge', async () => {
    const { store, cycle } = setup();
    const ws = randomUUID();
    await store.ensure(ws);
    clock = T0.getTime() + 15 * DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'expired');
    const sub = await store.get(ws);
    assert.equal(sub.status, 'expired');
    assert.equal(accessOf(sub, now()).reason, 'trial_expired');
    assert.equal(charges().length, 0);
  });

  test('cycle: failed charge retries after 1, 3, 7 days, then dead → expired', async () => {
    const { store, cycle } = setup();
    const ws = randomUUID();
    await store.ensure(ws);
    await store.update(ws, { plan: 'team' });
    keys.set(ws, 'bk_fail');
    mock.failAmount = PLANS.team.price;
    clock = T0.getTime() + 14 * DAY;
    const expectWaits = [1, 3, 7];
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await cycle.chargeOne(await store.get(ws)), 'failed');
      const sub = await store.get(ws);
      assert.equal(sub.status, 'past_due');
      assert.equal(sub.retryCount, i + 1);
      assert.equal(sub.nextChargeAt, new Date(clock + expectWaits[i] * DAY).toISOString());
      clock += expectWaits[i] * DAY - 1000;
      assert.equal(await cycle.chargeOne(await store.get(ws)), 'skipped', 'not due before the retry date');
      clock += 1000;
    }
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'expired');
    const dead = await store.get(ws);
    assert.equal(dead.status, 'expired');
    assert.equal(accessOf(dead, now()).reason, 'past_due_expired');
    assert.equal(charges().length, 3);
    const pays = await store.listPayments(ws);
    assert.equal(pays.length, 3);
    assert.ok(pays.every((p) => p.status === 'failed' && p.failCode === 'REJECT_CARD' && p.plan === 'team'));
  });

  test('cycle: retry succeeds → active, retry_count reset', async () => {
    const { store, cycle } = setup();
    const ws = randomUUID();
    await store.ensure(ws);
    keys.set(ws, 'bk_retry');
    mock.failAmount = PLANS.starter.price;
    clock = T0.getTime() + 14 * DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'failed');
    mock.failAmount = 13;
    clock += DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'paid');
    const sub = await store.get(ws);
    assert.equal(sub.status, 'active');
    assert.equal(sub.retryCount, 0);
    assert.equal(sub.currentPeriodEnd, new Date(clock + 30 * DAY).toISOString());
  });

  test('cycle: cancel_at_period_end → canceled at period end without charging', async () => {
    const { store, cycle } = setup();
    const ws = randomUUID();
    await store.ensure(ws);
    const end = new Date(T0.getTime() + 10 * DAY).toISOString();
    await store.update(ws, { plan: 'starter', status: 'active', currentPeriodEnd: end, nextChargeAt: end, cancelAtPeriodEnd: true });
    keys.set(ws, 'bk_cancel');
    clock = T0.getTime() + 5 * DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'skipped');
    clock = T0.getTime() + 10 * DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'canceled');
    const sub = await store.get(ws);
    assert.equal(sub.status, 'canceled');
    assert.equal(accessOf(sub, now()).active, false);
    assert.equal(charges().length, 0);
  });

  test('cycle.run: only due subscriptions, once per date (second run skipped)', async () => {
    const { store, cycle } = setup();
    const [paid, noCard, later] = [randomUUID(), randomUUID(), randomUUID()];
    for (const ws of [paid, noCard, later]) await store.ensure(ws);
    keys.set(paid, 'bk_run');
    const far = new Date(T0.getTime() + 30 * DAY).toISOString();
    await store.update(later, { trialEndsAt: far });
    clock = T0.getTime() + 14 * DAY;
    assert.deepEqual((await store.due(now().toISOString())).map((s) => s.workspaceId).sort(), [paid, noCard].sort());
    const r = await cycle.run({ date: '2026-11-18' });
    assert.deepEqual(r, { charged: 1, failed: 0, expired: 1, skipped: false });
    const again = await cycle.run({ date: '2026-11-18' });
    assert.deepEqual(again, { charged: 1, failed: 0, expired: 1, skipped: true });
    assert.equal(charges().length, 1);
    assert.equal((await store.get(later)).status, 'trialing');
  });

  test('webhook idempotent: same event_key recorded once, then marked processed', async () => {
    const { store } = setup();
    const ev = { eventKey: 'pk_1:DONE:2026-11-04T00:00:00', eventType: 'PAYMENT_STATUS_CHANGED', payload: { data: { paymentKey: 'pk_1' } } };
    const first = await store.recordEvent(ev);
    const second = await store.recordEvent(ev);
    assert.equal(first.inserted, true);
    assert.deepEqual(second, { inserted: false, id: first.id });
    await store.markEvent(first.id, 'paid');
    const row = (await db.admin('SELECT result, processed_at, payload FROM billing_events WHERE id = $1', [first.id])).rows[0];
    assert.equal(row.result, 'paid');
    assert.ok(row.processed_at);
    assert.equal(row.payload.data.paymentKey, 'pk_1');
    assert.equal(Number((await db.admin('SELECT count(*) AS n FROM billing_events')).rows[0].n), 1);
  });

  test('webhook verified by GET: payment status comes from the provider, not the body', async () => {
    const { toss } = setup();
    const c = await toss.charge({ billingKey: 'bk_v', customerKey: 'cust', amount: 29000, orderId: 'br_verify_starter_1', orderName: 'x' });
    const ok = await toss.getPayment(c.paymentKey);
    assert.equal(ok.ok, true);
    assert.equal(ok.status, 'DONE');
    assert.equal(ok.orderId, 'br_verify_starter_1');
    assert.equal(ok.totalAmount, 29000);
    mock.payments.get(c.paymentKey).status = 'CANCELED';
    assert.equal((await toss.getPayment(c.paymentKey)).status, 'CANCELED');
    const last = mock.requests.at(-1);
    assert.equal(last.method, 'GET');
    assert.equal(last.path, `/v1/payments/${c.paymentKey}`);
    assert.deepEqual(await toss.getPayment('pk_forged'), { ok: false, code: 'NOT_FOUND_PAYMENT', status: 404 });
  });

  // 결제는 됐는데 기록 전에 죽는 경우: 같은 청구 대상은 같은 Idempotency-Key 로 다시 보내 토스가 같은 결과를 돌려주게 한다
  const crashOnce = (store, method) => {
    let armed = true;
    return {
      ...store,
      [method]: async (...args) => {
        if (armed) {
          armed = false;
          throw new Error(`crash in ${method}`);
        }
        return store[method](...args);
      },
    };
  };

  test('makeOrderId with a seed is deterministic and keeps the toss orderId format', () => {
    const ws = randomUUID();
    const a = makeOrderId(ws, 'starter', T0, 'x:0');
    assert.equal(a, makeOrderId(ws, 'starter', T0, 'x:0'));
    assert.notEqual(a, makeOrderId(ws, 'starter', T0, 'x:1'));
    assert.notEqual(a, makeOrderId(randomUUID(), 'starter', T0, 'x:0'));
    assert.match(a, new RegExp(`^br_${ws.replace(/-/g, '').slice(0, 8)}_starter_20261104_[a-z0-9]{6}$`));
    assert.ok(/^[A-Za-z0-9_-]{6,64}$/.test(a));
  });

  test('cycle: charge succeeds but recording crashes → rerun reuses Idempotency-Key, charged once', async () => {
    const { store, toss } = setup();
    const ws = randomUUID();
    await store.ensure(ws);
    keys.set(ws, 'bk_crash');
    clock = T0.getTime() + 14 * DAY;
    const crashing = createBillingCycle({ store: crashOnce(store, 'insertPayment'), toss, vault, now });
    await assert.rejects(crashing.chargeOne(await store.get(ws)), /crash/);
    assert.equal((await store.get(ws)).status, 'trialing', 'nothing recorded yet');
    clock += 3600000; // 한 시간 뒤 재실행해도 같은 청구 대상
    const cycle = createBillingCycle({ store, toss, vault, now });
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'paid');
    const sent = charges();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].headers['idempotency-key'], sent[1].headers['idempotency-key'], 'same key for the same billing target');
    const pays = await store.listPayments(ws);
    assert.equal(pays.length, 1);
    assert.equal(pays[0].status, 'paid');
    assert.equal(pays[0].orderId, sent[0].headers['idempotency-key']);
    assert.equal(new Set([...mock.payments.values()].filter((p) => p.orderId === pays[0].orderId).map((p) => p.paymentKey)).size, 1, 'toss charged once');
    assert.equal((await store.get(ws)).status, 'active');
  });

  test('cycle: payment recorded but subscription update crashes → job rerun does not charge again', async () => {
    const { store, toss } = setup();
    const ws = randomUUID();
    await store.ensure(ws);
    keys.set(ws, 'bk_crash2');
    const end = new Date(T0.getTime() + 2 * DAY).toISOString();
    await store.update(ws, { plan: 'starter', status: 'active', currentPeriodEnd: end, nextChargeAt: end });
    clock = T0.getTime() + 2 * DAY;
    const crashing = createBillingCycle({ store: crashOnce(store, 'update'), toss, vault, now });
    const first = await crashing.run({ date: '2026-11-06' });
    assert.deepEqual(first, { charged: 0, failed: 1, expired: 0, skipped: false });
    // 잡이 끝나지 못한 것처럼 finished_at 을 지우고 같은 날짜로 다시 돈다(인계)
    await db.admin("UPDATE billing_jobs SET finished_at = NULL WHERE run_date = '2026-11-06'");
    const cycle = createBillingCycle({ store, toss, vault, now });
    const again = await cycle.run({ date: '2026-11-06' });
    assert.equal(again.charged, 1);
    assert.ok(charges().length <= 2);
    assert.equal(new Set(charges().map((r) => r.headers['idempotency-key'])).size, 1);
    const pays = await store.listPayments(ws);
    assert.equal(pays.length, 1, 'one payment for the period');
    assert.equal(pays[0].status, 'paid');
    const sub = await store.get(ws);
    assert.equal(sub.status, 'active');
    assert.equal(sub.currentPeriodEnd, new Date(clock + PERIOD_DAYS * DAY).toISOString());
    // 기간이 갱신된 뒤에는 대상이 아니다
    assert.equal(await cycle.chargeOne(sub), 'skipped');
  });

  test('cycle: each retry of a failed charge uses a new Idempotency-Key; next period uses another', async () => {
    const { store, cycle } = setup();
    const ws = randomUUID();
    await store.ensure(ws);
    keys.set(ws, 'bk_keys');
    mock.failAmount = PLANS.starter.price;
    clock = T0.getTime() + 14 * DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'failed');
    clock += DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'failed');
    mock.failAmount = 13;
    clock += 3 * DAY;
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'paid');
    clock = new Date((await store.get(ws)).currentPeriodEnd).getTime();
    assert.equal(await cycle.chargeOne(await store.get(ws)), 'paid');
    const ids = charges().map((r) => r.headers['idempotency-key']);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4, 'every attempt has its own key');
    for (const id of ids) assert.ok(/^[A-Za-z0-9_-]{6,64}$/.test(id), id);
    const pays = await store.listPayments(ws);
    assert.deepEqual(pays.map((p) => p.status).sort(), ['failed', 'failed', 'paid', 'paid']);
  });

  test('store.insertPayment is idempotent on order_id', async () => {
    const { store } = setup();
    const ws = randomUUID();
    const row = { workspaceId: ws, orderId: `br_dup_${ws.slice(0, 8)}`, plan: 'starter', amount: 29000, status: 'paid', paymentKey: 'pk_dup' };
    const a = await store.insertPayment(row);
    const b = await store.insertPayment(row);
    assert.equal(a.id, b.id);
    assert.equal((await store.listPayments(ws)).length, 1);
  });
});
