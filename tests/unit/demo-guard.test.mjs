// Demo guard (blocked actions list, 403 responses) and demo routes (/demo/login, /api/jobs/demo-reset).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { DEMO_BLOCKED, blockedResponse, isBlockedForDemo } from '../../app/core/demo/guard.mjs';
import { DEMO_TEXT } from '../../app/core/demo/fixture.mjs';
import { registerDemoRoutes } from '../../app/core/demo/routes.mjs';
import { demoEmails } from '../../app/core/demo/seed.mjs';
import { createFakePlatform } from './helpers/fake-platform.mjs';
import { registerRoutes as registerSettingsRoutes } from '../../app/modules/settings/routes.mjs';

const DEMO_WS = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** turn a pattern into a concrete path ('*' → a segment, trailing '/' → one more segment) */
const concrete = (p) => (p.endsWith('/') ? `${p}x` : p).replace('*', 'DEMO-001');

describe('isBlockedForDemo', () => {
  test('every DEMO_BLOCKED entry blocks its own path', () => {
    assert.ok(DEMO_BLOCKED.length >= 13);
    for (const [m, p] of DEMO_BLOCKED) assert.equal(isBlockedForDemo(m, concrete(p), {}), true, `${m} ${p}`);
  });

  test('prefix matches deeper paths, ignores query, method is case-insensitive', () => {
    assert.equal(isBlockedForDemo('POST', '/connections/NARA_API_KEY/check'), true);
    assert.equal(isBlockedForDemo('post', '/account/delete?x=1'), true);
    assert.equal(isBlockedForDemo('POST', '/sources/3/delete'), true);
    assert.equal(isBlockedForDemo('POST', '/summary/DEMO-002/run'), true);
  });

  test('reads and unrelated writes stay allowed', () => {
    assert.equal(isBlockedForDemo('GET', '/connections/x'), false);
    assert.equal(isBlockedForDemo('GET', '/account/password'), false);
    assert.equal(isBlockedForDemo('POST', '/connections'), false);
    assert.equal(isBlockedForDemo('POST', '/sourcesx'), false);
    assert.equal(isBlockedForDemo('POST', '/summary/DEMO-001'), false);
    assert.equal(isBlockedForDemo('POST', '/summary/run'), false);
    assert.equal(isBlockedForDemo('POST', '/interest/DEMO-001'), false);
    assert.equal(isBlockedForDemo('POST', '/assign/DEMO-001'), false);
    assert.equal(isBlockedForDemo('POST', '/today'), false);
  });

  test('card registration allowed only with a toss test client key', () => {
    assert.equal(isBlockedForDemo('POST', '/billing/card', {}), true);
    assert.equal(isBlockedForDemo('POST', '/billing/card', { TOSS_CLIENT_KEY: 'live_ck_abc' }), true);
    assert.equal(isBlockedForDemo('POST', '/billing/card', { TOSS_CLIENT_KEY: 'test_ck_abc' }), false);
    assert.equal(isBlockedForDemo('POST', '/billing/card/confirm', { TOSS_CLIENT_KEY: 'test_ck_abc' }), false);
    assert.equal(isBlockedForDemo('POST', '/account/delete', { TOSS_CLIENT_KEY: 'test_ck_abc' }), true);
  });

  test('plan change, cancel and resume are blocked even with a toss test client key', () => {
    for (const p of ['/billing/plan', '/billing/cancel', '/billing/resume']) {
      assert.equal(isBlockedForDemo('POST', p, {}), true, p);
      assert.equal(isBlockedForDemo('POST', p, { TOSS_CLIENT_KEY: 'test_ck_abc' }), true, p);
      assert.equal(isBlockedForDemo('GET', p, {}), false, p);
    }
    assert.equal(isBlockedForDemo('GET', '/billing', {}), false);
  });
});

