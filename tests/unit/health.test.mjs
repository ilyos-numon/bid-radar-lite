import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealth } from '../../app/core/health.mjs';

function fakeDb({ fail = false, hang = false } = {}) {
  const db = {
    calls: 0,
    async admin() {
      db.calls += 1;
      if (hang) return new Promise(() => {});
      if (fail) throw Object.assign(new Error('connect ECONNREFUSED secret-host'), { code: 'ECONNREFUSED' });
      return { rows: [{ '?column?': 1 }] };
    },
    stats: () => ({ total: 2, idle: 1, waiting: 0 }),
  };
  return db;
}

test('health: all ok → status ok and 200', async () => {
  const h = createHealth({
    db: fakeDb(),
    queue: { depth: async () => 3 },
    platform: { preflight: async () => ({ ok: true }) },
    mode: 'supabase',
  });
  const r = await h.readyz();
  assert.equal(r.status, 'ok');
  assert.equal(r.mode, 'supabase');
  assert.equal(r.checks.db.ok, true);
  assert.equal(r.checks.db.waiting, 0);
  assert.equal(typeof r.checks.db.ms, 'number');
  assert.deepEqual({ ok: r.checks.queue.ok, depth: r.checks.queue.depth }, { ok: true, depth: 3 });
  assert.equal(r.checks.auth.ok, true);
  assert.equal((await h.response()).status, 200);
});

test('health: db refused → degraded and 503 shape, no error text', async () => {
  const h = createHealth({ db: fakeDb({ fail: true }), mode: 'legacy' });
  const res = await h.response();
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, 'degraded');
  assert.equal(body.mode, 'legacy');
  assert.equal(body.checks.db.ok, false);
  assert.equal(typeof body.checks.db.ms, 'number');
  assert.deepEqual(Object.keys(body.checks), ['db']);
  assert.ok(!JSON.stringify(body).includes('secret-host'));
});

test('health: failing queue or auth also degrades', async () => {
  const q = createHealth({ db: fakeDb(), queue: { depth: async () => { throw new Error('x'); } }, mode: 'supabase' });
  assert.equal((await q.readyz()).status, 'degraded');
  const a = createHealth({ db: fakeDb(), platform: { preflight: async () => ({ ok: false }) }, mode: 'supabase' });
  const r = await a.readyz();
  assert.equal(r.status, 'degraded');
  assert.equal(r.checks.auth.ok, false);
});

test('health: hanging check times out', async () => {
  const h = createHealth({ db: fakeDb({ hang: true }), mode: 'legacy', timeoutMs: 50 });
  const r = await h.readyz();
  assert.equal(r.checks.db.ok, false);
  assert.equal(r.status, 'degraded');
});

test('health: result cached for 10 seconds', async () => {
  let t = 1_000_000;
  const db = fakeDb();
  const h = createHealth({ db, mode: 'legacy', now: () => t });
  await h.readyz();
  t += 9_999;
  await h.readyz();
  await h.response();
  assert.equal(db.calls, 1);
  t += 1;
  await h.readyz();
  assert.equal(db.calls, 2);
});
