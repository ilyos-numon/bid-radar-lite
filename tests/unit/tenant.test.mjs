import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from '../../app/core/tenant.mjs';
import { createFakePlatform, createTestDb, WS_A, WS_B } from './helpers/fake-platform.mjs';
import { DEMO_TEXT } from '../../app/core/demo/fixture.mjs';
import { esc } from '../../app/core/html.mjs';

const BASE = 'http://localhost:8820';
const tmpRoots = [];
const apps = [];
const dbs = [];
const tick = () => new Promise((r) => setImmediate(r));

after(async () => {
  await Promise.all(apps.map((a) => a.close()));
  await Promise.all(dbs.map((d) => d.close()));
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

function makeDir(files) {
  const root = tmp('br-tenant-');
  for (const [rel, src] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return root;
}

const modulesDir = () =>
  makeDir({
    'today/manifest.mjs': `export default {
  id: 'today', title: '오늘의 공고', group: '매일', order: 10, path: '/today', help: '도움말',
  routes(router, ctx) {
    router.get('/today', (req, params, c, member) => Response.json({ member, workspace: c.keys.workspaceId, nara: c.env.NARA_API_KEY }));
    router.post('/today/echo', () => new Response('ok'));
    router.get('/today/slow', async () => {
      globalThis.__brSlowEntered = true;
      await globalThis.__brSlow;
      return new Response('slow');
    });
    router.post('/today/invite', async (req, params, c) => {
      const { member } = await c.members.create({ name: '박직원' });
      return Response.json({ id: member.id });
    });
    router.post('/today/remove', async (req, params, c) => {
      const id = Number(new URL(req.url).searchParams.get('id'));
      try {
        return Response.json({ ok: await c.members.remove(id) });
      } catch (err) {
        return Response.json({ error: err.code }, { status: 400 });
      }
    });
  },
};
`,
  });

const realJobs = pathToFileURL(path.resolve('app/core/routes-jobs.mjs')).href;
const realNotify = pathToFileURL(path.resolve('app/core/notify.mjs')).href;
const coreDir = () =>
  makeDir({
    'routes-jobs.mjs': `export { registerRoutes } from ${JSON.stringify(realJobs)};`,
    'notify.mjs': `export { create } from ${JSON.stringify(realNotify)};`,
    'jobs.mjs': `export function create(ctx) { return { jobs: {
      async runDaily({ date }) { return { kind: 'daily', date, count: 0 }; },
      async runReminders({ date }) { const n = Number((await ctx.settings.get('n')) ?? 0); return { kind: 'reminders', date, count: n }; },
      async runSupport() { return null; },
    } }; }`,
  });

/** 메모리 배열 큐 (보이지 않는 시간 없이 바로 다시 읽힌다) */
function fakeQueue() {
  let seq = 0n;
  const items = [];
  const acked = [];
  const archived = [];
  const take = (list, id) => {
    const i = items.findIndex((x) => x.msgId === id);
    if (i >= 0) list.push(...items.splice(i, 1));
  };
  return {
    items,
    acked,
    archived,
    async enqueue(msgs) {
      for (const m of msgs) items.push({ msgId: ++seq, readCt: 0, inFlight: false, message: structuredClone(m) });
      return msgs.length;
    },
    async read({ qty }) {
      const out = [];
      for (const it of items) {
        if (out.length >= qty) break;
        it.readCt += 1;
        out.push({ msgId: it.msgId, readCt: it.readCt, message: structuredClone(it.message) });
      }
      return out;
    },
    async ack(id) {
      take(acked, id);
    },
    async archive(id) {
      take(archived, id);
    },
    async depth() {
      return items.length;
    },
  };
}

/** 로그 줄(process.stdout) 을 잡아 둔다. 원래 출력도 그대로 보낸다 */
async function captureStdout(fn) {
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
  return lines;
}

const jsonLines = (lines) =>
  lines
    .flatMap((l) => l.split('\n'))
    .filter((l) => l.startsWith('{'))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

async function waitFor(cond, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor timed out');
}

async function makeApp({ env = {}, seed, fetchImpl = async () => new Response('{}'), queue, modules, billingVault } = {}) {
  const platform = createFakePlatform(seed);
  const wsDir = tmp('br-ws-');
  const db = await createTestDb();
  dbs.push(db);
  // supabase/migrations 의 rate_limits 와 같은 모양 (속도 제한 공유 저장소)
  await db.admin('CREATE TABLE IF NOT EXISTS rate_limits (key text primary key, hits integer not null, reset_at timestamptz not null)');
  await platform.useDb(db);
  const app = await createApp({
    env: { APP_SECRET: 's', APP_JOB_TOKEN: 'jt', APP_BASE_URL: BASE, APP_WS_DIR: wsDir, APP_SHARED_KEYS: '0', ...env },
    platform,
    db,
    queue,
    fetchImpl,
    modulesDir: modules ?? modulesDir(),
    coreDir: coreDir(),
    billingVault,
  });
  apps.push(app);
  return { app, platform, wsDir, db };
}

function call(app, url, { user, cookie = '', method = 'GET', origin, form, headers = {} } = {}) {
  const h = new Headers(headers);
  const cookies = [cookie, user ? `fake-user=${user}` : ''].filter(Boolean).join('; ');
  if (cookies) h.set('cookie', cookies);
  if (origin) h.set('origin', origin);
  const init = { method, headers: h, redirect: 'manual' };
  if (form) init.body = new URLSearchParams(form);
  return app.fetch(new Request(BASE + url, init));
}

describe('tenant: security and session', () => {
  test('tenant: anonymous GET redirects to /welcome', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/today', { cookie: 'fake-refresh=1' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/welcome');
    assert.match(res.headers.get('set-cookie') ?? '', /sb-fake-auth-token=refreshed/);
  });

  test('tenant: anonymous POST is 403', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/today/echo', { method: 'POST', origin: BASE, form: { a: '1' } });
    assert.equal(res.status, 403);
  });

  test('tenant: cross-site form post is rejected 403', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/today/echo', { user: 'user-a', method: 'POST', origin: 'http://evil.example', form: { a: '1' } });
    assert.equal(res.status, 403);
    const noOrigin = await call(app, '/today/echo', { user: 'user-a', method: 'POST', form: { a: '1' } });
    assert.equal(noOrigin.status, 403);
  });

  test('tenant: same-origin form post passes csrf', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/today/echo', { user: 'user-a', method: 'POST', origin: BASE, form: { a: '1' } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  test('tenant: login rate limit after 10 attempts', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 10; i += 1) {
      const res = await call(app, '/login', { method: 'POST', origin: BASE, form: { email: 'x@example.com', password: 'bad' } });
      assert.notEqual(res.status, 429, `attempt ${i + 1}`);
    }
    const blocked = await call(app, '/login', { method: 'POST', origin: BASE, form: { email: 'x@example.com', password: 'bad' } });
    assert.equal(blocked.status, 429);
    // GET 은 세지 않는다
    assert.notEqual((await call(app, '/login')).status, 429);
  });

  test('tenant: password and delete routes are rate limited', async () => {
    for (const p of ['/account/password', '/account/delete']) {
      const { app } = await makeApp();
      for (let i = 0; i < 10; i += 1) {
        const res = await call(app, p, { user: 'user-a', method: 'POST', origin: BASE, form: { a: '1' } });
        assert.notEqual(res.status, 429, `${p} attempt ${i + 1}`);
      }
      const blocked = await call(app, p, { user: 'user-a', method: 'POST', origin: BASE, form: { a: '1' } });
      assert.equal(blocked.status, 429, p);
    }
  });

  test('tenant: rate limit is shared through rate_limits (two apps, one db)', async () => {
    const { app, db, platform } = await makeApp();
    const other = await createApp({
      env: { APP_SECRET: 's', APP_JOB_TOKEN: 'jt', APP_BASE_URL: BASE, APP_SHARED_KEYS: '0' },
      platform,
      db,
      fetchImpl: async () => new Response('{}'),
      modulesDir: modulesDir(),
      coreDir: coreDir(),
    });
    apps.push(other);
    const login = (a) => call(a, '/login', { method: 'POST', origin: BASE, form: { email: 'x@example.com', password: 'bad' } });
    for (let i = 0; i < 5; i += 1) assert.notEqual((await login(app)).status, 429);
    for (let i = 0; i < 5; i += 1) assert.notEqual((await login(other)).status, 429);
    assert.equal((await login(app)).status, 429);
    const rows = (await db.admin('SELECT key, hits FROM rate_limits')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key.length, 16);
    assert.equal(rows[0].hits, 11);
  });

  test('tenant: APP_TRUST_PROXY=1 keys on the last X-Forwarded-For value (spoofed first value ignored)', async () => {
    const { app } = await makeApp({ env: { APP_TRUST_PROXY: '1' } });
    const login = (xff) =>
      call(app, '/login', { method: 'POST', origin: BASE, form: { email: 'x@example.com', password: 'bad' }, headers: { 'x-forwarded-for': xff } });
    for (let i = 0; i < 10; i += 1) assert.notEqual((await login(`spoof-${i}, real-client`)).status, 429, `attempt ${i + 1}`);
    assert.equal((await login('spoof-new, real-client')).status, 429);
    assert.notEqual((await login('real-client, other-client')).status, 429);
  });

  test('tenant: request log line has method, path, status, ms, requestId, workspaceId', async () => {
    const { app } = await makeApp();
    const lines = await captureStdout(async () => {
      const res = await call(app, '/today', { user: 'user-a', headers: { 'x-request-id': 'req-abc' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-request-id'), 'req-abc');
      const gen = await call(app, '/join/invite-token-xyz?x=1', { headers: { 'x-request-id': 'bad id with spaces' } });
      assert.match(gen.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    });
    const reqs = jsonLines(lines).filter((l) => l.msg === 'request');
    const today = reqs.find((l) => l.requestId === 'req-abc');
    assert.ok(today, JSON.stringify(reqs));
    assert.deepEqual([today.level, today.method, today.path, today.status, typeof today.ms, today.workspaceId], [30, 'GET', '/today', 200, 'number', WS_A]);
    assert.ok(reqs.some((l) => l.path === '/join/:token'));
    assert.ok(!lines.some((l) => l.includes('invite-token-xyz')));
  });

  test('tenant: /readyz checks db, queue and auth → 200; failing auth → 503 degraded', async () => {
    const queue = fakeQueue();
    const { app, platform } = await makeApp({ queue });
    platform.preflight = async () => ({ ok: true });
    const res = await call(app, '/readyz');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.mode, 'supabase');
    assert.deepEqual(Object.keys(body.checks).sort(), ['auth', 'db', 'queue']);
    assert.equal(body.checks.queue.depth, 0);
    const bad = await makeApp({ queue: fakeQueue() });
    bad.platform.preflight = async () => ({ ok: false });
    const res2 = await call(bad.app, '/readyz');
    assert.equal(res2.status, 503);
    const b2 = await res2.json();
    assert.equal(b2.status, 'degraded');
    assert.equal(b2.checks.auth.ok, false);
    assert.equal(b2.checks.db.ok, true);
  });

  test('tenant: security headers present', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/healthz');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', mode: 'supabase' });
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /form-action 'self'/);
    assert.ok(res.headers.get('x-frame-options'));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const routed = await call(app, '/today', { user: 'user-a' });
    assert.match(routed.headers.get('content-security-policy') ?? '', /default-src 'self'/);
  });
});

