import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { openDb } from '../../app/core/db.mjs';
import { RATE_RULES, GUARD_TEXT, matchRule, createHttpGuard } from '../../app/core/http-guard.mjs';
import { startMockTurnstile } from './helpers/mock-turnstile.mjs';

// supabase/migrations 의 rate_limits 와 같은 모양
const RATE_TABLE = 'CREATE TABLE IF NOT EXISTS rate_limits (key text primary key, hits integer not null, reset_at timestamptz not null)';
const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const WS2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (app, p, init = {}) => app.request(p, { method: 'POST', ...init });

describe('http-guard: rule table and matchRule', () => {
  test('http-guard: seven rules with the agreed limits and keys', () => {
    assert.deepEqual(Object.keys(RATE_RULES).sort(), ['auth', 'check', 'collect', 'demoLogin', 'invite', 'jobs', 'llm']);
    assert.equal(RATE_RULES.auth.limit, 10);
    assert.equal(RATE_RULES.demoLogin.limit, 20);
    assert.equal(RATE_RULES.jobs.limit, 60);
    assert.equal(RATE_RULES.llm.limit, 30);
    assert.equal(RATE_RULES.check.limit, 10);
    assert.equal(RATE_RULES.collect.limit, 6);
    assert.equal(RATE_RULES.invite.limit, 10);
    assert.equal(GUARD_TEXT.tooMany(15), '너무 여러 번 요청했습니다. 15분 뒤 다시 시도해 주세요.');
  });

  test('http-guard: matchRule maps workspace paths, POST only', () => {
    assert.equal(matchRule('POST', '/today/run', 'workspace'), 'collect');
    assert.equal(matchRule('GET', '/today/run', 'workspace'), null);
    assert.equal(matchRule('POST', '/summary/B-123/run', 'workspace'), 'llm');
    assert.equal(matchRule('POST', '/summary/B-123/x/run', 'workspace'), null);
    assert.equal(matchRule('POST', '/keywords/suggest', 'workspace'), 'llm');
    assert.equal(matchRule('POST', '/company/verdict', 'workspace'), 'llm');
    assert.equal(matchRule('POST', '/connections/nara/check', 'workspace'), 'check');
    assert.equal(matchRule('POST', '/assign/members', 'workspace'), 'invite');
    assert.equal(matchRule('POST', '/interest', 'workspace'), null);
    // ip 규칙은 workspace 키로 찾지 않는다
    assert.equal(matchRule('POST', '/login', 'workspace'), null);
  });

  test('http-guard: matchRule ip rules; jobs counts GET too', () => {
    assert.equal(matchRule('POST', '/login', 'ip'), 'auth');
    assert.equal(matchRule('POST', '/join/abc', 'ip'), 'auth');
    assert.equal(matchRule('POST', '/account/delete', 'ip'), 'auth');
    assert.equal(matchRule('GET', '/login', 'ip'), null);
    assert.equal(matchRule('POST', '/demo/login', 'ip'), 'demoLogin');
    assert.equal(matchRule('GET', '/api/jobs/daily', 'ip'), 'jobs');
    assert.equal(matchRule('POST', '/api/jobs/billing', 'ip'), 'jobs');
    assert.equal(matchRule('POST', '/today/run', 'ip'), null);
  });
});

