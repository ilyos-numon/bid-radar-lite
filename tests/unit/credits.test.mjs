import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../app/core/db.mjs';
import { createBillingStore } from '../../app/core/billing/store.mjs';
import { PAID_STATUSES, CREDITS_TEXT, freeCollects, createCredits } from '../../app/core/billing/credits.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(path.join(ROOT, 'app/core/billing/credits.sql'), 'utf8');
const MIGRATION = readFileSync(path.join(ROOT, 'supabase/migrations/20261106000000_collect_credits.sql'), 'utf8');
const WS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('credits: migration', () => {
  test('migration embeds credits.sql verbatim, FK to workspaces, revoke/grant like platform tables', () => {
    const body = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE'));
    assert.ok(MIGRATION.includes(body.trim()), 'credits.sql body drifted from migration');
    assert.equal(MIGRATION.match(/CREATE TABLE IF NOT EXISTS collect_credits/g).length, 1);
    assert.match(MIGRATION, /references public\.workspaces\(id\) on delete cascade/);
    assert.match(MIGRATION, /revoke all on public\.collect_credits from public, anon, authenticated/);
    assert.match(MIGRATION, /grant all on public\.collect_credits to app_worker/);
  });
});

describe('credits: constants and env', () => {
  test('PAID_STATUSES and CREDITS_TEXT match the agreed words', () => {
    assert.deepEqual(PAID_STATUSES, ['active', 'past_due']);
    assert.equal(CREDITS_TEXT.left(2), '무료 가져오기 2회 남음');
    assert.equal(CREDITS_TEXT.none(5), '무료 가져오기 5회를 모두 썼습니다');
    assert.equal(CREDITS_TEXT.noneNext, '계속 쓰려면 요금제를 골라 주세요');
    assert.equal(CREDITS_TEXT.plans, '요금제 보기');
  });

  test('freeCollects: default 5, 0 allowed, bad values fall back to 5', () => {
    assert.equal(freeCollects({}), 5);
    assert.equal(freeCollects(undefined), 5);
    assert.equal(freeCollects({ APP_FREE_COLLECTS: '' }), 5);
    assert.equal(freeCollects({ APP_FREE_COLLECTS: '0' }), 0);
    assert.equal(freeCollects({ APP_FREE_COLLECTS: ' 3 ' }), 3);
    assert.equal(freeCollects({ APP_FREE_COLLECTS: '-1' }), 5);
    assert.equal(freeCollects({ APP_FREE_COLLECTS: '2.5' }), 5);
    assert.equal(freeCollects({ APP_FREE_COLLECTS: 'abc' }), 5);
  });
});