describe('tenant: workspaces and runtimes', () => {
  test('tenant: two workspaces share one db with isolated rows and no files', async () => {
    const { app, wsDir, db } = await makeApp();
    const a = await (await call(app, '/today', { user: 'user-a' })).json();
    const b = await (await call(app, '/today', { user: 'user-b' })).json();
    assert.equal(a.workspace, WS_A);
    assert.equal(b.workspace, WS_B);
    assert.deepEqual(readdirSync(wsDir), [], 'no per-workspace data directory');
    assert.equal(app.db, db);
    const ra = await app.runtimeFor(WS_A);
    const rb = await app.runtimeFor(WS_B);
    assert.equal(ra.ctx.db, rb.ctx.db, 'one shared Db');
    await db.withWorkspace(WS_A, () => ra.ctx.settings.set('company_name', '가나 조경'));
    assert.equal(await db.withWorkspace(WS_B, () => rb.ctx.settings.get('company_name')), null);
    assert.equal(await db.withWorkspace(WS_A, () => ra.ctx.settings.get('company_name')), '가나 조경');
    const ws = await db.withWorkspace(WS_A, () => ra.ctx.db.get("SELECT current_setting('app.workspace_id', true) AS ws"));
    assert.equal(ws.ws, WS_A);
    // 워크스페이스 밖 쿼리는 거부된다
    await assert.rejects(ra.ctx.settings.get('company_name'), { code: 'NO_WORKSPACE' });
  });

  test('tenant: APP_DB_URL is required when no db is given', async () => {
    await assert.rejects(
      createApp({ env: { APP_SECRET: 's', APP_JOB_TOKEN: 'jt' }, platform: createFakePlatform() }),
      { code: 'APP_DB_URL_REQUIRED' },
    );
  });

  test('tenant: member comes from memberships, no members row is written', async () => {
    const { app, db } = await makeApp();
    const first = await (await call(app, '/today', { user: 'user-a' })).json();
    await call(app, '/today', { user: 'user-a' });
    assert.deepEqual(first.member, { id: 1, name: '김대표', role: 'owner' });
    const rt = await app.runtimeFor(WS_A);
    await db.withWorkspace(WS_A, async () => {
      assert.equal(await rt.ctx.members.count(), 1);
      assert.deepEqual(await rt.ctx.members.get(1), { id: 1, name: '김대표', role: 'owner' });
      assert.equal(Number((await rt.ctx.db.get('SELECT COUNT(*) AS n FROM members')).n), 0);
    });
    // 다른 회사의 구성원은 보이지 않는다
    const rb = await app.runtimeFor(WS_B);
    assert.deepEqual(await db.withWorkspace(WS_B, () => rb.ctx.members.list()), [{ id: 1, name: '이대표', role: 'owner' }]);
  });

  test('tenant: members list adds pending invites; remove calls platform with owner client', async () => {
    const seed = {
      memberships: [
        { userId: 'user-a', workspaceId: WS_A, role: 'owner', memberId: 1, memberName: '김대표' },
        { userId: 'user-s', workspaceId: WS_A, role: 'staff', memberId: 2, memberName: '최직원' },
      ],
    };
    const { app, platform, db } = await makeApp({ seed });
    const res = await call(app, '/today/invite', { user: 'user-a', method: 'POST', origin: BASE, form: { name: '박직원' } });
    assert.equal((await res.json()).id, 3);
    const rt = await app.runtimeFor(WS_A);
    assert.deepEqual(await db.withWorkspace(WS_A, () => rt.ctx.members.list()), [
      { id: 1, name: '김대표', role: 'owner' },
      { id: 2, name: '최직원', role: 'staff' },
      { id: 3, name: '박직원', role: 'staff', pending: true },
    ]);
    // 요청 밖에서는 내보내지 않는다
    await assert.rejects(db.withWorkspace(WS_A, () => rt.ctx.members.remove(2)), { code: 'NO_REQUEST_CONTEXT' });
    assert.equal(platform.calls.removeMember.length, 0);
    // 대표: 본인·다른 대표는 막히고, 직원·초대 대기는 내보낸다
    const self = await call(app, '/today/remove?id=1', { user: 'user-a', method: 'POST', origin: BASE, form: {} });
    assert.deepEqual(await self.json(), { error: 'CANNOT_REMOVE_SELF' });
    const staff = await call(app, '/today/remove?id=2', { user: 'user-a', method: 'POST', origin: BASE, form: {} });
    assert.deepEqual(await staff.json(), { ok: true });
    const pending = await call(app, '/today/remove?id=3', { user: 'user-a', method: 'POST', origin: BASE, form: {} });
    assert.deepEqual(await pending.json(), { ok: true });
    assert.deepEqual(platform.calls.removeMember.at(-1), { client: { kind: 'user', userId: 'user-a' }, workspaceId: WS_A, memberId: 3 });
    assert.deepEqual(await db.withWorkspace(WS_A, () => rt.ctx.members.list()), [{ id: 1, name: '김대표', role: 'owner' }]);
    // 내보낸 직원은 더 이상 이 회사로 들어오지 못한다
    const denied = await call(app, '/today/remove?id=1', { user: 'user-s', method: 'POST', origin: BASE, form: {} });
    assert.equal(denied.status, 302, 'removed staff has no membership any more');
  });

  test('tenant: br_ws not in memberships falls back to first', async () => {
    const seed = {
      memberships: [
        { userId: 'user-a', workspaceId: WS_A, role: 'owner', memberId: 1, memberName: '김대표' },
        { userId: 'user-c', workspaceId: WS_A, role: 'staff', memberId: 2, memberName: '최직원' },
        { userId: 'user-c', workspaceId: WS_B, role: 'owner', memberId: 1, memberName: '최대표' },
      ],
    };
    const { app } = await makeApp({ seed });
    const res = await call(app, '/today', { user: 'user-a', cookie: `br_ws=${WS_B}` });
    assert.equal((await res.json()).workspace, WS_A);
    assert.match(res.headers.get('set-cookie') ?? '', new RegExp(`br_ws=${WS_A};.*HttpOnly`));
    const chosen = await call(app, '/today', { user: 'user-c', cookie: `br_ws=${WS_B}` });
    assert.equal((await chosen.json()).workspace, WS_B);
    assert.equal(chosen.headers.get('set-cookie'), null);
    const none = await call(app, '/today', { user: 'user-z' });
    assert.equal(none.status, 302);
    assert.equal(none.headers.get('location'), '/workspaces/new');
  });

  test('tenant: runtime lru evicts and closes', async () => {
    const { app } = await makeApp({ env: { APP_RUNTIME_CACHE: '1' } });
    const ra = await app.runtimeFor(WS_A);
    let closed = 0;
    const realClose = ra.close;
    ra.close = () => {
      closed += 1;
      return realClose();
    };
    assert.equal(await app.runtimeFor(WS_A), ra);
    await app.runtimeFor(WS_B);
    await tick();
    assert.equal(closed, 1);
    const again = await app.runtimeFor(WS_A);
    assert.notEqual(again, ra);
    await assert.rejects(app.runtimeFor('../etc'), { code: 'BAD_WORKSPACE' });
  });

  test('tenant: evicted runtime stays open until in-flight request ends', async () => {
    const { app } = await makeApp({ env: { APP_RUNTIME_CACHE: '1' } });
    let finish;
    globalThis.__brSlow = new Promise((r) => {
      finish = r;
    });
    globalThis.__brSlowEntered = false;
    try {
      const inflight = call(app, '/today/slow', { user: 'user-a' });
      // 런타임 열기(PGlite)는 실제 I/O 라 몇 백 ms 걸린다: 최대 10초 기다린다
      for (let i = 0; i < 1000 && !globalThis.__brSlowEntered; i += 1) await new Promise((r) => setTimeout(r, 10));
      assert.ok(globalThis.__brSlowEntered, 'request reached the module');
      const ra = await app.runtimeFor(WS_A);
      let closed = 0;
      const realClose = ra.close;
      ra.close = () => {
        closed += 1;
        return realClose();
      };
      await app.runtimeFor(WS_B);
      await tick();
      assert.equal(closed, 0, 'not closed while in use');
      finish();
      const res = await inflight;
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'slow');
      await tick();
      assert.equal(closed, 1, 'closed after the request ended');
    } finally {
      finish();
      delete globalThis.__brSlow;
      delete globalThis.__brSlowEntered;
    }
  });

  test('tenant: layered env reads workspace key', async () => {
    const { app, platform } = await makeApp({ env: { NARA_API_KEY: 'env-nara' }, seed: { keys: { [WS_A]: { NARA_API_KEY: 'ws-a-nara' } } } });
    const a = await (await call(app, '/today', { user: 'user-a' })).json();
    assert.equal(a.nara, 'ws-a-nara');
    const b = await (await call(app, '/today', { user: 'user-b' })).json();
    assert.equal(b.nara, '');
    assert.ok(platform.calls.keysLoad.includes(WS_A));
  });

  test("tenant: invite registration uses the owner's client", async () => {
    const { app, platform } = await makeApp();
    const res = await call(app, '/today/invite', { user: 'user-a', method: 'POST', origin: BASE, form: { name: '박직원' } });
    assert.equal(res.status, 200);
    const { id } = await res.json();
    await tick();
    assert.equal(platform.calls.registerInvite.length, 1);
    const inv = platform.calls.registerInvite[0];
    assert.deepEqual(inv.client, { kind: 'user', userId: 'user-a' });
    assert.notEqual(inv.client, platform.serviceClient);
    assert.equal(inv.workspaceId, WS_A);
    assert.equal(inv.memberId, id);
    assert.equal(inv.memberName, '박직원');
    assert.match(inv.tokenHash, /^[0-9a-f]{64}$/);
    const rt = await app.runtimeFor(WS_A);
    assert.equal(id, 2, 'new member id follows memberships and invites');
    assert.deepEqual(await app.db.withWorkspace(WS_A, () => rt.ctx.members.get(id)), { id, name: '박직원', role: 'staff', pending: true });
  });
});