describe('http-guard: limits on postgres store', () => {
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

  // 배선과 같은 모양: 회사 규칙에 걸리면 429 + Retry-After
  function workspaceApp(guard, ws) {
    const app = new Hono();
    app.all('*', async (c) => {
      const rule = matchRule(c.req.method, c.req.path, 'workspace');
      if (rule) {
        const r = await guard.hitWorkspace(ws, rule);
        if (!r.ok) return c.text(GUARD_TEXT.tooMany(Math.ceil(r.retryAfterSec / 60)), 429, { 'Retry-After': String(r.retryAfterSec) });
      }
      return c.text('ok');
    });
    return app;
  }

  test('http-guard: 7th collect in an hour → 429 with Retry-After; other workspace unaffected', async () => {
    const guard = createHttpGuard({ db, env: {} });
    const app = workspaceApp(guard, WS);
    for (let i = 0; i < 6; i += 1) assert.equal((await post(app, '/today/run')).status, 200, `hit ${i + 1}`);
    const res = await post(app, '/today/run');
    assert.equal(res.status, 429);
    const retry = Number(res.headers.get('retry-after'));
    assert.ok(retry > 0 && retry <= 3600, `retry-after ${retry}`);
    assert.match(await res.text(), /분 뒤 다시 시도해 주세요/);
    assert.equal((await post(workspaceApp(guard, WS2), '/today/run')).status, 200);
  });

  test('http-guard: hitWorkspace returns ok/retryAfterSec; key is hashed', async () => {
    const guard = createHttpGuard({ db, env: {} });
    for (let i = 0; i < 10; i += 1) assert.deepEqual(await guard.hitWorkspace(WS, 'check'), { ok: true, retryAfterSec: 0 });
    const r = await guard.hitWorkspace(WS, 'check');
    assert.equal(r.ok, false);
    assert.ok(r.retryAfterSec > 3500 && r.retryAfterSec <= 3600);
    const rows = (await db.admin("SELECT count(*)::integer AS n FROM rate_limits WHERE key LIKE '%check%' OR key LIKE '%aaaa%'")).rows;
    assert.equal(rows[0].n, 0);
  });

  test('http-guard: APP_RATE_SCALE=2 → 12th login passes, 21st → 429', async () => {
    const guard = createHttpGuard({ db, env: { APP_RATE_SCALE: '2' } });
    const app = new Hono();
    app.use('/login', guard.ipLimiter('auth'));
    app.post('/login', (c) => c.text('ok'));
    app.get('/login', (c) => c.text('form'));
    for (let i = 0; i < 20; i += 1) assert.equal((await post(app, '/login')).status, 200, `hit ${i + 1}`);
    // GET 은 세지 않는다
    assert.equal((await app.request('/login')).status, 200);
    const res = await post(app, '/login');
    assert.equal(res.status, 429);
    assert.ok(res.headers.get('retry-after'));
    assert.equal(await res.text(), GUARD_TEXT.tooMany(15));
  });

  test('http-guard: ipLimiter rules keep separate counts; jobs counts GET', async () => {
    const guard = createHttpGuard({ db, env: { APP_RATE_SCALE: '0.1' } });
    const app = new Hono();
    app.use('/login', guard.ipLimiter('auth'));
    app.use('/demo/login', guard.ipLimiter('demoLogin'));
    app.use('/api/jobs/*', guard.ipLimiter('jobs'));
    app.post('/login', (c) => c.text('ok'));
    app.post('/demo/login', (c) => c.text('ok'));
    app.get('/api/jobs/daily', (c) => c.text('ok'));
    // scale 0.1: auth 1, demoLogin 2, jobs 6
    assert.equal((await post(app, '/login')).status, 200);
    assert.equal((await post(app, '/login')).status, 429);
    assert.equal((await post(app, '/demo/login')).status, 200);
    assert.equal((await post(app, '/demo/login')).status, 200);
    assert.equal((await post(app, '/demo/login')).status, 429);
    for (let i = 0; i < 6; i += 1) assert.equal((await app.request('/api/jobs/daily')).status, 200);
    assert.equal((await app.request('/api/jobs/daily')).status, 429);
    assert.throws(() => guard.ipLimiter('collect'), /not an ip rule/);
    assert.throws(() => guard.ipLimiter('nope'), /unknown rate rule/);
  });

  test('http-guard: jobs rule skips calls with the right x-job-token; counts missing or wrong token', async () => {
    const guard = createHttpGuard({ db, env: { APP_RATE_SCALE: '0.1', APP_JOB_TOKEN: 'job-token-1' } });
    const app = new Hono();
    app.use('/api/jobs/*', guard.ipLimiter('jobs'));
    app.get('/api/jobs/daily', (c) => c.text('ok'));
    const call = (token) => app.request('/api/jobs/daily', token === undefined ? {} : { headers: { 'x-job-token': token } });
    // scale 0.1: jobs 6
    for (let i = 0; i < 6 + 5; i += 1) assert.equal((await call('job-token-1')).status, 200);
    for (let i = 0; i < 3; i += 1) assert.equal((await call('wrong-token')).status, 200);
    for (let i = 0; i < 3; i += 1) assert.equal((await call(undefined)).status, 200);
    assert.equal((await call('wrong-token')).status, 429);
    assert.equal((await call('job-token-')).status, 429);
    assert.equal((await call('job-token-1')).status, 200);
  });

  test('http-guard: jobs rule counts every call when APP_JOB_TOKEN is not set', async () => {
    const guard = createHttpGuard({ db, env: { APP_RATE_SCALE: '0.1' } });
    const app = new Hono();
    app.use('/api/jobs/*', guard.ipLimiter('jobs'));
    app.get('/api/jobs/daily', (c) => c.text('ok'));
    for (let i = 0; i < 6; i += 1) assert.equal((await app.request('/api/jobs/daily', { headers: { 'x-job-token': '' } })).status, 200);
    assert.equal((await app.request('/api/jobs/daily', { headers: { 'x-job-token': '' } })).status, 429);
  });
});

