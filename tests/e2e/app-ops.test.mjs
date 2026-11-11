import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';
import { startApp, setupOwner, shot } from './helpers/app.mjs';
import { skipIfDown, startSbApp } from './helpers/supabase.mjs';

// 운영: /healthz /readyz, 구조화 로그(request 줄), 프록시 홉에 따른 속도 제한
let browser;
const cleanups = [];

/** stdout 의 JSON 줄만 파싱한다 */
function jsonLines(text) {
  return text
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));
}

async function until(cond, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function loginAs(app, xff) {
  const res = await fetch(`${app.baseUrl}/login`, {
    method: 'POST',
    body: new URLSearchParams({ email: `e2e-rl-${randomBytes(4).toString('hex')}@example.com`, password: 'wrong-password' }),
    headers: { origin: new URL(app.baseUrl).origin, 'x-forwarded-for': xff },
    redirect: 'manual',
  });
  await res.arrayBuffer();
  return res.status;
}

describe('app ops', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('ops: healthz and readyz answer and every request leaves a json log line', { timeout: 120000 }, async () => {
    const app = await startApp();
    cleanups.push(() => app.stop());
    const { cookie } = await setupOwner(app.baseUrl);

    const health = await fetch(`${app.baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, 'ok');

    const ready = await fetch(`${app.baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal(ready.headers.get('cache-control'), 'no-store');
    const body = await ready.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.mode, 'legacy');
    assert.equal(body.checks.db.ok, true);
    assert.equal(typeof body.checks.db.ms, 'number');
    assert.equal(body.checks.queue, undefined, 'legacy mode only checks the database');

    const context = await browser.newContext({ viewport: { width: 900, height: 500 } });
    cleanups.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${app.baseUrl}/readyz`);
    assert.match(await page.locator('body').innerText(), /"status":\s*"ok"/);
    await shot(page, 'readyz');

    // 요청 한 줄: 쿠키 값과 초대 토큰은 남지 않는다
    const probe = 'probe-token-91c4';
    await fetch(`${app.baseUrl}/today`, { headers: { cookie }, redirect: 'manual' });
    await fetch(`${app.baseUrl}/join/${probe}`, { redirect: 'manual' });
    await until(() => jsonLines(app.stdout()).some((l) => l.msg === 'request' && l.path === '/today'), 'request log for /today');
    const lines = jsonLines(app.stdout());
    const req = lines.find((l) => l.msg === 'request' && l.path === '/today');
    assert.equal(req.method, 'GET');
    assert.equal(typeof req.status, 'number');
    assert.equal(typeof req.ms, 'number');
    assert.ok(req.requestId, 'request id');
    assert.ok(lines.some((l) => l.msg === 'request' && l.path === '/join/:token'), 'invite path is masked');
    assert.ok(!app.stdout().includes(probe), 'invite token never reaches the log');
    assert.ok(!app.stdout().includes(cookie.split('=')[1]), 'session cookie never reaches the log');
    assert.ok(app.stdout().includes('"msg":"request"'));
  });

  it('ops: unknown route and bad job token are logged with their status', { timeout: 120000 }, async () => {
    const app = await startApp();
    cleanups.push(() => app.stop());
    const missing = await fetch(`${app.baseUrl}/no-such-page`, { redirect: 'manual' });
    assert.ok(missing.status === 404 || missing.status === 303, `unknown route ${missing.status}`);
    const job = await fetch(`${app.baseUrl}/api/jobs/daily`, { headers: { 'x-job-token': 'wrong' } });
    assert.equal(job.status, 403);
    await until(() => jsonLines(app.stdout()).some((l) => l.msg === 'request' && l.path === '/api/jobs/daily'), 'job request log');
    const line = jsonLines(app.stdout()).find((l) => l.msg === 'request' && l.path === '/api/jobs/daily');
    assert.equal(line.status, 403);
  });

  it('ops: supabase readyz has db queue auth and the rate limit follows the proxy hop', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startSbApp({ env: { APP_TRUST_PROXY: '1', APP_WORKER: '0' } });
    cleanups.push(() => app.stop());

    const ready = await fetch(`${app.baseUrl}/readyz`);
    assert.equal(ready.status, 200);
    const body = await ready.json();
    assert.equal(body.mode, 'supabase');
    for (const k of ['db', 'queue', 'auth']) assert.equal(body.checks[k].ok, true, `${k} ok`);
    assert.equal((await fetch(`${app.baseUrl}/healthz`)).status, 200);

    // 홉 1: 마지막 값(프록시가 붙인 주소)이 열쇠다. 앞쪽 값을 바꿔도 한도는 그대로
    const tag = randomBytes(4).toString('hex');
    const client = `client-${tag}-a`;
    const statuses = [];
    for (let i = 0; i < 10; i += 1) statuses.push(await loginAs(app, `spoof-${i}, ${client}`));
    assert.ok(statuses.every((s) => s !== 429), `first 10 are handled (${statuses.join(',')})`);
    assert.equal(await loginAs(app, `spoof-new, ${client}`), 429, '11th from the same last hop is limited');
    // 다른 프록시 뒤 주소는 따로 센다
    assert.notEqual(await loginAs(app, `spoof-new, client-${tag}-b`), 429, 'another last hop is not limited');
  });
});