describe('tenant: jobs', () => {
  const H = { headers: { 'x-job-token': 'jt' } };

  const W = { APP_WORKER_POLL_MS: '5' };

  test('tenant: jobs all=1 enqueues one message per workspace → 202; same day again → skipped', async () => {
    const queue = fakeQueue();
    const { app } = await makeApp({ queue });
    const res = await call(app, '/api/jobs/daily?all=1&date=2026-10-30', H);
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { runId: 'daily:2026-10-30', enqueued: 2, skipped: 0 });
    assert.deepEqual(
      queue.items.map((x) => x.message.runId),
      [`daily:2026-10-30:${WS_A}`, `daily:2026-10-30:${WS_B}`],
    );
    assert.equal(queue.items[0].message.v, 1);
    assert.equal(queue.items[0].message.workspaceId, WS_A);
    const again = await call(app, '/api/jobs/daily?all=1&date=2026-10-30', H);
    assert.equal(again.status, 202);
    assert.deepEqual(await again.json(), { runId: 'daily:2026-10-30', enqueued: 0, skipped: 2 });
    assert.equal(queue.items.length, 2);
    assert.equal((await call(app, '/api/jobs/daily?all=1')).status, 403);
    assert.equal((await call(app, '/api/jobs/daily?all=1&date=2026-02-30', H)).status, 400);
    const runs = await (await call(app, '/api/jobs/daily/runs?date=2026-10-30', H)).json();
    assert.deepEqual(
      runs.map((r) => [r.workspaceId, r.status, r.attempt]),
      [
        [WS_A, 'queued', 0],
        [WS_B, 'queued', 0],
      ],
    );
    assert.equal((await call(app, '/api/jobs/daily/runs')).status, 403);
    assert.equal((await call(app, '/api/jobs/nope/runs', H)).status, 404);
  });

  test('tenant: worker runs each workspace and posts the webhook once', async () => {
    const queue = fakeQueue();
    const posts = [];
    const fetchImpl = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('ok');
    };
    const { app } = await makeApp({ queue, fetchImpl, env: W });
    const ra = await app.runtimeFor(WS_A);
    await app.db.withWorkspace(WS_A, async () => {
      await ra.ctx.settings.set('n', '2');
      await ra.ctx.settings.set('notify_webhook_url', 'https://hooks.test/a');
    });
    assert.equal((await call(app, '/api/jobs/reminders?all=1&date=2026-10-30', H)).status, 202);
    app.startWorker();
    await waitFor(() => queue.acked.length === 2);
    // 같은 날을 다시 트리거해도(이미 done) 다시 보내지 않는다
    const again = await (await call(app, '/api/jobs/reminders?all=1&date=2026-10-30', H)).json();
    assert.deepEqual(again, { runId: 'reminders:2026-10-30', enqueued: 0, skipped: 2 });
    await app.stopWorker();
    assert.deepEqual(posts, [
      { url: 'https://hooks.test/a', body: { kind: 'reminders', date: '2026-10-30', count: 2, runId: `reminders:2026-10-30:${WS_A}` } },
    ]);
    const runs = await (await call(app, '/api/jobs/reminders/runs?date=2026-10-30', H)).json();
    assert.deepEqual(
      runs.map((r) => [r.workspaceId, r.runId, r.status, r.attempt, r.errorCode]),
      [
        [WS_A, `reminders:2026-10-30:${WS_A}`, 'done', 1, null],
        [WS_B, `reminders:2026-10-30:${WS_B}`, 'done', 1, null],
      ],
    );
    const sent = await app.db.withWorkspace(WS_A, () => app.db.all('SELECT kind, date, status FROM notification_deliveries'));
    assert.deepEqual(sent, [{ kind: 'reminders', date: '2026-10-30', status: 'sent' }]);
  });

  // 이전 동기 ?all=1 과 같은 규칙: reminders/support 는 null 이거나 count 0 이면 빠지고, daily 는 count 0 이어도 보낸다
  test('tenant: worker sends only what the old all=1 included (nothing to send → no POST, no delivery row)', async () => {
    const queue = fakeQueue();
    const posts = [];
    const fetchImpl = async (url, init) => {
      posts.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response('ok');
    };
    const { app } = await makeApp({ queue, fetchImpl, env: W });
    for (const ws of [WS_A, WS_B]) {
      const rt = await app.runtimeFor(ws);
      await app.db.withWorkspace(ws, () => rt.ctx.settings.set('notify_webhook_url', 'https://hooks.test/x'));
    }
    const rows = (ws) => app.db.withWorkspace(ws, () => app.db.all('SELECT kind, status FROM notification_deliveries ORDER BY kind'));
    assert.equal((await call(app, '/api/jobs/reminders?all=1&date=2026-10-30', H)).status, 202);
    assert.equal((await call(app, '/api/jobs/support?all=1&date=2026-10-30', H)).status, 202);
    app.startWorker();
    await waitFor(() => queue.acked.length === 4);
    assert.equal(posts.length, 0, 'reminders count 0 and support null send nothing');
    assert.deepEqual(await rows(WS_A), []);
    assert.deepEqual(await rows(WS_B), []);
    const runs = await (await call(app, '/api/jobs/support/runs?date=2026-10-30', H)).json();
    assert.deepEqual(runs.map((r) => r.status), ['done', 'done']);
    assert.equal((await call(app, '/api/jobs/daily?all=1&date=2026-10-30', H)).status, 202);
    await waitFor(() => queue.acked.length === 6);
    await app.stopWorker();
    assert.deepEqual(
      posts.map((p) => [p.body.kind, p.body.count]),
      [
        ['daily', 0],
        ['daily', 0],
      ],
    );
    assert.deepEqual(await rows(WS_A), [{ kind: 'daily', status: 'sent' }]);
  });

  test('tenant: a failing workspace goes dead; the other is done', async () => {
    const queue = fakeQueue();
    const { app, platform } = await makeApp({ queue, env: W });
    platform.keys(WS_A).load = async () => {
      throw Object.assign(new Error('secret-value-should-not-leak'), { code: 'KEYS_LOAD' });
    };
    const logs = await captureStdout(async () => {
      assert.equal((await call(app, '/api/jobs/daily?all=1&date=2026-10-30', H)).status, 202);
      app.startWorker();
      await waitFor(() => queue.acked.length === 1 && queue.archived.length === 1);
      await app.stopWorker();
    });
    assert.equal(queue.archived[0].message.workspaceId, WS_A);
    const runs = await (await call(app, '/api/jobs/daily/runs?date=2026-10-30', H)).json();
    assert.deepEqual(
      runs.map((r) => [r.workspaceId, r.status, r.attempt, r.errorCode]),
      [
        [WS_A, 'dead', 3, 'MAX_ATTEMPTS'],
        [WS_B, 'done', 1, null],
      ],
    );
    assert.ok(logs.some((l) => l.includes(WS_A) && l.includes('KEYS_LOAD')));
    assert.ok(!logs.some((l) => l.includes('secret-value-should-not-leak')));
    const jobs = jsonLines(logs).filter((l) => l.msg === 'job');
    const failed = jobs.find((l) => l.workspaceId === WS_A && l.status === 'failed');
    assert.ok(failed, JSON.stringify(jobs));
    assert.deepEqual([failed.job, failed.runId, failed.attempt, failed.errorCode], ['daily', `daily:2026-10-30:${WS_A}`, 1, 'KEYS_LOAD']);
    assert.ok(jobs.some((l) => l.workspaceId === WS_A && l.status === 'dead' && l.attempt === 4));
    const done = jobs.find((l) => l.workspaceId === WS_B && l.status === 'done');
    assert.ok(done && typeof done.ms === 'number' && done.attempt === 1);
  });

  test('tenant: APP_WORKER=0 keeps the worker off; dry all=1 stays a synchronous preview', async () => {
    const queue = fakeQueue();
    const { app } = await makeApp({ queue, env: { ...W, APP_WORKER: '0' } });
    const dry = await call(app, '/api/jobs/daily?all=1&dry=1&date=2026-10-30', H);
    assert.equal(dry.status, 200);
    assert.deepEqual(
      (await dry.json()).map((p) => [p.workspaceId, p.kind, p.runId]),
      [
        [WS_A, 'daily', `daily:2026-10-30:${WS_A}`],
        [WS_B, 'daily', `daily:2026-10-30:${WS_B}`],
      ],
    );
    assert.equal(queue.items.length, 0);
    await call(app, '/api/jobs/daily?all=1&date=2026-10-30', H);
    app.startWorker();
    await new Promise((r) => setTimeout(r, 30));
    await app.stopWorker();
    assert.equal(queue.items.length, 2);
    assert.equal(queue.items[0].readCt, 0);
  });

  test('tenant: job token comparison rejects wrong length', async () => {
    const { app } = await makeApp();
    for (const t of ['j', 'jtx', 'jx', '']) {
      const res = await call(app, `/api/jobs/daily?workspace=${WS_B}&date=2026-10-30`, { headers: { 'x-job-token': t } });
      assert.equal(res.status, 403, JSON.stringify(t));
    }
    assert.equal((await call(app, `/api/jobs/daily?workspace=${WS_B}&date=2026-10-30`, H)).status, 200);
  });

  test('tenant: jobs workspace=<id> returns single', async () => {
    const { app } = await makeApp();
    const res = await call(app, `/api/jobs/daily?workspace=${WS_B}&date=2026-10-30`, H);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: 'daily', date: '2026-10-30', count: 0, runId: `daily:2026-10-30:${WS_B}`, notifyUrl: null });
    assert.equal((await call(app, `/api/jobs/support?workspace=${WS_B}`, H)).status, 204);
  });

  test('tenant: jobs without workspace is 400', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/api/jobs/daily', H);
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'workspace_required' });
  });
});

