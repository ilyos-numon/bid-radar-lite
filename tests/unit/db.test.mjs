import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { openDb, LEGACY_WS, transaction } from '../../app/core/db.mjs';

const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});
function tmp() {
  const d = mkdtempSync(path.join(tmpdir(), 'br-db-'));
  tmpRoots.push(d);
  return d;
}

/** pg.Pool 대체: 받은 SQL 을 기록하고 정해 둔 결과를 돌려준다 */
function fakePool() {
  const log = [];
  let n = 0;
  const pool = {
    log,
    released: [],
    ended: false,
    totalCount: 2,
    idleCount: 1,
    waitingCount: 0,
    async connect() {
      const id = ++n;
      return {
        id,
        async query(text, params) {
          log.push({ via: `client${id}`, text, params });
          return { rows: [{ client: id }], rowCount: 1 };
        },
        release(err) {
          pool.released.push({ id, err: err ?? null });
        },
      };
    },
    async query(text, params) {
      log.push({ via: 'pool', text, params });
      return { rows: [{ ok: 1 }], rowCount: 1 };
    },
    async end() {
      pool.ended = true;
    },
  };
  return pool;
}

describe('openDb options', () => {
  test('needs exactly one of url, dataDir, memory', async () => {
    await assert.rejects(openDb({}), /exactly one/);
    await assert.rejects(openDb({ memory: true, url: 'postgresql://x' }), /exactly one/);
  });

  test('dataDir that is an existing file → SQLITE_FILE_FOUND', async () => {
    const f = path.join(tmp(), 'app.db');
    writeFileSync(f, 'SQLite format 3\0');
    await assert.rejects(openDb({ dataDir: f }), (e) => {
      assert.equal(e.code, 'SQLITE_FILE_FOUND');
      assert.match(e.message, /node scripts\/migrate-sqlite\.mjs/);
      return true;
    });
  });
});

describe('pglite adapter', () => {
  test('memory: core schema applied, query/get/all/run, workspace default', async () => {
    const t0 = Date.now();
    const db = await openDb({ memory: true });
    const ms = Date.now() - t0;
    try {
      assert.equal(db.kind, 'pglite');
      assert.ok(ms >= 0);
      assert.deepEqual(db.stats(), { total: 1, idle: 1, waiting: 0 });
      const ins = await db.run('INSERT INTO settings (key, value) VALUES ($1, $2)', ['a', '1']);
      assert.equal(ins.rowCount, 1);
      const up = await db.run(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value',
        ['a', '2'],
      );
      assert.equal(up.rowCount, 1);
      const row = await db.get('SELECT workspace_id, value FROM settings WHERE key = $1', ['a']);
      assert.deepEqual(row, { workspace_id: LEGACY_WS, value: '2' });
      assert.equal(await db.get('SELECT value FROM settings WHERE key = $1', ['zz']), null);
      assert.deepEqual(await db.all('SELECT key FROM settings ORDER BY key'), [{ key: 'a' }]);
      const n = await db.get('SELECT COUNT(*) AS n FROM settings');
      assert.equal(n.n, 1);
      const m = await db.run(
        "INSERT INTO members (name, role, token_hash, created_at) VALUES ('a', 'owner', 'h', 'now') RETURNING id",
      );
      assert.equal(m.rows[0].id, 1);
      const q = await db.query('SELECT 1 AS one');
      assert.deepEqual(q.rows, [{ one: 1 }]);
      const adm = await db.admin('SELECT 2 AS two');
      assert.deepEqual(adm.rows, [{ two: 2 }]);
      assert.equal(await db.withWorkspace(LEGACY_WS, async () => 'x'), 'x');
    } finally {
      await db.close();
    }
  });

  test('applySchema runs a file (path or URL)', async () => {
    const db = await openDb({ memory: true });
    try {
      const f = path.join(tmp(), 's.sql');
      writeFileSync(f, 'CREATE TABLE IF NOT EXISTS x_items (id text PRIMARY KEY); INSERT INTO x_items VALUES (\'k\');');
      await db.applySchema(f);
      const g = path.join(tmp(), 't.sql');
      writeFileSync(g, "INSERT INTO x_items VALUES ('j');");
      await db.applySchema(pathToFileURL(g));
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM x_items')).n, 2);
    } finally {
      await db.close();
    }
  });

  test('transaction: concurrent query outside the transaction waits for COMMIT/ROLLBACK', async () => {
    const db = await openDb({ memory: true });
    try {
      await db.query('CREATE TABLE t (v text)');
      let open;
      const gate = new Promise((res) => (open = res));
      let entered;
      const inside = new Promise((res) => (entered = res));
      const tx = transaction(db, async () => {
        await db.run("INSERT INTO t (v) VALUES ('tx')");
        entered();
        await gate;
        throw new Error('boom');
      });
      await inside;
      const outside = db.run("INSERT INTO t (v) VALUES ('outside')");
      await new Promise((res) => setTimeout(res, 20));
      open();
      await assert.rejects(tx, /boom/);
      await outside;
      assert.deepEqual((await db.all('SELECT v FROM t')).map((r) => r.v), ['outside']);
      assert.equal(await transaction(db, async () => (await db.get('SELECT 1 AS n')).n), 1);
    } finally {
      await db.close();
    }
  });

  test('dataDir persists across reopen', async () => {
    const dir = path.join(tmp(), 'pg');
    const a = await openDb({ dataDir: dir });
    await a.run('INSERT INTO settings (key, value) VALUES ($1, $2)', ['k', 'v']);
    await a.close();
    const b = await openDb({ dataDir: dir });
    try {
      assert.equal((await b.get('SELECT value FROM settings WHERE key = $1', ['k'])).value, 'v');
    } finally {
      await b.close();
    }
  });
});

