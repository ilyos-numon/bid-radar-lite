// 앱 진입점: 환경 점검 → (기존 모드) PGlite + createRuntime 또는 (가입 모드) 공유 Postgres + createApp → listen
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createRuntime } from './core/registry.mjs';
import { createPlatform } from './core/supabase.mjs';
import { createApp } from './core/tenant.mjs';
import { registerPlatformRoutes } from './core/platform-routes.mjs';
import { logger, logRequest } from './core/log.mjs';

const env = process.env;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const OLD_SQLITE_NAME = 'bid-radar.sqlite';

/** 안내 한 줄을 남기고 종료한다 (키 값은 넣지 않는다) */
function fail(message) {
  logger.error(message);
  process.exit(1);
}

const isFile = (p) => existsSync(p) && statSync(p).isFile();
const sqliteFound = (file) =>
  `기존 SQLite 파일이 있습니다: ${file}. 먼저 node scripts/migrate-sqlite.mjs 로 옮긴 뒤 다시 시작해 주세요 (README 'SQLite 에서 Postgres 로 옮기기').`;

for (const key of ['APP_SECRET', 'APP_JOB_TOKEN']) {
  if (!env[key] || String(env[key]).trim() === '') {
    fail(`${key} 이 비어 있습니다. .env 에 긴 임의 문자열을 적은 뒤 다시 실행해 주세요.`);
  }
}

const port = env.APP_PORT === undefined || env.APP_PORT === '' ? 8820 : Number(env.APP_PORT);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  fail(`APP_PORT 가 올바르지 않습니다 (${env.APP_PORT}). 0~65535 사이 숫자로 적어 주세요.`);
}

// SUPABASE_URL 이 있으면 가입 모드. 키·공유 Postgres 주소가 비면 시작하지 않는다 (키 값은 출력하지 않는다)
if (String(env.SUPABASE_URL ?? '').trim() !== '') {
  for (const key of ['SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!env[key] || String(env[key]).trim() === '') {
      fail(`${key} 이 비어 있습니다. SUPABASE_URL 을 쓰려면 .env 에 이 값을 적은 뒤 다시 실행해 주세요.`);
    }
  }
  if (String(env.APP_DB_URL ?? '').trim() === '') {
    fail('APP_DB_URL 이 비어 있습니다. 가입 모드는 공유 Postgres 주소(app_worker 계정, 세션 모드 연결)가 필요합니다.');
  }
}
const platform = createPlatform({ env });

let handler;
let closeApp;
let stopWorker = async () => {};
if (!platform) {
  logger.info('MODE legacy');
  // 폐기된 APP_DB_PATH(SQLite 파일)·옛 기본 파일이 남아 있으면 옮기라고 안내하고 멈춘다
  const oldPath = String(env.APP_DB_PATH ?? '').trim();
  const dataDirEnv = String(env.APP_DATA_DIR ?? '').trim();
  const dataDir = dataDirEnv || 'data/pg';
  if (oldPath && isFile(oldPath)) fail(sqliteFound(oldPath));
  // 옛 기본 위치: 데이터 디렉토리 옆의 bid-radar.sqlite (예: data/bid-radar.sqlite). 새 디렉토리가 아직 없을 때만 본다
  const oldDefault = path.join(path.dirname(path.resolve(dataDir)), OLD_SQLITE_NAME);
  if (!oldPath && !existsSync(dataDir) && isFile(oldDefault)) fail(sqliteFound(oldDefault));
  if (oldPath) logger.warn('APP_DB_PATH 는 더 이상 쓰지 않습니다. 데이터 위치는 APP_DATA_DIR 로 정합니다.');
  let runtime;
  try {
    runtime = await createRuntime({
      dbPath: dataDir,
      secret: env.APP_SECRET,
      jobToken: env.APP_JOB_TOKEN,
      env,
    });
  } catch (err) {
    if (err && err.code === 'SQLITE_FILE_FOUND') fail(err.message);
    fail(`앱을 시작하지 못했습니다: ${err && err.message ? err.message : err}`);
  }
  // 요청 한 줄 로그 (가입 모드는 tenant 가 남긴다)
  handler = async (req) => {
    const start = Date.now();
    const given = req.headers.get('x-request-id');
    const requestId = given && REQUEST_ID_RE.test(given) ? given : randomUUID();
    const res = await runtime.router.fetch(req);
    try {
      res.headers.set('x-request-id', requestId);
    } catch {
      // 고칠 수 없는 헤더면 그대로 둔다
    }
    logRequest({ method: req.method, path: new URL(req.url).pathname, status: res.status, ms: Date.now() - start, requestId });
    return res;
  };
  closeApp = () => runtime.close();
} else {
  logger.info('MODE supabase');
  // 시작 점검: 연결·서비스 키·스키마. 일시 오류만 3초 간격 2회 다시 본다 (키 값은 출력하지 않는다)
  let check = await platform.preflight();
  for (let i = 0; !check.ok && check.retryable && i < 2; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    check = await platform.preflight();
  }
  if (!check.ok) fail(check.message);
  logger.info('PLATFORM ok');
  let app;
  try {
    app = await createApp({ env, platform, registerPlatformRoutes });
  } catch (err) {
    fail(`앱을 시작하지 못했습니다: ${err && err.message ? err.message : err}`);
  }
  handler = app.fetch;
  closeApp = () => app.close();
  stopWorker = () => app.stopWorker();
  app.startWorker();
}

const server = serve({ fetch: handler, port }, (info) => {
  logger.info(`LISTENING http://localhost:${info.port}`);
});

let stopping = false;
let finishing = false;
async function finish() {
  if (finishing) return;
  finishing = true;
  try {
    await closeApp();
  } catch (err) {
    logger.error({ code: err && err.code ? err.code : 'error' }, 'close failed');
  }
  process.exit(0);
}
function shutdown() {
  if (stopping) return;
  stopping = true;
  // 워커가 잡고 있는 작업을 먼저 끝내고(또는 되돌리고) 연결을 닫는다
  const workerDone = Promise.resolve()
    .then(() => stopWorker())
    .catch(() => {});
  server.close(() => {
    workerDone.then(finish);
  });
  setTimeout(finish, 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
