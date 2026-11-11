// App E2E helpers.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const JOB_TOKEN = 'e2e-job';
const START_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 5000;

export const NARA_FIXTURE = 'tests/fixtures/nara-bids.json';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Supabase mode: app_worker URL for the local stack. Takes DB_URL from `supabase status -o env`
 * and swaps only the user and password (local seed sets app_worker's password). null if the stack is down.
 * @returns {string|null}
 */
function localAppDbUrl() {
  const r = spawnSync('supabase', ['status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return null;
  const m = /^DB_URL="?([^"\n]+)"?$/m.exec(r.stdout);
  if (!m) return null;
  const u = new URL(m[1]);
  u.username = 'app_worker';
  u.password = 'app_worker';
  return u.toString();
}

/**
 * Spawn `node app/server.mjs` on a free port with a temp PGlite data dir (APP_DATA_DIR).
 * APP_PORT and APP_BASE_URL are both set so links in notifications point at the real address.
 * APP_FETCH_ALLOW_HOSTS=localhost lets the app reach the local mock servers; pass '' to test SSRF blocking.
 * @param {{ env?: Record<string,string> }} [opts]
 * @returns {Promise<{ baseUrl: string, dataDir: string, dbPath: string, stdout(): string, stop(): Promise<void> }>}
 *   dbPath is the same as dataDir (kept for older callers).
 */
export async function startApp({ env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'br-e2e-'));
  const dataDir = path.join(dir, 'pg');
  const port = env.APP_PORT !== undefined ? Number(env.APP_PORT) : await freePort();
  // Supabase mode: shared Postgres as app_worker, and the local mock servers are on localhost
  const sbMode = String(env.SUPABASE_URL ?? process.env.SUPABASE_URL ?? '').trim() !== '';
  const sbEnv = {};
  if (sbMode && !env.APP_DB_URL) {
    const url = localAppDbUrl();
    if (url) sbEnv.APP_DB_URL = url;
  }
  const childEnv = {
    ...process.env,
    APP_PORT: String(port),
    APP_BASE_URL: `http://localhost:${port}`,
    APP_DATA_DIR: dataDir,
    APP_FETCH_ALLOW_HOSTS: 'localhost',
    APP_SECRET: 'e2e-secret',
    APP_JOB_TOKEN: JOB_TOKEN,
    APP_FAKE_NOW: '2026-10-29',
    ...sbEnv,
    ...env,
  };
  const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', 'app/server.mjs'], {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c;
  });
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  let baseUrl;
  try {
    baseUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`app did not start within ${START_TIMEOUT_MS}ms\nstderr:\n${stderr}\nstdout:\n${stdout}`)), START_TIMEOUT_MS);
      child.stdout.on('data', (c) => {
        stdout += c;
        const m = /LISTENING (http:\/\/localhost:\d+)/.exec(stdout);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      exited.then(({ code, signal }) => {
        clearTimeout(timer);
        reject(new Error(`app exited before listening (code=${code}, signal=${signal})\nstderr:\n${stderr}\nstdout:\n${stdout}`));
      });
    });
  } catch (err) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  // keep draining output so the child never blocks on a full pipe
  child.stdout.on('data', () => {});

  let stopped = null;
  async function stop() {
    if (stopped) return stopped;
    stopped = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), STOP_TIMEOUT_MS);
        await exited;
        clearTimeout(timer);
      }
      rmSync(dir, { recursive: true, force: true });
    })();
    return stopped;
  }

  return { baseUrl, dataDir, dbPath: dataDir, stdout: () => stdout, stop };
}

/**
 * POST /setup and return the session cookie of the new owner.
 * @returns {Promise<{ cookie: string, memberId: number }>}
 */
export async function setupOwner(baseUrl, { company = '테스트 조경', name = '대표' } = {}) {
  const res = await fetch(`${baseUrl}/setup`, {
    method: 'POST',
    body: new URLSearchParams({ company, name }),
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  if (res.status !== 303 || !cookie.startsWith('br_session=')) {
    throw new Error(`setupOwner failed: status ${res.status}, set-cookie '${setCookie}'`);
  }
  const memberId = Number(cookie.slice('br_session='.length).split('.')[0]);
  return { cookie, memberId };
}

/**
 * New Playwright context + page with the session cookie set.
 * @param {import('playwright').Browser} browser
 * @returns {Promise<{ context: import('playwright').BrowserContext, page: import('playwright').Page }>}
 */
export async function openAs(browser, baseUrl, cookie) {
  const context = await browser.newContext();
  if (cookie) {
    const raw = String(cookie).split(';')[0];
    const i = raw.indexOf('=');
    await context.addCookies([{ name: raw.slice(0, i), value: raw.slice(i + 1), url: baseUrl, httpOnly: true, sameSite: 'Lax' }]);
  }
  const page = await context.newPage();
  return { context, page };
}

/**
 * Call GET /api/jobs/<name> with the job token.
 * @returns {Promise<{ status: number, body: object|null }>}
 */
export async function runJob(baseUrl, name, { date = '2026-10-29', dry = false } = {}) {
  const q = new URLSearchParams({ date });
  if (dry) q.set('dry', '1');
  const res = await fetch(`${baseUrl}/api/jobs/${name}?${q}`, { headers: { 'x-job-token': JOB_TOKEN } });
  const text = await res.text();
  let body = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

/** Full-page screenshot into ILLY_SHOT_DIR (default tests/e2e/screenshots). */
export function shot(page, name) {
  const dir = process.env.ILLY_SHOT_DIR ?? 'tests/e2e/screenshots';
  mkdirSync(dir, { recursive: true });
  return page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}