describe('pg adapter (fake pool)', () => {
  test('query outside withWorkspace rejects NO_WORKSPACE', async () => {
    const pool = fakePool();
    const db = await openDb({ pool });
    assert.equal(db.kind, 'pg');
    for (const fn of ['query', 'get', 'all', 'run']) {
      await assert.rejects(db[fn]('SELECT 1'), (e) => e.code === 'NO_WORKSPACE', fn);
    }
    assert.equal(pool.log.length, 0);
  });

  test('withWorkspace: set_config, statement_timeout, fn on same client, DISCARD ALL, release', async () => {
    const pool = fakePool();
    const db = await openDb({ pool });
    const ws = '11111111-1111-1111-1111-111111111111';
    const out = await db.withWorkspace(ws, async () => {
      await new Promise((r) => setTimeout(r, 1));
      const row = await db.get('SELECT $1::int AS v', [5]);
      // 중첩 호출은 같은 커넥션을 쓴다
      await db.withWorkspace(ws, () => db.all('SELECT 2'));
      return row;
    });
    assert.deepEqual(out, { client: 1 });
    assert.deepEqual(
      pool.log.map((l) => [l.via, l.text]),
      [
        ['client1', "select set_config('app.workspace_id', $1, false)"],
        ['client1', 'set statement_timeout = 30000'],
        ['client1', 'SELECT $1::int AS v'],
        ['client1', 'SELECT 2'],
        ['client1', 'DISCARD ALL'],
      ],
    );
    assert.deepEqual(pool.log[0].params, [ws]);
    assert.deepEqual(pool.released, [{ id: 1, err: null }]);
  });

  test('withWorkspace releases the client when fn throws', async () => {
    const pool = fakePool();
    const db = await openDb({ pool });
    await assert.rejects(db.withWorkspace(LEGACY_WS, async () => {
      throw new Error('boom');
    }), /boom/);
    assert.equal(pool.log.at(-1).text, 'DISCARD ALL');
    assert.equal(pool.released.length, 1);
  });

  test('parallel withWorkspace calls keep separate clients (ALS)', async () => {
    const pool = fakePool();
    const db = await openDb({ pool });
    const [a, b] = await Promise.all([
      db.withWorkspace('a', async () => {
        await new Promise((r) => setTimeout(r, 5));
        return db.get('SELECT 1');
      }),
      db.withWorkspace('b', () => db.get('SELECT 1')),
    ]);
    assert.notEqual(a.client, b.client);
  });

  test('admin, applySchema use the pool directly; stats; close ends pool', async () => {
    const pool = fakePool();
    const db = await openDb({ pool });
    assert.deepEqual(await db.admin('SELECT 1', []), { rows: [{ ok: 1 }], rowCount: 1 });
    const f = path.join(tmp(), 's.sql');
    writeFileSync(f, 'SELECT 1;');
    await db.applySchema(f);
    assert.deepEqual(pool.log.map((l) => l.via), ['pool', 'pool']);
    assert.equal(pool.log[1].text, 'SELECT 1;');
    assert.deepEqual(db.stats(), { total: 2, idle: 1, waiting: 0 });
    await db.close();
    assert.equal(pool.ended, true);
  });
});

describe('pg adapter: pool error tolerance', () => {
  /** EventEmitter 를 상속한 pg.Pool 대체물 */
  class EmitterPool extends EventEmitter {
    async query() {
      return { rows: [{ ok: 1 }], rowCount: 1 };
    }
    async connect() {
      return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
    }
    async end() {}
  }
  const captureStdout = async (fn) => {
    const lines = [];
    const orig = process.stdout.write;
    process.stdout.write = function (chunk, ...rest) {
      lines.push(String(chunk));
      return orig.call(this, chunk, ...rest);
    };
    try {
      await fn();
    } finally {
      process.stdout.write = orig;
    }
    return lines.join('');
  };

  test('idle client error does not crash; queries keep working; no process-level handler added', async () => {
    const pool = new EmitterPool();
    const before = process.listenerCount('uncaughtException');
    const db = await openDb({ pool });
    assert.equal(pool.listenerCount('error'), 1);
    const out = await captureStdout(async () => {
      pool.emit('error', Object.assign(new Error('terminated by peer secret-conn-string'), { code: 'ECONNRESET' }));
    });
    assert.deepEqual(await db.admin('select 1'), { rows: [{ ok: 1 }], rowCount: 1 });
    assert.equal(process.listenerCount('uncaughtException'), before);
    assert.match(out, /"code":"ECONNRESET"/);
    assert.match(out, /idle client error/);
    assert.doesNotMatch(out, /terminated|secret-conn-string/);
    await db.close();
  });

  test('error code that is not a plain token is logged as "error"', async () => {
    const pool = new EmitterPool();
    const db = await openDb({ pool });
    const out = await captureStdout(async () => {
      pool.emit('error', Object.assign(new Error('x'), { code: 'bad code; drop' }));
      pool.emit('error', new Error('no code'));
    });
    assert.equal((out.match(/"code":"error"/g) ?? []).length, 2);
    await db.close();
  });

  test('pool without on() (plain object) still opens', async () => {
    const db = await openDb({ pool: { query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} } });
    assert.deepEqual(await db.admin('select 1'), { rows: [], rowCount: 0 });
    await db.close();
  });
});