describe('blockedResponse', () => {
  const req = (accept) => new Request('http://local/connections/x', { method: 'POST', headers: accept ? { accept } : {} });

  test('non-HTML request → 403 JSON demo_blocked', async () => {
    const res = blockedResponse(req('application/json'), null);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'demo_blocked' });
  });

  test('HTML request without html helper → 403 page with blocked text and signup link', async () => {
    const res = await blockedResponse(req('text/html,application/xhtml+xml'), null);
    assert.equal(res.status, 403);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const body = await res.text();
    assert.ok(body.includes(DEMO_TEXT.blocked));
    assert.ok(body.includes('href="/signup"'));
  });

  test('HTML request with html helper → rendered through html.page(403)', async () => {
    const seen = [];
    const html = {
      page: async (status, opts) => {
        seen.push({ status, opts });
        return new Response(`<main>${opts.body}</main>`, { status, headers: { 'content-type': 'text/html' } });
      },
      error: (m) => `<p role="alert">${m}</p>`,
    };
    const res = await blockedResponse(req('text/html'), html);
    assert.equal(res.status, 403);
    assert.equal(seen[0].status, 403);
    assert.ok((await res.text()).includes(DEMO_TEXT.blocked));
  });
});

function buildApp({ env = { APP_DEMO: '1', APP_SECRET: 's' }, workspaceId = DEMO_WS, budgetOk = true, signInOk = true } = {}) {
  const platform = createFakePlatform();
  const calls = { limiter: [], budget: [], reset: 0, signIn: [] };
  const signIn = platform.auth.signIn;
  platform.auth.signIn = async (args) => {
    calls.signIn.push(args);
    return signInOk ? signIn(args) : { ok: false, setCookies: [] };
  };
  const demo = {
    workspaceId: async () => workspaceId,
    reset: async () => {
      calls.reset += 1;
      return { ok: true, workspaceId: DEMO_WS, bids: 14, resetCount: calls.reset };
    },
  };
  const guard = {
    ipLimiter: (name) => async (c, next) => {
      calls.limiter.push(name);
      return next();
    },
  };
  const budget = {
    take: async (kind) => {
      calls.budget.push(kind);
      return { ok: budgetOk };
    },
  };
  const app = new Hono();
  registerDemoRoutes(app, {
    env,
    platform,
    demo,
    guard,
    budget,
    wsCookie: (id) => `ws=${id}; Path=/; HttpOnly; SameSite=Lax`,
    jobAuthorized: (req) => req.headers.get('x-job-token') === 'job-token',
  });
  return { app, calls };
}

const post = (app, p) => app.request(p, { method: 'POST' });

describe('registerDemoRoutes', () => {
  test('APP_DEMO off → both routes 404 not_found, no limiter or reset', async () => {
    const { app, calls } = buildApp({ env: { APP_SECRET: 's' } });
    const a = await post(app, '/demo/login');
    assert.equal(a.status, 404);
    assert.deepEqual(await a.json(), { error: 'not_found' });
    const b = await app.request('/api/jobs/demo-reset', { headers: { 'x-job-token': 'job-token' } });
    assert.equal(b.status, 404);
    assert.deepEqual(await b.json(), { error: 'not_found' });
    assert.equal(calls.limiter.length, 0);
    assert.equal(calls.reset, 0);
  });

  test('demo-reset needs the job token, then returns reset JSON', async () => {
    const { app, calls } = buildApp();
    const no = await app.request('/api/jobs/demo-reset');
    assert.equal(no.status, 403);
    assert.deepEqual(await no.json(), { error: 'forbidden' });
    assert.equal(calls.reset, 0);
    const ok = await app.request('/api/jobs/demo-reset', { headers: { 'x-job-token': 'job-token' } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, workspaceId: DEMO_WS, bids: 14, resetCount: 1 });
  });

  test('login signs in as the demo owner and lands on /today with session + workspace cookies', async () => {
    const { app, calls } = buildApp();
    const res = await post(app, '/demo/login');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/today');
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => c.startsWith('fake-user=demo-owner')));
    assert.ok(cookies.some((c) => c.startsWith(`ws=${DEMO_WS}`)));
    assert.deepEqual(calls.limiter, ['demoLogin']);
    assert.deepEqual(calls.budget, ['demoLogin']);
    assert.equal(calls.signIn[0].email, demoEmails({}).owner);
    assert.equal(typeof calls.signIn[0].password, 'string');
    assert.ok(!(await res.text()).includes(calls.signIn[0].password));
  });

  test('login over daily budget → 429 closed page, no sign-in', async () => {
    const { app, calls } = buildApp({ budgetOk: false });
    const res = await post(app, '/demo/login');
    assert.equal(res.status, 429);
    assert.ok((await res.text()).includes(DEMO_TEXT.closed));
    assert.equal(calls.signIn.length, 0);
  });

  test('login before the demo exists (or sign-in fails) → 503 preparing page', async () => {
    const a = buildApp({ workspaceId: null });
    const r1 = await post(a.app, '/demo/login');
    assert.equal(r1.status, 503);
    assert.ok((await r1.text()).includes(DEMO_TEXT.preparing));
    assert.equal(a.calls.signIn.length, 0);
    const b = buildApp({ signInOk: false });
    const r2 = await post(b.app, '/demo/login');
    assert.equal(r2.status, 503);
    assert.equal(r2.headers.getSetCookie().length, 0);
  });
});