/** 테스트용 today 모듈 + 실제 요금제 모듈(app/modules/billing) */
function modulesWithBilling() {
  const dir = modulesDir();
  symlinkSync(path.resolve('app/modules/billing'), path.join(dir, 'billing'), 'dir');
  return dir;
}

function memoryVault() {
  const keys = new Map();
  return {
    keys,
    async setKey(ws, key) {
      keys.set(ws, key);
    },
    async getKey(ws) {
      return keys.get(ws) ?? null;
    },
    async deleteKey(ws) {
      keys.delete(ws);
    },
  };
}

const setStatus = (db, ws, status) =>
  db.admin(
    `INSERT INTO subscriptions (workspace_id, plan, status, customer_key) VALUES ($1, 'trial', $2, $3)
     ON CONFLICT (workspace_id) DO UPDATE SET status = excluded.status`,
    [ws, status, `ck-${ws}`],
  );

describe('tenant: billing, email and legal wiring', () => {
  const H = { headers: { 'x-job-token': 'jt' } };

  test('tenant: expired workspace — GET is 302 /billing?locked=1, POST is 402, /billing stays open', async () => {
    const { app, db } = await makeApp({ modules: modulesWithBilling(), billingVault: memoryVault() });
    await setStatus(db, WS_A, 'expired');
    const get = await call(app, '/today', { user: 'user-a' });
    assert.equal(get.status, 302);
    assert.equal(get.headers.get('location'), '/billing?locked=1');
    const post = await call(app, '/today/echo', { user: 'user-a', method: 'POST', origin: BASE });
    assert.equal(post.status, 402);
    assert.deepEqual(await post.json(), { error: 'subscription_inactive' });
    const billing = await call(app, '/billing', { user: 'user-a' });
    assert.equal(billing.status, 200);
    assert.match(await billing.text(), /요금제/);
    // 허용 경로: /billing 아래·/unsubscribe 는 잠그지 않는다 (/unsubscribe 는 앞단 라우트가 받는다)
    assert.notEqual((await call(app, '/billing/whatever', { user: 'user-a' })).status, 302);
    assert.equal((await call(app, '/unsubscribe?ws=bad', { user: 'user-a' })).status, 400);
    // 다른 회사(체험 중)는 그대로
    assert.equal((await call(app, '/today', { user: 'user-b' })).status, 200);
  });

  test('tenant: a trialing workspace gets a subscription row on first request and is not locked', async () => {
    const { app, db } = await makeApp();
    assert.equal((await call(app, '/today', { user: 'user-a' })).status, 200);
    const rows = (await db.admin('SELECT workspace_id, plan, status FROM subscriptions')).rows;
    assert.deepEqual(rows.map((r) => [String(r.workspace_id), r.plan, r.status]), [[WS_A, 'trial', 'trialing']]);
  });

  test('tenant: jobs all=1 skips expired and canceled workspaces', async () => {
    const queue = fakeQueue();
    const { app, db } = await makeApp({ queue });
    await setStatus(db, WS_B, 'expired');
    const res = await call(app, '/api/jobs/reminders?all=1&date=2026-10-30', H);
    assert.equal(res.status, 202);
    assert.equal((await res.json()).enqueued, 1);
    assert.deepEqual(queue.items.map((i) => i.message.workspaceId), [WS_A]);
  });

  test('tenant: ctx.limits and ctx.billing reach modules (trial plan limits)', async () => {
    const { app } = await makeApp({ billingVault: memoryVault() });
    const ra = await app.runtimeFor(WS_A);
    const summary = await ra.ctx.limits.summary();
    assert.equal(summary.plan, 'trial');
    assert.equal(summary.limits.members, 3);
    const over = await ra.ctx.limits.check('members', 4);
    assert.equal(over.ok, false);
    assert.equal(over.code, 'PLAN_LIMIT');
    assert.match(over.message, /무료 체험 요금제에서 3개까지/);
    assert.equal(ra.ctx.billing.workspaceId, WS_A);
    assert.equal(typeof ra.ctx.billing.store.ensure, 'function');
    assert.equal(typeof ra.ctx.billing.vault.getKey, 'function');
  });

  test('tenant: /api/jobs/billing is served by the billing routes (token required)', async () => {
    const { app } = await makeApp({ billingVault: memoryVault() });
    assert.equal((await call(app, '/api/jobs/billing')).status, 403);
    const res = await call(app, '/api/jobs/billing?date=2026-10-30', H);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(Object.keys(body).sort(), ['charged', 'expired', 'failed', 'skipped']);
  });

  test('tenant: worker delivery also sends the email channel once', async () => {
    const queue = fakeQueue();
    const posts = [];
    const fetchImpl = async (url, init) => {
      posts.push({ url: String(url), to: JSON.parse(init.body).to ?? null });
      return String(url).startsWith('https://mail.test/') ? Response.json({ id: 'm1' }) : new Response('ok');
    };
    const env = { APP_WORKER_POLL_MS: '5', EMAIL_API_KEY: 'k', EMAIL_FROM: 'alerts@example.com', EMAIL_API_BASE: 'https://mail.test' };
    const { app } = await makeApp({ queue, fetchImpl, env });
    const ra = await app.runtimeFor(WS_A);
    await app.db.withWorkspace(WS_A, async () => {
      await ra.ctx.settings.set('n', '2');
      await ra.ctx.settings.set('notify_webhook_url', 'https://hooks.test/a');
      await ra.ctx.settings.set('notify_emails', 'boss@example.com');
    });
    assert.equal((await call(app, '/api/jobs/reminders?all=1&date=2026-10-30', H)).status, 202);
    app.startWorker();
    await waitFor(() => queue.acked.length === 2);
    await app.stopWorker();
    assert.deepEqual(posts, [
      { url: 'https://hooks.test/a', to: null },
      { url: 'https://mail.test/emails', to: ['boss@example.com'] },
    ]);
    const sent = await app.db.withWorkspace(WS_A, () => app.db.all('SELECT kind, status FROM notification_deliveries ORDER BY kind'));
    assert.deepEqual(sent, [
      { kind: 'reminders', status: 'sent' },
      { kind: 'reminders:email', status: 'sent' },
    ]);
  });

  test('tenant: CSP allows the Toss payment SDK only where needed', async () => {
    const { app } = await makeApp();
    const csp = (await call(app, '/healthz')).headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src [^;]*https:\/\/js\.tosspayments\.com/);
    assert.match(csp, /frame-src [^;]*https:\/\/\*\.tosspayments\.com/);
    assert.match(csp, /connect-src [^;]*'self'[^;]*https:\/\/\*\.tosspayments\.com/);
    assert.match(csp, /frame-ancestors 'none'/);
  });
});