describe('credits: take and summary', () => {
  let db;
  let store;
  before(async () => {
    db = await openDb({ memory: true });
    await db.applySchema(path.join(ROOT, 'app/core/billing/schema.sql'));
    await db.applySchema(path.join(ROOT, 'app/core/billing/credits.sql'));
    store = createBillingStore({ db });
  });
  after(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.admin('DELETE FROM collect_credits');
    await db.admin('DELETE FROM subscriptions');
  });
  const setStatus = async (status) => {
    await store.ensure(WS);
    await store.update(WS, { status });
  };
  const usedRow = async () => {
    const r = await db.admin('SELECT used FROM collect_credits WHERE workspace_id = $1', [WS]);
    return r.rows[0] ? Number(r.rows[0].used) : null;
  };

  test('trialing: 5 takes ok, 6th is { ok:false, left:0 }', async () => {
    const credits = createCredits({ db, workspaceId: WS, store });
    for (let i = 1; i <= 5; i += 1) {
      assert.deepEqual(await credits.take(), { ok: true, used: i, max: 5, left: 5 - i, unlimited: false });
    }
    assert.deepEqual(await credits.take(), { ok: false, used: 5, max: 5, left: 0, unlimited: false });
    assert.equal(await usedRow(), 5);
    assert.equal((await store.get(WS)).status, 'trialing');
  });

  test('20 concurrent takes → exactly 5 ok', async () => {
    const credits = createCredits({ db, workspaceId: WS, store });
    await store.ensure(WS);
    const results = await Promise.all(Array.from({ length: 20 }, () => credits.take()));
    assert.equal(results.filter((r) => r.ok).length, 5);
    assert.equal(await usedRow(), 5);
  });

  test('active subscription is unlimited and nothing is counted', async () => {
    await setStatus('active');
    const credits = createCredits({ db, workspaceId: WS, store });
    for (let i = 0; i < 8; i += 1) assert.equal((await credits.take()).ok, true);
    assert.equal(await usedRow(), null);
    const s = await credits.summary();
    assert.equal(s.unlimited, true);
    assert.equal(s.used, 0);
  });

  test('past_due is unlimited', async () => {
    await setStatus('past_due');
    const credits = createCredits({ db, workspaceId: WS, store });
    for (let i = 0; i < 7; i += 1) assert.deepEqual(await credits.take(), { ok: true, used: 0, max: 5, left: 5, unlimited: true });
    assert.equal(await usedRow(), null);
  });

  test('expired and canceled are limited like trialing', async () => {
    for (const status of ['expired', 'canceled']) {
      await db.admin('DELETE FROM collect_credits');
      await setStatus(status);
      const credits = createCredits({ db, workspaceId: WS, store, env: { APP_FREE_COLLECTS: '1' } });
      assert.equal((await credits.take()).ok, true, status);
      assert.equal((await credits.take()).ok, false, status);
    }
  });

  test('APP_FREE_COLLECTS=0 is unlimited without touching subscriptions', async () => {
    const calls = [];
    const spy = { ensure: async (id) => (calls.push(id), store.ensure(id)) };
    const credits = createCredits({ db, workspaceId: WS, store: spy, env: { APP_FREE_COLLECTS: '0' } });
    for (let i = 0; i < 10; i += 1) assert.equal((await credits.take()).ok, true);
    assert.equal(await usedRow(), null);
    assert.deepEqual(await credits.summary(), { used: 0, max: 0, left: 0, unlimited: true });
    assert.equal(calls.length, 0);
  });

  test('summary() reports stored numbers without taking', async () => {
    const credits = createCredits({ db, workspaceId: WS, store, env: { APP_FREE_COLLECTS: '3' } });
    assert.deepEqual(await credits.summary(), { used: 0, max: 3, left: 3, unlimited: false });
    await db.admin('INSERT INTO collect_credits (workspace_id, used) VALUES ($1, 2)', [WS]);
    assert.deepEqual(await credits.summary(), { used: 2, max: 3, left: 1, unlimited: false });
    assert.deepEqual(await credits.summary(), { used: 2, max: 3, left: 1, unlimited: false });
    assert.equal(await usedRow(), 2);
  });

  test('lowering the limit below used never yields negative left', async () => {
    await db.admin('INSERT INTO collect_credits (workspace_id, used) VALUES ($1, 4)', [WS]);
    const credits = createCredits({ db, workspaceId: WS, store, env: { APP_FREE_COLLECTS: '2' } });
    assert.deepEqual(await credits.summary(), { used: 4, max: 2, left: 0, unlimited: false });
    assert.deepEqual(await credits.take(), { ok: false, used: 2, max: 2, left: 0, unlimited: false });
    assert.equal(await usedRow(), 4);
  });

  test('refund() gives back one take, never goes below 0', async () => {
    const credits = createCredits({ db, workspaceId: WS, store, env: { APP_FREE_COLLECTS: '3' } });
    await credits.refund();
    assert.equal(await usedRow(), null);
    await credits.take();
    await credits.take();
    assert.equal(await usedRow(), 2);
    await credits.refund();
    assert.equal(await usedRow(), 1);
    await credits.refund();
    await credits.refund();
    assert.equal(await usedRow(), 0);
    assert.deepEqual(await credits.summary(), { used: 0, max: 3, left: 3, unlimited: false });
  });

  test('refund() is a no-op when unlimited (paid or APP_FREE_COLLECTS=0)', async () => {
    await db.admin('INSERT INTO collect_credits (workspace_id, used) VALUES ($1, 2)', [WS]);
    await createCredits({ db, workspaceId: WS, store, env: { APP_FREE_COLLECTS: '0' } }).refund();
    assert.equal(await usedRow(), 2);
    await setStatus('active');
    await createCredits({ db, workspaceId: WS, store }).refund();
    assert.equal(await usedRow(), 2);
  });
});