describe('http-guard: body limit and timeout', () => {
  const guard = (env = {}) => createHttpGuard({ db: { admin: async () => ({ rows: [] }) }, env });

  test('http-guard: 300KiB body → 413 with the agreed text; small body passes', async () => {
    const app = new Hono();
    app.use('*', guard().bodyLimit());
    app.post('/x', async (c) => c.text(String((await c.req.text()).length)));
    const big = 'a'.repeat(300 * 1024);
    const res = await post(app, '/x', { body: big, headers: { 'content-type': 'text/plain' } });
    assert.equal(res.status, 413);
    assert.equal(await res.text(), GUARD_TEXT.tooLarge);
    const ok = await post(app, '/x', { body: 'a'.repeat(1000), headers: { 'content-type': 'text/plain' } });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '1000');
  });

  test('http-guard: 300KiB streamed body without content-length → 413', async () => {
    const app = new Hono();
    app.use('*', guard().bodyLimit());
    app.post('/x', (c) => c.text('ok'));
    const chunk = new TextEncoder().encode('b'.repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream({
      pull(ctrl) {
        if (sent >= 5) return ctrl.close();
        sent += 1;
        ctrl.enqueue(chunk);
      },
    });
    const res = await app.request(new Request('http://localhost/x', { method: 'POST', body, duplex: 'half' }));
    assert.equal(res.status, 413);
  });

  test('http-guard: APP_BODY_LIMIT_BYTES lowers the limit', async () => {
    const app = new Hono();
    app.use('*', guard({ APP_BODY_LIMIT_BYTES: '100' }).bodyLimit());
    app.post('/x', (c) => c.text('ok'));
    assert.equal((await post(app, '/x', { body: 'a'.repeat(101) })).status, 413);
    assert.equal((await post(app, '/x', { body: 'a'.repeat(100) })).status, 200);
  });

  test('http-guard: slow handler → 504 with the agreed text; fast handler passes', async () => {
    const app = new Hono();
    app.use('*', guard({ APP_REQUEST_TIMEOUT_MS: '50' }).timeout());
    app.get('/slow', async (c) => {
      await sleep(300);
      return c.text('late');
    });
    app.get('/fast', (c) => c.text('ok'));
    const res = await app.request('/slow');
    assert.equal(res.status, 504);
    assert.equal(await res.text(), GUARD_TEXT.timeout);
    assert.equal((await app.request('/fast')).status, 200);
  });
});

describe('http-guard: turnstile', () => {
  let mock;
  const db = { admin: async () => ({ rows: [] }) };
  before(async () => {
    mock = await startMockTurnstile();
  });
  after(async () => {
    await mock.close();
  });
  beforeEach(() => {
    mock.requests.length = 0;
    mock.success = true;
    mock.status = 200;
    mock.delayMs = 0;
  });
  const on = (extra = {}) =>
    createHttpGuard({ db, env: { TURNSTILE_SITE_KEY: 'site-key-1', TURNSTILE_SECRET_KEY: 'secret-1', TURNSTILE_VERIFY_URL: mock.url, ...extra }, fetch });

  test('http-guard: turnstile off without both keys → no widget, no CSP extras, verify makes no request', async () => {
    for (const env of [{}, { TURNSTILE_SITE_KEY: 'site-key-1' }, { TURNSTILE_SECRET_KEY: 'secret-1', TURNSTILE_VERIFY_URL: mock.url }]) {
      const g = createHttpGuard({ db, env: { TURNSTILE_VERIFY_URL: mock.url, ...env }, fetch });
      assert.equal(g.turnstile.enabled, false);
      assert.equal(g.turnstile.widgetHtml(), '');
      assert.deepEqual(g.cspExtras(), { scriptSrc: [], frameSrc: [], connectSrc: [] });
      assert.equal(await g.turnstile.verify('tok', 'client-ip'), true);
    }
    assert.equal(mock.requests.length, 0);
  });

  test('http-guard: turnstile on → widget with site key, CSP extras, verify posts form', async () => {
    const g = on();
    assert.equal(g.turnstile.enabled, true);
    assert.equal(g.turnstile.siteKey, 'site-key-1');
    assert.equal(g.turnstile.scriptSrc, 'https://challenges.cloudflare.com/turnstile/v0/api.js');
    assert.match(g.turnstile.widgetHtml(), /class="cf-turnstile" data-sitekey="site-key-1"/);
    assert.deepEqual(g.cspExtras(), {
      scriptSrc: ['https://challenges.cloudflare.com'],
      frameSrc: ['https://challenges.cloudflare.com'],
      connectSrc: ['https://challenges.cloudflare.com'],
    });
    assert.equal(await g.turnstile.verify('tok-1', 'client-ip'), true);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].method, 'POST');
    assert.deepEqual(mock.requests[0].form, { secret: 'secret-1', response: 'tok-1', remoteip: 'client-ip' });
  });

  test('http-guard: mock verify success:false → false; empty token → false without request', async () => {
    const g = on();
    mock.success = false;
    assert.equal(await g.turnstile.verify('tok-bad', 'client-ip'), false);
    assert.equal(mock.requests.length, 1);
    assert.equal(await g.turnstile.verify('', 'client-ip'), false);
    assert.equal(mock.requests.length, 1);
  });

  test('http-guard: verify HTTP error or network failure → false', async () => {
    mock.status = 500;
    assert.equal(await on().turnstile.verify('tok', null), false);
    const broken = createHttpGuard({
      db,
      env: { TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's', TURNSTILE_VERIFY_URL: mock.url },
      fetch: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(await broken.turnstile.verify('tok', null), false);
  });
});
