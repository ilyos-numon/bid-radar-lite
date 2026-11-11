// DB 접근은 이 파일에만 둔다. Postgres(pg.Pool) 와 PGlite(기존 모드) 를 같은 비동기 인터페이스로 감싼다.
// 반환 객체: kind / query / get / all / run / applySchema / withWorkspace / admin / stats / close
import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { logger } from './log.mjs';

export const LEGACY_WS = '00000000-0000-0000-0000-000000000001';

const CORE_SCHEMA = fileURLToPath(new URL('./schema.sql', import.meta.url));
const INT8_OID = 20;
// PGlite 어댑터의 트랜잭션 직렬화 훅 (transaction() 만 쓴다)
const TX = Symbol('tx');

function readSql(file) {
  const p = file instanceof URL ? fileURLToPath(file) : String(file);
  return readFileSync(p, 'utf8');
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

// int8(count(*), bigint 금액) 은 두 드라이버 모두 number 로 돌려준다 (PGlite 기본과 같게)
const pgTypes = {
  getTypeParser(oid, format) {
    if (oid === INT8_OID && format !== 'binary') return (v) => (v === null ? null : Number(v));
    return pg.types.getTypeParser(oid, format);
  },
};

function wrapCommon(base) {
  return {
    ...base,
    async get(text, params) {
      const r = await base.query(text, params);
      return r.rows[0] ?? null;
    },
    async all(text, params) {
      return (await base.query(text, params)).rows;
    },
    async run(text, params) {
      const r = await base.query(text, params);
      return { rowCount: r.rowCount, rows: r.rows };
    },
  };
}

// 로그용 오류 코드: 메시지·연결 문자열은 남기지 않는다
function errorCode(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'error';
}

function openPg({ url, poolSize = 10, pool: injected }) {
  const pool = injected ?? new pg.Pool({ connectionString: url, max: poolSize, types: pgTypes });
  // 쉬던 연결이 끊기면 Pool 이 'error' 를 낸다. 리스너가 없으면 프로세스가 죽으므로 경고만 남긴다
  if (typeof pool.on === 'function') pool.on('error', (err) => logger.warn({ module: 'db', code: errorCode(err) }, 'idle client error'));
  const als = new AsyncLocalStorage();
  const norm = (r) => ({ rows: r.rows ?? [], rowCount: Number(r.rowCount ?? 0) });

  return wrapCommon({
    kind: 'pg',
    async query(text, params = []) {
      const store = als.getStore();
      if (!store) throw fail('NO_WORKSPACE', 'query outside withWorkspace');
      return norm(await store.client.query(text, params));
    },
    async applySchema(file) {
      await pool.query(readSql(file));
    },
    async withWorkspace(workspaceId, fn) {
      const cur = als.getStore();
      if (cur && cur.workspaceId === workspaceId) return fn();
      const client = await pool.connect();
      try {
        await client.query("select set_config('app.workspace_id', $1, false)", [String(workspaceId)]);
        await client.query('set statement_timeout = 30000');
        return await als.run({ client, workspaceId }, fn);
      } finally {
        try {
          await client.query('DISCARD ALL');
          client.release();
        } catch (err) {
          client.release(err);
        }
      }
    },
    async admin(text, params = []) {
      return norm(await pool.query(text, params));
    },
    stats() {
      return { total: pool.totalCount ?? 0, idle: pool.idleCount ?? 0, waiting: pool.waitingCount ?? 0 };
    },
    async close() {
      await pool.end();
    },
  });
}

async function openPglite({ dataDir, memory }) {
  if (dataDir) {
    const abs = path.resolve(dataDir);
    if (existsSync(abs) && statSync(abs).isFile()) {
      throw fail(
        'SQLITE_FILE_FOUND',
        `기존 SQLite 파일이 있습니다: ${abs}. 먼저 node scripts/migrate-sqlite.mjs 로 옮긴 뒤 다시 시작해 주세요.`,
      );
    }
    mkdirSync(abs, { recursive: true });
  }
  const lite = memory ? await PGlite.create() : await PGlite.create(path.resolve(dataDir));
  // 기존 모드는 회사가 하나뿐이다. 열 때 기본 워크스페이스를 정해 둔다
  await lite.query("select set_config('app.workspace_id', $1, false)", [LEGACY_WS]);
  let wsSet = false;
  const norm = (r) => ({ rows: r.rows ?? [], rowCount: Number(r.affectedRows || (r.rows ? r.rows.length : 0)) });
  // 연결이 하나뿐이라 BEGIN…COMMIT 사이에 다른 요청의 쿼리가 끼면 같은 트랜잭션에 섞인다.
  // transaction() 이 잡은 동안에는 그 흐름(ALS 토큰)이 아닌 쿼리를 끝날 때까지 기다리게 한다
  const txAls = new AsyncLocalStorage();
  let txActive = null; // { token, done: Promise }
  const waitTurn = async () => {
    while (txActive && txAls.getStore() !== txActive.token) await txActive.done;
  };
  const query = async (text, params = []) => {
    await waitTurn();
    return norm(await lite.query(text, params));
  };
  const tx = async (fn) => {
    if (txActive && txAls.getStore() === txActive.token) return fn(); // 이미 그 트랜잭션 안
    while (txActive) await txActive.done;
    let release;
    const token = {};
    txActive = { token, done: new Promise((res) => (release = res)) };
    try {
      return await txAls.run(token, fn);
    } finally {
      txActive = null;
      release();
    }
  };

  const db = wrapCommon({
    kind: 'pglite',
    query,
    async applySchema(file) {
      await lite.exec(readSql(file));
    },
    async withWorkspace(workspaceId, fn) {
      if (!wsSet) {
        await lite.query("select set_config('app.workspace_id', $1, false)", [String(workspaceId)]);
        wsSet = true;
      }
      return fn();
    },
    admin: query,
    stats() {
      return { total: 1, idle: 1, waiting: 0 };
    },
    async close() {
      if (!lite.closed) await lite.close();
    },
  });
  db[TX] = tx;
  return db;
}

/**
 * @param {{ url?: string, dataDir?: string, memory?: boolean, poolSize?: number, pool?: object }} opts
 *   url|dataDir|memory 중 정확히 하나. pool 은 테스트용 pg.Pool 대체물(url 대신)
 * @returns {Promise<object>} Db
 */
export async function openDb(opts = {}) {
  const given = ['url', 'dataDir', 'memory', 'pool'].filter((k) => opts[k]);
  if (given.length !== 1) throw new Error('openDb needs exactly one of url, dataDir, memory');
  const db = opts.url || opts.pool ? openPg(opts) : await openPglite(opts);
  if (db.kind === 'pglite') {
    try {
      await db.applySchema(CORE_SCHEMA);
    } catch (err) {
      await db.close();
      throw err;
    }
  }
  return db;
}

/**
 * BEGIN … COMMIT. 실패하면 ROLLBACK 후 다시 던진다.
 * PGlite(단일 연결)에서는 트랜잭션이 열린 동안 다른 흐름의 쿼리가 끼어들지 않게 기다리게 한다.
 * @template T @param {object} db @param {() => Promise<T>} fn @returns {Promise<T>}
 */
export async function transaction(db, fn) {
  if (typeof db[TX] === 'function') return db[TX](() => plainTransaction(db, fn));
  return plainTransaction(db, fn);
}

async function plainTransaction(db, fn) {
  await db.query('BEGIN');
  try {
    const out = await fn();
    await db.query('COMMIT');
    return out;
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}