describe('tenant: demo, guard, budget and ops wiring', () => {
  const H = { headers: { 'x-job-token': 'jt' } };
  const DEMO_SCHEMA = readFileSync(path.resolve('app/core/demo/schema.sql'), 'utf8');
  const DEMO_OWNER = '11111111-1111-4111-8111-111111111111';

  /** WS_A 를 예시 회사로 표시한다 (demo_workspaces 한 행) */
  async function markDemo(db, ws = WS_A) {
    await db.admin(DEMO_SCHEMA);
    await db.admin('INSERT INTO demo_workspaces (workspace_id, owner_user_id, staff_user_ids, seeded_at, reset_count) VALUES ($1, $2, $3::uuid[], now(), 1)', [
      ws,
      DEMO_OWNER,
      [],
    ]);
  }

  test('tenant: demo workspace — blocked POST /connections/nara is 403 (json and html); other workspace is not blocked', async () => {
    const { app, db } = await makeApp({ env: { APP_DEMO: '1' } });
    await markDemo(db);
    const res = await call(app, '/connections/nara', { user: 'user-a', method: 'POST', origin: BASE, form: { key: 'x' } });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'demo_blocked' });
    const html = await call(app, '/connections/nara', { user: 'user-a', method: 'POST', origin: BASE, form: { key: 'x' }, headers: { accept: 'text/html' } });
    assert.equal(html.status, 403);
    const text = await html.text();
    assert.ok(text.includes(DEMO_TEXT.blocked));
    assert.ok(text.includes('class="banner demo"'));
    // 막지 않는 동작은 그대로 런타임으로
    assert.equal((await call(app, '/today/echo', { user: 'user-a', method: 'POST', origin: BASE, form: { a: '1' } })).status, 200);
    // 예시 회사가 아닌 곳은 막지 않는다 (테스트 모듈에 없는 경로라 404)
    assert.equal((await call(app, '/connections/nara', { user: 'user-b', method: 'POST', origin: BASE, form: { key: 'x' } })).status, 404);
  });

  test('tenant: ctx.demo, ctx.budget and the banner appear only in the demo workspace runtime', async () => {
    const { app, db } = await makeApp({ env: { APP_DEMO: '1' } });
    await markDemo(db);
    const ra = await app.runtimeFor(WS_A);
    const rb = await app.runtimeFor(WS_B);
    assert.deepEqual(ra.ctx.demo, { enabled: true });
    assert.equal(rb.ctx.demo, null);
    assert.equal(typeof ra.ctx.budget.take, 'function');
    assert.equal(rb.ctx.budget, ra.ctx.budget);
    const pageOf = async (ws, r) => db.withWorkspace(ws, async () => (await r.ctx.html.page(200, { title: 't', body: '<p>b</p>' })).text());
    const a = await pageOf(WS_A, ra);
    assert.ok(a.includes('class="banner demo"'));
    assert.ok(a.includes(esc(DEMO_TEXT.banner)));
    assert.ok(a.includes('href="/signup"'));
    assert.ok(!(await pageOf(WS_B, rb)).includes('class="banner demo"'));
  });

  test('tenant: worker skips webhook and email delivery for the demo workspace (no request, no delivery row)', async () => {
    const queue = fakeQueue();
    const posts = [];
    const fetchImpl = async (url, init) => {
      posts.push({ url: String(url), to: JSON.parse(init.body).to ?? null });
      return String(url).startsWith('https://mail.test/') ? Response.json({ id: 'm1' }) : new Response('ok');
    };
    const env = { APP_DEMO: '1', APP_WORKER_POLL_MS: '5', EMAIL_API_KEY: 'k', EMAIL_FROM: 'alerts@example.com', EMAIL_API_BASE: 'https://mail.test' };
    const { app, db } = await makeApp({ queue, fetchImpl, env });
    await markDemo(db);
    for (const ws of [WS_A, WS_B]) {
      const rt = await app.runtimeFor(ws);
      await app.db.withWorkspace(ws, async () => {
        await rt.ctx.settings.set('n', '2');
        await rt.ctx.settings.set('notify_webhook_url', `https://hooks.test/${ws === WS_A ? 'a' : 'b'}`);
        await rt.ctx.settings.set('notify_emails', 'boss@example.com');
      });
    }
    assert.equal((await call(app, '/api/jobs/reminders?all=1&date=2026-10-30', H)).status, 202);
    app.startWorker();
    await waitFor(() => queue.acked.length === 2);
    await app.stopWorker();
    // 예시 회사(WS_A)는 아무 데도 보내지 않고, 다른 회사(WS_B)는 그대로 보낸다
    assert.deepEqual(posts, [
      { url: 'https://hooks.test/b', to: null },
      { url: 'https://mail.test/emails', to: ['boss@example.com'] },
    ]);
    const rows = (ws) => app.db.withWorkspace(ws, () => app.db.all('SELECT kind, status FROM notification_deliveries ORDER BY kind'));
    assert.deepEqual(await rows(WS_A), []);
    assert.equal((await rows(WS_B)).length, 2);
  });

  test('tenant: without APP_DEMO, /demo/login and /api/jobs/demo-reset are 404', async () => {
    const { app } = await makeApp();
    const login = await call(app, '/demo/login', { method: 'POST', origin: BASE });
    assert.equal(login.status, 404);
    assert.deepEqual(await login.json(), { error: 'not_found' });
    assert.equal((await call(app, '/api/jobs/demo-reset', H)).status, 404);
  });

  test('tenant: APP_DEMO=1 — demo-reset needs the job token, seeds the example company, then /demo/login signs in to it', async () => {
    const { app, db, platform } = await makeApp({ env: { APP_DEMO: '1', APP_FAKE_NOW: '2026-11-03' } });
    await db.admin(DEMO_SCHEMA);
    // 아직 만들기 전: 준비 중 안내
    const early = await call(app, '/demo/login', { method: 'POST', origin: BASE });
    assert.equal(early.status, 503);
    assert.equal((await call(app, '/api/jobs/demo-reset')).status, 403);
    const reset = await call(app, '/api/jobs/demo-reset', H);
    assert.equal(reset.status, 200);
    const body = await reset.json();
    assert.equal(body.ok, true);
    assert.equal(body.resetCount, 1);
    assert.ok(body.bids >= 12);
    assert.equal(platform.serviceClient.calls.createUser, 3);
    const login = await call(app, '/demo/login', { method: 'POST', origin: BASE });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/today');
    const sc = login.headers.getSetCookie();
    assert.ok(sc.some((c) => c === `br_ws=${body.workspaceId}; Path=/; HttpOnly; SameSite=Lax`));
    const userCookie = sc.find((c) => c.startsWith('fake-user='));
    assert.ok(userCookie);
    const today = await call(app, '/today', { cookie: `${userCookie.split(';')[0]}; br_ws=${body.workspaceId}` });
    assert.equal(today.status, 200);
    assert.equal((await today.json()).workspace, body.workspaceId);
  });

  test('tenant: jobs all=1&wait=1 drains the queue in the request → 200 {processed, remaining}; without wait stays 202', async () => {
    const queue = fakeQueue();
    const { app } = await makeApp({ queue, env: { APP_WORKER: '0' } });
    const res = await call(app, '/api/jobs/daily?all=1&wait=1&date=2026-10-30', H);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enqueued, 2);
    assert.equal(body.processed, 2);
    assert.equal(body.remaining, 0);
    assert.equal(queue.items.length, 0);
    assert.equal((await call(app, '/api/jobs/reminders?all=1&date=2026-10-30', H)).status, 202);
  });

  test('tenant: /status and /status.json are public; /admin is 302 anonymous, 404 for non-admins, 200 for platform admins', async () => {
    const { app } = await makeApp({ env: { APP_PLATFORM_ADMIN_EMAILS: 'User-A@example.com' } });
    const status = await call(app, '/status');
    assert.equal(status.status, 200);
    assert.match(await status.text(), /서비스 현황/);
    const sj = await call(app, '/status.json');
    assert.equal(sj.status, 200);
    assert.deepEqual(Object.keys(await sj.json()).sort(), ['bids', 'collect', 'date', 'deliveries', 'example', 'lastRunAt', 'status']);
    const anon = await call(app, '/admin');
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/welcome');
    assert.equal((await call(app, '/admin', { user: 'user-b' })).status, 404);
    assert.equal((await call(app, '/admin.json', { user: 'user-b' })).status, 404);
    const admin = await call(app, '/admin.json', { user: 'user-a' });
    assert.equal(admin.status, 200);
    assert.equal((await admin.json()).workspaces.total, 2);
    assert.equal((await call(app, '/admin', { user: 'user-a' })).status, 200);
  });

  test('tenant: workspace rate rule — 7th POST /today/run in an hour is 429 with Retry-After; other workspace unaffected', async () => {
    const { app } = await makeApp();
    for (let i = 0; i < 6; i += 1) {
      assert.notEqual((await call(app, '/today/run', { user: 'user-a', method: 'POST', origin: BASE })).status, 429, `attempt ${i + 1}`);
    }
    const blocked = await call(app, '/today/run', { user: 'user-a', method: 'POST', origin: BASE });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.match(await blocked.text(), /분 뒤 다시 시도해 주세요/);
    assert.notEqual((await call(app, '/today/run', { user: 'user-b', method: 'POST', origin: BASE })).status, 429);
  });

  describe('tenant: scheduler off (first visit day start, demo login reset, free collect credits)', () => {
    const OFF = { APP_SCHEDULER_OFF: '1' };
    const CREDITS_SQL = readFileSync(path.resolve('app/core/billing/credits.sql'), 'utf8');
    const COLLECT_URL = `${BASE}/api/jobs/collect?all=1`;

    /** 받은 self-request 를 적어 두고 reply(url) 로 응답한다 */
    function recorder(reply = () => Response.json({ remaining: 0 })) {
      const kicks = [];
      const fetchImpl = async (url, init) => {
        kicks.push({ url: String(url), token: new Headers(init?.headers).get('x-job-token') });
        return reply(String(url), init);
      };
      return { kicks, fetchImpl };
    }

    test('tenant: first visit kicks GET /api/jobs/collect?all=1 with x-job-token; remaining 0 → later requests do not kick; /status.json shows done', async () => {
      const { kicks, fetchImpl } = recorder();
      const { app } = await makeApp({ env: OFF, fetchImpl });
      await call(app, '/welcome');
      await waitFor(() => kicks.length === 1);
      assert.deepEqual(kicks, [{ url: COLLECT_URL, token: 'jt' }]);
      assert.equal((await call(app, '/today', { user: 'user-a' })).status, 200);
      const sj = await (await call(app, '/status.json')).json();
      assert.deepEqual(sj.collect, { trigger: 'first-visit', state: 'done' });
      assert.match(await (await call(app, '/status')).text(), /<dt>오늘 수집<\/dt><dd>완료<\/dd>/);
      assert.equal(kicks.length, 1);
    });

    test('tenant: /healthz, /readyz, /api/jobs/*, /webhooks/* and static files do not kick', async () => {
      const { kicks, fetchImpl } = recorder();
      const { app } = await makeApp({ env: OFF, fetchImpl });
      await call(app, '/healthz');
      await call(app, '/readyz');
      await call(app, '/api/jobs/daily/runs?date=2026-10-30', H);
      await call(app, '/api/jobs/demo-reset', H);
      await call(app, '/webhooks/toss', { method: 'POST', headers: { 'content-type': 'application/json' } });
      await call(app, '/favicon.ico');
      await call(app, '/robots.txt');
      await tick();
      assert.deepEqual(kicks, []);
    });

    test('tenant: unfinished collect (remaining > 0) releases the claim → the next visit kicks again', async () => {
      let remaining = 1;
      const { kicks, fetchImpl } = recorder(() => Response.json({ remaining }));
      const { app, db } = await makeApp({ env: OFF, fetchImpl });
      await call(app, '/welcome');
      await waitFor(async () => kicks.length === 1 && (await db.admin("SELECT count(*)::integer AS n FROM rate_limits WHERE key LIKE '%daystart%'")).rows[0].n === 0);
      remaining = 0;
      await call(app, '/welcome');
      await waitFor(() => kicks.length === 2);
      await call(app, '/welcome');
      assert.equal(kicks.length, 2);
    });

    test('tenant: APP_BASE_URL empty → a request with a foreign Host never kicks (job token stays inside); demo login does not kick either', async () => {
      const { kicks, fetchImpl } = recorder();
      const { app } = await makeApp({ env: { ...OFF, APP_DEMO: '1', APP_BASE_URL: '' }, fetchImpl });
      await app.fetch(new Request('http://attacker.example/welcome', { redirect: 'manual' }));
      await app.fetch(new Request('http://attacker.example/demo/login', { method: 'POST', headers: { origin: 'http://attacker.example' }, redirect: 'manual' }));
      await call(app, '/welcome');
      await tick();
      assert.deepEqual(kicks, []);
      assert.equal((await (await call(app, '/status.json')).json()).collect.state, 'off');
    });

    test('tenant: APP_BASE_URL set → a request with a foreign Host kicks only the APP_BASE_URL origin', async () => {
      const { kicks, fetchImpl } = recorder();
      const { app } = await makeApp({ env: OFF, fetchImpl });
      await app.fetch(new Request('http://attacker.example/welcome', { redirect: 'manual' }));
      await waitFor(() => kicks.length === 1);
      assert.deepEqual(kicks, [{ url: COLLECT_URL, token: 'jt' }]);
    });

    test('tenant: without APP_SCHEDULER_OFF nothing kicks; /status.json collect is scheduled/off and /status has no tile', async () => {
      const { kicks, fetchImpl } = recorder();
      const { app } = await makeApp({ fetchImpl });
      await call(app, '/welcome');
      await call(app, '/today', { user: 'user-a' });
      await tick();
      assert.deepEqual(kicks, []);
      assert.deepEqual((await (await call(app, '/status.json')).json()).collect, { trigger: 'scheduled', state: 'off' });
      assert.ok(!(await (await call(app, '/status')).text()).includes('<dt>오늘 수집</dt>'));
    });

    test('tenant: GET /api/jobs/collect?all=1 runs each non-demo workspace once (token required); a second call skips', async () => {
      const { app, db } = await makeApp({ env: { ...OFF, APP_DEMO: '1' } });
      await markDemo(db, WS_B);
      assert.equal((await call(app, '/api/jobs/collect?all=1&date=2026-10-30')).status, 403);
      const first = await call(app, '/api/jobs/collect?all=1&date=2026-10-30', H);
      assert.equal(first.status, 200);
      assert.deepEqual(await first.json(), { date: '2026-10-30', total: 1, processed: 1, failed: 0, skipped: 0, remaining: 0 });
      const row = await db.withWorkspace(WS_A, () => db.get("SELECT status FROM job_runs WHERE job = 'daily' AND date = '2026-10-30'"));
      assert.equal(row.status, 'done');
      assert.equal(await db.withWorkspace(WS_B, () => db.get("SELECT status FROM job_runs WHERE job = 'daily'")), null);
      const again = await (await call(app, '/api/jobs/collect?all=1&date=2026-10-30', H)).json();
      assert.equal(again.skipped, 1);
      assert.equal(again.remaining, 0);
    });

    test('tenant: demo login before today\'s reset kicks /api/jobs/demo-reset, waits for it, then signs in; the banner says first-visit reset', async () => {
      let app;
      const kicks = [];
      const fetchImpl = async (url, init) => {
        kicks.push(new URL(String(url)).pathname);
        return app.fetch(new Request(String(url), init));
      };
      const made = await makeApp({ env: { ...OFF, APP_DEMO: '1' }, fetchImpl });
      app = made.app;
      await made.db.admin(DEMO_SCHEMA);
      const login = await call(app, '/demo/login', { method: 'POST', origin: BASE });
      assert.equal(login.status, 303);
      assert.ok(kicks.includes('/api/jobs/demo-reset'));
      const status = await made.db.admin('SELECT workspace_id, reset_count FROM demo_workspaces');
      assert.equal(status.rows.length, 1);
      assert.equal(status.rows[0].reset_count, 1);
      const ws = String(status.rows[0].workspace_id);
      // 오늘 이미 초기화됐으면 다시 부르지 않는다
      const before = kicks.filter((k) => k === '/api/jobs/demo-reset').length;
      assert.equal((await call(app, '/demo/login', { method: 'POST', origin: BASE })).status, 303);
      assert.equal(kicks.filter((k) => k === '/api/jobs/demo-reset').length, before);
      const rt = await app.runtimeFor(ws);
      const html = await made.db.withWorkspace(ws, async () => (await rt.ctx.html.page(200, { title: 't', body: '<p>b</p>' })).text());
      assert.ok(html.includes(esc(DEMO_TEXT.bannerOff)));
    });

    test('tenant: demo login without scheduler off does not kick a reset', async () => {
      const { kicks, fetchImpl } = recorder();
      const { app, db } = await makeApp({ env: { APP_DEMO: '1' }, fetchImpl });
      await db.admin(DEMO_SCHEMA);
      assert.equal((await call(app, '/demo/login', { method: 'POST', origin: BASE })).status, 503);
      assert.deepEqual(kicks, []);
    });

    test('tenant: ctx.credits — free 5 then refused; APP_FREE_COLLECTS=0 is unlimited', async () => {
      const { app, db } = await makeApp({ env: { ...OFF, APP_FREE_COLLECTS: '5' } });
      await db.admin(CREDITS_SQL);
      const rt = await app.runtimeFor(WS_A);
      assert.deepEqual(await rt.ctx.credits.summary(), { used: 0, max: 5, left: 5, unlimited: false });
      for (let i = 0; i < 5; i += 1) assert.equal((await rt.ctx.credits.take()).ok, true);
      const sixth = await rt.ctx.credits.take();
      assert.equal(sixth.ok, false);
      assert.equal(sixth.left, 0);
      assert.equal((await (await app.runtimeFor(WS_B)).ctx.credits.summary()).left, 5);
      const free = await makeApp({ env: { APP_FREE_COLLECTS: '0' } });
      await free.db.admin(CREDITS_SQL);
      const rf = await free.app.runtimeFor(WS_A);
      assert.equal((await rf.ctx.credits.take()).unlimited, true);
    });

    test('tenant: demo workspace runtime has no ctx.credits (no free collect chip); other workspace keeps it', async () => {
      const { app, db } = await makeApp({ env: { ...OFF, APP_DEMO: '1' } });
      await db.admin(CREDITS_SQL);
      await markDemo(db, WS_A);
      assert.equal((await app.runtimeFor(WS_A)).ctx.credits, null);
      assert.equal(typeof (await app.runtimeFor(WS_B)).ctx.credits.take, 'function');
    });
  });

  test('tenant: request body over APP_BODY_LIMIT_BYTES is 413; small bodies pass', async () => {
    const { app } = await makeApp({ env: { APP_BODY_LIMIT_BYTES: '1024' } });
    const big = await call(app, '/today/echo', {
      user: 'user-a',
      method: 'POST',
      origin: BASE,
      form: { a: 'x'.repeat(4096) },
      headers: { 'content-length': String(4098) },
    });
    assert.equal(big.status, 413);
    assert.equal((await call(app, '/today/echo', { user: 'user-a', method: 'POST', origin: BASE, form: { a: '1' } })).status, 200);
  });
});