describe('settings in the example company', () => {
  /** settings 라우트를 가짜 ctx 로 등록하고 POST /settings 핸들러를 돌려준다 */
  function setup({ demo }) {
    const store = new Map([
      ['notify_webhook_url', ''],
      ['notify_emails', ''],
    ]);
    const saved = [];
    const handlers = {};
    const ctx = {
      demo: demo ? { enabled: true } : null,
      env: {},
      settings: {
        async get(k) {
          return store.get(k) ?? null;
        },
        async set(k, v) {
          store.set(k, v);
        },
      },
      criteria: {
        async get() {
          return { keywords: ['조경'], regions: [], excludeKeywords: [], budgetMin: null, budgetMax: null, maxItems: 5 };
        },
        validate() {
          return [];
        },
        async set(next) {
          saved.push(next);
          return [];
        },
      },
      auth: { required: (fn) => (req, params, c) => fn(req, params, c, { role: 'owner' }) },
      html: {
        redirect: (to) => new Response(null, { status: 303, headers: { location: to } }),
        page: async (status, opts) => new Response(String(opts.body ?? ''), { status, headers: { 'content-type': 'text/html' } }),
        error: (m) => `<p role="alert">${m}</p>`,
      },
    };
    const router = {
      get(path, h) {
        handlers[`GET ${path}`] = h;
      },
      post(path, h) {
        handlers[`POST ${path}`] = h;
      },
    };
    registerSettingsRoutes(router, ctx);
    const post = (form, accept = 'application/json') =>
      handlers['POST /settings'](new Request('http://local/settings', { method: 'POST', headers: { accept }, body: new URLSearchParams(form) }), {}, ctx);
    return { store, saved, post };
  }

  const base = { keywords: '조경, 수목', regions: '', excludeKeywords: '', budgetMin: '', budgetMax: '' };

  test('changing the webhook address is refused with 403 and nothing is saved', async () => {
    const t = setup({ demo: true });
    const res = await t.post({ ...base, webhookUrl: 'https://example.com/hook', notifyEmails: '' });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'demo_blocked' });
    assert.equal(t.store.get('notify_webhook_url'), '');
    assert.equal(t.saved.length, 0);
  });

  test('changing the notification emails is refused (html page shows the blocked text)', async () => {
    const t = setup({ demo: true });
    const res = await t.post({ ...base, webhookUrl: '', notifyEmails: 'someone@example.com' }, 'text/html');
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes(DEMO_TEXT.blocked));
    assert.equal(t.store.get('notify_emails'), '');
    assert.equal(t.saved.length, 0);
  });

  test('keyword changes with the same (empty) addresses still save', async () => {
    const t = setup({ demo: true });
    const res = await t.post({ ...base, webhookUrl: '', notifyEmails: '' });
    assert.equal(res.status, 303);
    assert.equal(t.saved.length, 1);
    assert.deepEqual(t.saved[0].keywords, ['조경', '수목']);
  });

  test('outside the example company the addresses save as before', async () => {
    const t = setup({ demo: false });
    const res = await t.post({ ...base, webhookUrl: 'https://example.com/hook', notifyEmails: 'someone@example.com' });
    assert.equal(res.status, 303);
    assert.equal(t.store.get('notify_webhook_url'), 'https://example.com/hook');
    assert.equal(t.store.get('notify_emails'), 'someone@example.com');
  });
});
