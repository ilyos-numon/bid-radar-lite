import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../app/core/db.mjs';
import { rateKey } from '../../app/core/rate-store.mjs';
import { BUDGET_KINDS, BUDGET_DEFAULTS, BUDGET_TEXT, createBudget } from '../../app/core/budget.mjs';
import { create as createLlm } from '../../app/core/llm.mjs';
import { create as createNotify } from '../../app/core/notify.mjs';
import { createEmailSender } from '../../app/core/email.mjs';
import { createEmailAlerts } from '../../app/core/email-alerts.mjs';
import { startMockEmail } from './helpers/mock-email.mjs';
import { createTestDb, WS_A } from './helpers/fake-platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// supabase/migrations 의 rate_limits 와 같은 모양
const RATE_TABLE = 'CREATE TABLE IF NOT EXISTS rate_limits (key text primary key, hits integer not null, reset_at timestamptz not null)';
// 2026-11-04 10:00 KST
const NOW = new Date('2026-11-04T01:00:00Z');

describe('budget: daily counters', () => {
  let db;
  before(async () => {
    db = await openDb({ memory: true });
    await db.admin(RATE_TABLE);
  });
  after(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.admin('DELETE FROM rate_limits');
  });

  test('budget: constants match the agreed names and defaults', () => {
    assert.deepEqual(BUDGET_KINDS, { email: 'APP_DAILY_MAX_EMAIL', llm: 'APP_DAILY_MAX_LLM', signup: 'APP_DAILY_MAX_SIGNUP', demoLogin: 'APP_DAILY_MAX_DEMO_LOGIN' });
    assert.deepEqual(BUDGET_DEFAULTS, { email: 200, llm: 200, signup: 50, demoLogin: 500 });
    assert.equal(BUDGET_TEXT.llm, '오늘 자동 요약 한도를 다 썼습니다');
    assert.equal(BUDGET_TEXT.signup, '오늘 가입 접수를 마감했습니다. 내일 다시 시도해 주세요.');
  });

  test('budget: kstDate uses Korea time (UTC 15:00 is the next day)', () => {
    const b = createBudget({ db, now: () => NOW });
    assert.equal(b.kstDate(new Date('2026-11-04T14:59:59Z')), '2026-11-04');
    assert.equal(b.kstDate(new Date('2026-11-04T15:00:00Z')), '2026-11-05');
    assert.equal(b.kstDate(new Date('2026-11-03T15:00:00Z')), '2026-11-04');
  });

  test('budget: APP_DAILY_MAX_LLM=2 → 3rd take not ok; used capped at max', async () => {
    const b = createBudget({ db, env: { APP_DAILY_MAX_LLM: '2' }, now: () => NOW });
    assert.deepEqual(await b.take('llm'), { ok: true, used: 1, max: 2 });
    assert.deepEqual(await b.take('llm'), { ok: true, used: 2, max: 2 });
    assert.deepEqual(await b.take('llm'), { ok: false, used: 2, max: 2 });
    assert.deepEqual(await b.peek('llm'), { used: 2, max: 2 });
    // 다른 종류는 따로 센다
    assert.deepEqual(await b.peek('email'), { used: 0, max: 200 });
  });

  test('budget: 0 means unlimited and nothing is stored', async () => {
    const b = createBudget({ db, env: { APP_DAILY_MAX_LLM: '0' }, now: () => NOW });
    for (let i = 0; i < 300; i += 1) assert.equal((await b.take('llm')).ok, true);
    assert.deepEqual(await b.take('llm'), { ok: true, used: 0, max: 0 });
    assert.deepEqual(await b.peek('llm'), { used: 0, max: 0 });
    assert.equal((await db.admin('SELECT count(*)::integer AS n FROM rate_limits')).rows[0].n, 0);
  });

  test('budget: empty or invalid env falls back to defaults', async () => {
    const b = createBudget({ db, env: { APP_DAILY_MAX_EMAIL: '', APP_DAILY_MAX_SIGNUP: 'abc', APP_DAILY_MAX_DEMO_LOGIN: '-3' }, now: () => NOW });
    assert.equal((await b.peek('email')).max, 200);
    assert.equal((await b.peek('signup')).max, 50);
    assert.equal((await b.peek('demoLogin')).max, 500);
    assert.equal((await b.peek('llm')).max, 200);
    await assert.rejects(() => b.take('nope'), /unknown budget kind/);
  });

  test('budget: take n adds n; over the max is not ok', async () => {
    const b = createBudget({ db, env: { APP_DAILY_MAX_EMAIL: '5' }, now: () => NOW });
    assert.deepEqual(await b.take('email', { n: 3 }), { ok: true, used: 3, max: 5 });
    assert.deepEqual(await b.take('email', { n: 2 }), { ok: true, used: 5, max: 5 });
    assert.deepEqual(await b.take('email', { n: 1 }), { ok: false, used: 5, max: 5 });
  });

  test('budget: stored under hashed key per KST date, window ends at next KST midnight', async () => {
    const b = createBudget({ db, env: { APP_DAILY_MAX_SIGNUP: '1' }, now: () => NOW });
    assert.equal((await b.take('signup')).ok, true);
    const rows = (await db.admin('SELECT key, extract(epoch FROM (reset_at - now()))::double precision AS left_s FROM rate_limits')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, rateKey('budget:signup:2026-11-04'));
    // 10:00 KST → 자정까지 14시간
    assert.ok(Math.abs(Number(rows[0].left_s) - 14 * 3600) < 60, `left ${rows[0].left_s}`);
    assert.equal((await b.take('signup')).ok, false);
    // 다음 날(KST)은 새로 센다
    const tomorrow = createBudget({ db, env: { APP_DAILY_MAX_SIGNUP: '1' }, now: () => new Date('2026-11-04T15:30:00Z') });
    assert.equal((await tomorrow.take('signup')).ok, true);
  });

  test('budget: two instances on one db share the count (two servers)', async () => {
    const env = { APP_DAILY_MAX_DEMO_LOGIN: '2' };
    const a = createBudget({ db, env, now: () => NOW });
    const c = createBudget({ db, env, now: () => NOW });
    assert.equal((await a.take('demoLogin')).ok, true);
    assert.equal((await c.take('demoLogin')).ok, true);
    assert.equal((await a.take('demoLogin')).ok, false);
  });
});

