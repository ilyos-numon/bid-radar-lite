import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { enqueueRuns } from '../../app/core/queue.mjs';
import { createWorker } from '../../app/core/worker.mjs';
import { createTestDb, WS_A, WS_B } from './helpers/fake-platform.mjs';

const dbs = [];
after(async () => {
  await Promise.all(dbs.map((d) => d.close()));
});

async function testDb() {
  const db = await createTestDb();
  dbs.push(db);
  return db;
}

/** 메모리 배열 큐 (pgmq 와 같은 read_ct·보이지 않는 시간 규칙) */
function fakeQueue({ vtMs } = {}) {
  let seq = 0n;
  const items = [];
  const acked = [];
  const archived = [];
  const reads = [];
  return {
    items,
    acked,
    archived,
    reads,
    async enqueue(msgs) {
      for (const m of msgs) items.push({ msgId: ++seq, readCt: 0, vt: 0, message: structuredClone(m) });
      return msgs.length;
    },
    async read({ vtSec, qty }) {
      reads.push(qty);
      const now = Date.now();
      const out = [];
      for (const it of items) {
        if (out.length >= qty) break;
        if (it.vt > now) continue;
        it.readCt += 1;
        it.vt = now + (vtMs ?? vtSec * 1000);
        out.push({ msgId: it.msgId, readCt: it.readCt, message: structuredClone(it.message) });
      }
      return out;
    },
    async ack(id) {
      const i = items.findIndex((x) => x.msgId === id);
      if (i >= 0) acked.push(...items.splice(i, 1));
    },
    async archive(id) {
      const i = items.findIndex((x) => x.msgId === id);
      if (i >= 0) archived.push(...items.splice(i, 1));
    },
    async depth() {
      return items.length;
    },
  };
}

const DATE = '2026-10-30';
const WS_C = '33333333-3333-4333-8333-333333333333';

const runOf = (db, ws, job, date) =>
  db.withWorkspace(ws, () => db.get('SELECT status, attempt FROM job_runs WHERE job = $1 AND date = $2', [job, date]));

function makeWorker(db, queue, opts = {}) {
  const delivered = [];
  const w = createWorker({
    queue,
    db,
    runJob: opts.runJob ?? (async (m) => ({ kind: 'bids', date: m.date, count: 1 })),
    deliver: async (ws, payload, runId) => {
      delivered.push({ ws, payload, runId });
    },
    log: () => {},
    pollMs: 5,
    concurrency: opts.concurrency ?? 2,
    timeoutMs: opts.timeoutMs ?? 2000,
    maxAttempts: opts.maxAttempts ?? 3,
    now: opts.now,
  });
  return { w, delivered };
}

describe('worker-drain', () => {
  test('worker-drain: drains the queue without start() and reports processed/remaining', async () => {
    const db = await testDb();
    const q = fakeQueue();
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A, WS_B], job: 'daily', date: DATE });
    const { w, delivered } = makeWorker(db, q);
    const r = await w.drain({ maxMs: 5000 });
    assert.deepEqual(r, { processed: 2, remaining: 0 });
    assert.equal(q.acked.length, 2);
    assert.equal(delivered.length, 2);
    for (const ws of [WS_A, WS_B]) assert.equal((await runOf(db, ws, 'daily', DATE)).status, 'done');
  });

  test('worker-drain: reads in batches of concurrency until an empty read', async () => {
    const db = await testDb();
    const q = fakeQueue();
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A, WS_B, WS_C], job: 'reminders', date: DATE });
    const { w } = makeWorker(db, q, { concurrency: 2 });
    const r = await w.drain({ maxMs: 5000 });
    assert.deepEqual(r, { processed: 3, remaining: 0 });
    assert.deepEqual(q.reads, [2, 2, 2]);
  });

  test('worker-drain: empty queue returns zeros after one read', async () => {
    const db = await testDb();
    const q = fakeQueue();
    const { w } = makeWorker(db, q);
    assert.deepEqual(await w.drain(), { processed: 0, remaining: 0 });
    assert.equal(q.reads.length, 1);
  });

  test('worker-drain: stops once maxMs has elapsed and reports what is left', async () => {
    const db = await testDb();
    const q = fakeQueue();
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A, WS_B, WS_C], job: 'daily', date: DATE });
    let t = 0;
    const now = () => new Date(Date.UTC(2026, 9, 30) + t);
    const { w } = makeWorker(db, q, {
      concurrency: 1,
      now,
      runJob: async (m) => {
        t += 1000;
        return { kind: 'bids', date: m.date, count: 1 };
      },
    });
    const r = await w.drain({ maxMs: 1500 });
    assert.deepEqual(r, { processed: 2, remaining: 1 });
    assert.equal(q.items.length, 1);
  });

  test('worker-drain: failed job stays in the queue (invisible) and counts as remaining', async () => {
    const db = await testDb();
    const q = fakeQueue();
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A, WS_B], job: 'support', date: DATE });
    const { w } = makeWorker(db, q, {
      runJob: async (m) => {
        if (m.workspaceId === WS_B) throw Object.assign(new Error('boom'), { code: 'UPSTREAM' });
        return null;
      },
    });
    const r = await w.drain({ maxMs: 5000 });
    assert.deepEqual(r, { processed: 2, remaining: 1 });
    assert.equal((await runOf(db, WS_A, 'support', DATE)).status, 'done');
    assert.equal((await runOf(db, WS_B, 'support', DATE)).status, 'failed');
  });

  test('worker-drain: read failure ends the drain instead of throwing', async () => {
    const db = await testDb();
    const q = fakeQueue();
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A], job: 'daily', date: DATE });
    q.read = async () => {
      throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    };
    const { w } = makeWorker(db, q);
    assert.deepEqual(await w.drain({ maxMs: 5000 }), { processed: 0, remaining: 1 });
  });
});
