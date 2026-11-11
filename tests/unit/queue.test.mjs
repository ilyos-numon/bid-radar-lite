import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createQueue, enqueueRuns, isJobMessage, jobMessage } from '../../app/core/queue.mjs';
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

/** 메모리 배열 큐 (pgmq 와 같은 read_ct·보이지 않는 시간 규칙). vtMs 로 보이지 않는 시간을 덮어쓴다 */
function fakeQueue({ vtMs } = {}) {
  let seq = 0n;
  const items = [];
  const archived = [];
  const acked = [];
  return {
    items,
    archived,
    acked,
    async enqueue(msgs) {
      for (const m of msgs) items.push({ msgId: ++seq, readCt: 0, vt: 0, message: structuredClone(m) });
      return msgs.length;
    },
    async read({ vtSec, qty }) {
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

async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

const runOf = (db, ws, job, date) =>
  db.withWorkspace(ws, () => db.get('SELECT run_id, status, attempt, error_code FROM job_runs WHERE job = $1 AND date = $2', [job, date]));

const DATE = '2026-10-30';

describe('queue: enqueueRuns', () => {
  test('queue: same day twice → second run skipped, failed run re-queued', async () => {
    const db = await testDb();
    const q = fakeQueue();
    const first = await enqueueRuns({ db, queue: q, workspaceIds: [WS_A, WS_B], job: 'daily', date: DATE });
    assert.deepEqual(first, { runId: `daily:${DATE}`, enqueued: 2, skipped: 0 });
    assert.equal(q.items.length, 2);
    assert.ok(q.items.every((x) => isJobMessage(x.message)));
    assert.equal(q.items[0].message.runId, `daily:${DATE}:${WS_A}`);
    assert.equal((await runOf(db, WS_A, 'daily', DATE)).status, 'queued');

    const second = await enqueueRuns({ db, queue: q, workspaceIds: [WS_A, WS_B], job: 'daily', date: DATE });
    assert.deepEqual(second, { runId: `daily:${DATE}`, enqueued: 0, skipped: 2 });
    assert.equal(q.items.length, 2);

    await db.withWorkspace(WS_B, () => db.run("UPDATE job_runs SET status = 'dead' WHERE job = 'daily'"));
    const third = await enqueueRuns({ db, queue: q, workspaceIds: [WS_A, WS_B], job: 'daily', date: DATE });
    assert.deepEqual(third, { runId: `daily:${DATE}`, enqueued: 1, skipped: 1 });
    assert.equal((await runOf(db, WS_B, 'daily', DATE)).status, 'queued');
    // 다른 날은 따로
    const other = await enqueueRuns({ db, queue: q, workspaceIds: [WS_A], job: 'daily', date: '2026-10-31' });
    assert.equal(other.enqueued, 1);
  });

  test('queue: enqueue failure leaves rows failed (next trigger retries)', async () => {
    const db = await testDb();
    const q = fakeQueue();
    q.enqueue = async () => {
      throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    };
    await assert.rejects(enqueueRuns({ db, queue: q, workspaceIds: [WS_A], job: 'support', date: DATE }), { code: 'ECONNREFUSED' });
    assert.equal((await runOf(db, WS_A, 'support', DATE)).status, 'failed');
  });

  test('queue: createQueue calls pgmq functions through db.admin', async () => {
    const calls = [];
    const db = {
      async admin(text, params) {
        calls.push({ text, params });
        if (text.includes('pgmq.read')) return { rows: [{ msg_id: 7, read_ct: 2, message: jobMessage('daily', DATE, WS_A, 'x') }], rowCount: 1 };
        if (text.includes('q_jobs')) return { rows: [{ n: 3 }], rowCount: 1 };
        return { rows: [{}, {}], rowCount: 2 };
      },
    };
    const q = createQueue({ db });
    assert.equal(await q.enqueue([jobMessage('daily', DATE, WS_A, 'x'), jobMessage('daily', DATE, WS_B, 'x')]), 2);
    assert.match(calls[0].text, /pgmq\.send_batch\(\$1::text, \$2::jsonb\[\], \$3::integer\)/);
    assert.equal(calls[0].params[0], 'jobs');
    assert.equal(JSON.parse(calls[0].params[1][1]).workspaceId, WS_B);
    const got = await q.read({ vtSec: 30, qty: 2 });
    assert.match(calls[1].text, /pgmq\.read\(\$1::text, \$2::integer, \$3::integer, '\{\}'::jsonb\)/);
    assert.deepEqual(calls[1].params, ['jobs', 30, 2]);
    assert.deepEqual(got, [{ msgId: 7n, readCt: 2, message: jobMessage('daily', DATE, WS_A, 'x') }]);
    await q.ack(7n);
    await q.archive(7n);
    assert.match(calls[2].text, /pgmq\.delete/);
    assert.match(calls[3].text, /pgmq\.archive/);
    assert.deepEqual(calls[3].params, ['jobs', '7']);
    assert.equal(await q.depth(), 3);
    assert.equal(await q.enqueue([]), 0);
  });

  test('queue: live pgmq smoke (conditional on BR_PGMQ_URL)', async (t) => {
    const url = process.env.BR_PGMQ_URL;
    if (!url) {
      t.diagnostic('조건부 실행: BR_PGMQ_URL 이 없어 pgmq 실호출을 생략했다');
      return;
    }
    const { openDb } = await import('../../app/core/db.mjs');
    const db = await openDb({ url, poolSize: 2 });
    try {
      const q = createQueue({ db });
      const m = jobMessage('support', '1999-01-01', WS_A, new Date().toISOString());
      assert.equal(await q.enqueue([m]), 1);
      let mine = [];
      for (let i = 0; i < 20 && mine.length === 0; i += 1) {
        mine = (await q.read({ vtSec: 30, qty: 50 })).filter((x) => x.message.runId === m.runId);
      }
      assert.equal(mine.length, 1);
      assert.equal(mine[0].readCt, 1);
      assert.equal(typeof mine[0].msgId, 'bigint');
      await q.archive(mine[0].msgId);
    } finally {
      await db.close();
    }
  });
});

function makeWorker(db, queue, opts = {}) {
  const logs = [];
  const delivered = [];
  const w = createWorker({
    queue,
    db,
    runJob: opts.runJob ?? (async (m) => ({ kind: 'bids', date: m.date, count: 1 })),
    deliver:
      opts.deliver ??
      (async (ws, payload, runId) => {
        delivered.push({ ws, payload, runId });
      }),
    log: (l) => logs.push(l),
    pollMs: 5,
    concurrency: opts.concurrency ?? 2,
    timeoutMs: opts.timeoutMs ?? 2000,
    maxAttempts: opts.maxAttempts ?? 3,
  });
  return { w, logs, delivered };
}

describe('worker', () => {
  test('worker: success → done, ack, delivered once with runId', async () => {
    const db = await testDb();
    const q = fakeQueue();
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A, WS_B], job: 'daily', date: DATE });
    const { w, delivered } = makeWorker(db, q);
    w.start();
    await waitFor(() => q.acked.length === 2);
    await w.stop();
    for (const ws of [WS_A, WS_B]) {
      const r = await runOf(db, ws, 'daily', DATE);
      assert.equal(r.status, 'done');
      assert.equal(r.attempt, 1);
      assert.equal(r.error_code, null);
    }
    assert.equal(delivered.length, 2);
    const a = delivered.find((d) => d.ws === WS_A);
    assert.equal(a.runId, `daily:${DATE}:${WS_A}`);
    assert.equal(a.payload.runId, a.runId);
    assert.equal(a.payload.count, 1);
  });

  test('worker: null result → done without delivery', async () => {
    const db = await testDb();
    const q = fakeQueue();
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A], job: 'support', date: DATE });
    const { w, delivered } = makeWorker(db, q, { runJob: async () => null });
    w.start();
    await waitFor(() => q.acked.length === 1);
    await w.stop();
    assert.equal(delivered.length, 0);
    assert.equal((await runOf(db, WS_A, 'support', DATE)).status, 'done');
  });

  test('worker: fails always → retried 3 times, read_ct 4 → archive + dead', async () => {
    const db = await testDb();
    const q = fakeQueue({ vtMs: 0 });
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A], job: 'daily', date: DATE });
    let calls = 0;
    const { w, logs } = makeWorker(db, q, {
      runJob: async () => {
        calls += 1;
        throw Object.assign(new Error('boom secret'), { code: 'NARA_DOWN' });
      },
    });
    w.start();
    await waitFor(() => q.archived.length === 1);
    await w.stop();
    assert.equal(calls, 3);
    assert.equal(q.archived[0].readCt, 4);
    const r = await runOf(db, WS_A, 'daily', DATE);
    assert.equal(r.status, 'dead');
    assert.equal(r.attempt, 3);
    assert.equal(r.error_code, 'MAX_ATTEMPTS');
    assert.ok(logs.some((l) => l.includes('NARA_DOWN')));
    assert.ok(!logs.some((l) => l.includes('boom secret')));
  });

  test('worker: fails once then succeeds → done on attempt 2', async () => {
    const db = await testDb();
    const q = fakeQueue({ vtMs: 0 });
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A], job: 'daily', date: DATE });
    let calls = 0;
    const seen = [];
    const { w, delivered } = makeWorker(db, q, {
      runJob: async (m) => {
        calls += 1;
        if (calls === 1) {
          seen.push((await runOf(db, WS_A, 'daily', DATE)).status);
          throw Object.assign(new Error('x'), { code: 'TEMP' });
        }
        return { kind: 'bids', date: m.date, count: 0 };
      },
    });
    w.start();
    await waitFor(() => q.acked.length === 1);
    await w.stop();
    assert.deepEqual(seen, ['running']);
    const r = await runOf(db, WS_A, 'daily', DATE);
    assert.equal(r.status, 'done');
    assert.equal(r.attempt, 2);
    assert.equal(delivered.length, 1);
  });

  test('worker: delivery failure → failed and retried', async () => {
    const db = await testDb();
    const q = fakeQueue({ vtMs: 0 });
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A], job: 'daily', date: DATE });
    let tries = 0;
    const { w } = makeWorker(db, q, {
      deliver: async () => {
        tries += 1;
        if (tries === 1) throw Object.assign(new Error('x'), { code: 'DELIVERY_FAILED' });
      },
    });
    w.start();
    await waitFor(() => q.acked.length === 1);
    await w.stop();
    assert.equal(tries, 2);
    assert.equal((await runOf(db, WS_A, 'daily', DATE)).status, 'done');
  });

  test('worker: timeout → failed, then the other workspace is done', async () => {
    const db = await testDb();
    const q = fakeQueue({ vtMs: 60000 });
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A, WS_B], job: 'daily', date: DATE });
    let aborted = false;
    const { w, logs } = makeWorker(db, q, {
      concurrency: 1,
      timeoutMs: 50,
      runJob: (m, signal) => {
        if (m.workspaceId === WS_A) {
          return new Promise(() => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          });
        }
        return Promise.resolve({ kind: 'bids', date: m.date, count: 0 });
      },
    });
    w.start();
    await waitFor(() => q.acked.length === 1);
    await w.stop();
    const a = await runOf(db, WS_A, 'daily', DATE);
    assert.equal(a.status, 'failed');
    assert.equal(a.error_code, 'TIMEOUT');
    assert.equal(aborted, true);
    assert.equal((await runOf(db, WS_B, 'daily', DATE)).status, 'done');
    assert.equal(q.acked[0].message.workspaceId, WS_B);
    const ia = logs.findIndex((l) => l.includes(WS_A) && l.includes('TIMEOUT'));
    const ib = logs.findIndex((l) => l.includes(WS_B) && l.includes('done'));
    assert.ok(ia >= 0 && ib > ia, 'A fails before B is done');
  });

  test('worker: already done run id is acked without running again', async () => {
    const db = await testDb();
    const q = fakeQueue();
    await enqueueRuns({ db, queue: q, workspaceIds: [WS_A], job: 'daily', date: DATE });
    await q.enqueue([jobMessage('daily', DATE, WS_A, 'dup')]);
    let calls = 0;
    const { w, delivered } = makeWorker(db, q, {
      concurrency: 1,
      runJob: async (m) => {
        calls += 1;
        return { kind: 'bids', date: m.date, count: 0 };
      },
    });
    w.start();
    await waitFor(() => q.acked.length === 2);
    await w.stop();
    assert.equal(calls, 1);
    assert.equal(delivered.length, 1);
  });

  test('worker: malformed message is archived', async () => {
    const db = await testDb();
    const q = fakeQueue();
    await q.enqueue([{ v: 2, job: 'daily' }, { ...jobMessage('daily', DATE, WS_A, 'x'), runId: 'forged' }]);
    let calls = 0;
    const { w } = makeWorker(db, q, {
      runJob: async () => {
        calls += 1;
        return null;
      },
    });
    w.start();
    await waitFor(() => q.archived.length === 2);
    await w.stop();
    assert.equal(calls, 0);
  });

  test('worker: read error is logged and polling continues; stop() ends the loop', async () => {
    const db = await testDb();
    const q = fakeQueue();
    let reads = 0;
    const realRead = q.read;
    q.read = async (o) => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error('x'), { code: 'ECONNRESET' });
      return realRead(o);
    };
    const { w, logs } = makeWorker(db, q);
    w.start();
    w.start();
    await waitFor(() => reads >= 3);
    await w.stop();
    const n = reads;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(reads, n, 'no reads after stop');
    assert.ok(logs.some((l) => l.includes('ECONNRESET')));
  });
});