describe('budget: llm hook', () => {
  let db;
  before(async () => {
    db = await openDb({ memory: true });
    await db.admin(RATE_TABLE);
  });
  after(async () => {
    await db.close();
  });

  const input = { task: 't', system: 's', input: {} };

  test('budget: llm with APP_DAILY_MAX_LLM=2 → 3rd call BUDGET before the key check', async () => {
    const budget = createBudget({ db, env: { APP_DAILY_MAX_LLM: '2' }, now: () => NOW });
    let calls = 0;
    const { llm } = createLlm({ env: {}, fetch: async () => (calls += 1), budget });
    assert.equal((await llm.complete(input)).error, 'NO_KEY');
    assert.equal((await llm.complete(input)).error, 'NO_KEY');
    assert.deepEqual(await llm.complete(input), { ok: false, error: 'BUDGET' });
    assert.equal(calls, 0);
  });

  test('budget: llm for a demo workspace → DEMO without network or budget use', async () => {
    let calls = 0;
    let taken = 0;
    const budget = { take: async () => ((taken += 1), { ok: true }) };
    const { llm } = createLlm({
      env: { LLM_API_BASE: 'http://localhost:1', LLM_API_KEY: 'k' },
      fetch: async () => {
        calls += 1;
        throw new Error('should not be called');
      },
      demo: { enabled: true },
      budget,
    });
    assert.deepEqual(await llm.complete(input), { ok: false, error: 'DEMO' });
    assert.equal(calls, 0);
    assert.equal(taken, 0);
  });

  test('budget: llm without demo/budget keeps the old NO_KEY path', async () => {
    const { llm } = createLlm({ env: {}, fetch: async () => assert.fail('no fetch') });
    assert.deepEqual(await llm.complete(input), { ok: false, error: 'NO_KEY' });
  });
});

describe('budget: email alerts hook', () => {
  let db;
  let mock;
  const PAYLOAD = { kind: 'bids', date: '2026-11-04', count: 0, items: [], maybe: null };
  before(async () => {
    db = await createTestDb();
    await db.admin(readFileSync(path.join(ROOT, 'app/core/email/schema.sql'), 'utf8'));
    await db.admin(RATE_TABLE);
    mock = await startMockEmail();
  });
  after(async () => {
    await mock.close();
    await db.close();
  });
  beforeEach(async () => {
    mock.requests.length = 0;
    await db.admin('DELETE FROM notification_deliveries');
    await db.admin('DELETE FROM rate_limits');
  });

  function make(budgetEnv) {
    const env = { APP_SECRET: 'test-secret', EMAIL_API_BASE: mock.url, EMAIL_API_KEY: 're_test', EMAIL_FROM: 'alerts@example.com' };
    const store = new Map([['notify_emails', 'boss@example.com,staff@example.com']]);
    const settings = { get: async (k) => store.get(k) ?? null };
    const { notify } = createNotify({ db, env, now: () => NOW, fetch });
    const sender = createEmailSender({ env, fetch });
    const budget = createBudget({ db, env: budgetEnv, now: () => NOW });
    const alerts = createEmailAlerts({ db, settings, notify, sender, budget, env, workspaceId: WS_A, appUrl: 'https://app.example.com' });
    return { alerts, budget, inWs: (fn) => db.withWorkspace(WS_A, fn) };
  }
  const deliveries = () => db.admin('SELECT kind, status, error_code FROM notification_deliveries');

  test('budget: email over the daily budget → not sent, recorded with error_code budget', async () => {
    const { alerts, inWs } = make({ APP_DAILY_MAX_EMAIL: '1' });
    const r = await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'r1' }));
    assert.deepEqual(r, { sent: false, reason: 'budget' });
    assert.equal(mock.requests.length, 0);
    const rows = (await deliveries()).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'bids:email');
    assert.equal(rows[0].error_code, 'budget');
    assert.notEqual(rows[0].status, 'sent');
  });

  test('budget: email within budget counts one per recipient', async () => {
    const { alerts, budget, inWs } = make({ APP_DAILY_MAX_EMAIL: '3' });
    const r = await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'r1' }));
    assert.equal(r.sent, true);
    assert.equal(r.to, 2);
    assert.equal(mock.requests.length, 2);
    assert.deepEqual(await budget.peek('email'), { used: 2, max: 3 });
    // 이미 보낸 날 다시 불러도 예산을 쓰지 않는다
    const again = await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'r2' }));
    assert.deepEqual(again, { sent: false, reason: 'already_delivered' });
    assert.deepEqual(await budget.peek('email'), { used: 2, max: 3 });
  });

  test('budget: email with APP_DAILY_MAX_EMAIL=0 is unlimited', async () => {
    const { alerts, inWs } = make({ APP_DAILY_MAX_EMAIL: '0' });
    assert.equal((await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'r1' }))).sent, true);
    assert.equal(mock.requests.length, 2);
  });
});
