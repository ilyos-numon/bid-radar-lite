import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { createTestDb, createFakePlatform } from './helpers/fake-platform.mjs';
import { createHtml } from '../../app/core/html.mjs';
import { createRouter } from '../../app/core/router.mjs';
import { openDb, LEGACY_WS } from '../../app/core/db.mjs';
import { isPlatformAdmin, createOpsStats, OPS_TEXT } from '../../app/core/ops/stats.mjs';
import { registerAdminRoutes } from '../../app/core/ops/admin-routes.mjs';
import { registerStatusRoutes } from '../../app/core/ops/status-routes.mjs';

const W1 = '11111111-1111-4111-8111-111111111111';
const W2 = '22222222-2222-4222-8222-222222222222';
const W3 = '33333333-3333-4333-8333-333333333333';
const WD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const TODAY = '2026-11-05';
const T0 = new Date('2026-11-05T03:00:00.000Z'); // 12:00 KST

const DEMO_DDL = `CREATE TABLE IF NOT EXISTS demo_workspaces (
  workspace_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL,
  staff_user_ids uuid[] NOT NULL DEFAULT '{}',
  seeded_at timestamptz,
  reset_count integer NOT NULL DEFAULT 0
);`;

let db;
before(async () => {
  db = await createTestDb();
  await db.admin(DEMO_DDL);
});
after(async () => {
  await db.close();
});
beforeEach(async () => {
  for (const t of ['subscriptions', 'payments', 'billing_jobs', 'demo_workspaces']) await db.admin(`DELETE FROM ${t}`);
  for (const ws of [W1, W2, W3, WD]) {
    await db.withWorkspace(ws, async () => {
      for (const t of ['collect_days', 'job_runs', 'notification_deliveries']) await db.run(`DELETE FROM ${t}`);
    });
  }
});

/** db 호출 수를 세는 감싸개 */
function counting(base) {
  const calls = { n: 0 };
  const wrapped = {
    ...base,
    admin: (...a) => {
      calls.n += 1;
      return base.admin(...a);
    },
    all: (...a) => {
      calls.n += 1;
      return base.all(...a);
    },
    withWorkspace: (...a) => base.withWorkspace(...a),
  };
  return { db: wrapped, calls };
}

async function sub(ws, plan, status) {
  await db.admin('INSERT INTO subscriptions (workspace_id, plan, status, customer_key) VALUES ($1, $2, $3, $4)', [ws, plan, status, `ck-${ws}`]);
}

async function collectDay(ws, day, count, ranAt, source = 'nara') {
  await db.withWorkspace(ws, () =>
    db.run('INSERT INTO collect_days (source_id, day, ok, count, ran_at) VALUES ($1, $2, 1, $3, $4)', [source, day, count, ranAt]),
  );
}

async function delivery(ws, kind, date, status) {
  await db.withWorkspace(ws, () =>
    db.run("INSERT INTO notification_deliveries (kind, date, run_id, status, created_at) VALUES ($1, $2, 'r', $3, '2026-11-05')", [kind, date, status]),
  );
}

async function jobRun(ws, job, date, status) {
  await db.withWorkspace(ws, () => db.run("INSERT INTO job_runs (job, date, run_id, status) VALUES ($1, $2, 'r', $3)", [job, date, status]));
}

function statsWith(opts = {}) {
  return createOpsStats({
    db: opts.db ?? db,
    workspaceIds: async () => opts.ids ?? [W1, W2, W3, WD],
    demoWorkspaceId: async () => (opts.demo === undefined ? WD : opts.demo),
    queue: opts.queue ?? { depth: async () => 4 },
    readiness: opts.readiness ?? (async () => true),
    now: opts.now ?? (() => T0),
    ...(opts.cacheMs !== undefined ? { cacheMs: opts.cacheMs } : {}),
  });
}

describe('ops: isPlatformAdmin', () => {
  test('comma list, trim, case-insensitive', () => {
    const env = { APP_PLATFORM_ADMIN_EMAILS: ' Ops@Example.com , second@example.com ' };
    assert.equal(isPlatformAdmin(env, 'ops@example.com'), true);
    assert.equal(isPlatformAdmin(env, 'SECOND@example.COM'), true);
    assert.equal(isPlatformAdmin(env, 'other@example.com'), false);
  });
  test('empty env or empty email -> nobody', () => {
    assert.equal(isPlatformAdmin({}, 'ops@example.com'), false);
    assert.equal(isPlatformAdmin({ APP_PLATFORM_ADMIN_EMAILS: '' }, 'ops@example.com'), false);
    assert.equal(isPlatformAdmin({ APP_PLATFORM_ADMIN_EMAILS: 'a@example.com,,' }, ''), false);
    assert.equal(isPlatformAdmin({ APP_PLATFORM_ADMIN_EMAILS: 'a@example.com' }, null), false);
  });
});

describe('ops: adminSummary', () => {
  test('MRR counts active starter 2 + team 1 = 137000, other statuses excluded', async () => {
    await sub(W1, 'starter', 'active');
    await sub(W2, 'starter', 'active');
    await sub(W3, 'team', 'active');
    await sub(WD, 'trial', 'trialing');
    const s = await statsWith().adminSummary();
    assert.equal(s.mrr, 137000);
    assert.deepEqual(s.subscriptions, { trialing: 1, active: 3, past_due: 0, canceled: 0, expired: 0 });
    assert.deepEqual(s.workspaces, { total: 4, demo: 1 });
    assert.equal(s.example, false);
    assert.equal(s.at, T0.toISOString());
  });

  test('past_due team is not revenue', async () => {
    await sub(W1, 'team', 'past_due');
    await sub(W2, 'starter', 'active');
    const s = await statsWith().adminSummary();
    assert.equal(s.mrr, 29000);
    assert.equal(s.subscriptions.past_due, 1);
  });

  test('payment failures in last 30 days only; billing today; queue; demo reset', async () => {
    const ins = 'INSERT INTO payments (workspace_id, order_id, plan, amount, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)';
    await db.admin(ins, [W1, 'o1', 'starter', 29000, 'failed', '2026-11-01T00:00:00Z']);
    await db.admin(ins, [W1, 'o2', 'starter', 29000, 'failed', '2026-10-20T00:00:00Z']);
    await db.admin(ins, [W2, 'o3', 'starter', 29000, 'failed', '2026-09-01T00:00:00Z']);
    await db.admin(ins, [W2, 'o4', 'starter', 29000, 'paid', '2026-11-02T00:00:00Z']);
    await db.admin('INSERT INTO billing_jobs (run_date, charged, failed, expired) VALUES ($1, 3, 1, 2)', [TODAY]);
    await db.admin('INSERT INTO demo_workspaces (workspace_id, owner_user_id, seeded_at, reset_count) VALUES ($1, $2, $3, 7)', [
      WD,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      '2026-11-04T19:00:00Z',
    ]);
    const s = await statsWith().adminSummary();
    assert.equal(s.paymentFailures30d, 2);
    assert.deepEqual(s.billingToday, { charged: 3, failed: 1, expired: 2 });
    assert.equal(s.queueDepth, 4);
    assert.equal(s.demo.resetCount, 7);
    assert.equal(s.demo.seededAt, '2026-11-04T19:00:00.000Z');
  });

  test('jobs today grouped by job and status across workspaces; other days ignored', async () => {
    await jobRun(W1, 'daily', TODAY, 'done');
    await jobRun(W2, 'daily', TODAY, 'failed');
    await jobRun(W3, 'daily', TODAY, 'dead');
    await jobRun(W1, 'reminders', TODAY, 'done');
    await jobRun(W2, 'support', '2026-11-04', 'done');
    await jobRun(W3, 'support', TODAY, 'queued');
    const s = await statsWith().adminSummary();
    assert.deepEqual(s.jobsToday, {
      daily: { done: 1, failed: 1, dead: 1 },
      reminders: { done: 1, failed: 0, dead: 0 },
      support: { done: 0, failed: 0, dead: 0 },
    });
  });

  test('nothing yet: billingToday null, queue null without queue, demo null without demo', async () => {
    const s = await createOpsStats({ db, workspaceIds: async () => [W1], now: () => T0 }).adminSummary();
    assert.equal(s.billingToday, null);
    assert.equal(s.queueDepth, null);
    assert.equal(s.demo, null);
    assert.equal(s.example, false);
    assert.equal(s.mrr, 0);
  });

  test('only the demo company -> example true', async () => {
    const s = await statsWith({ ids: [WD] }).adminSummary();
    assert.equal(s.example, true);
    assert.deepEqual(s.demo, { seededAt: null, resetCount: 0 });
  });
});

describe('ops: publicStatus', () => {
  test('real companies only: sum, last run, sent deliveries; demo numbers excluded', async () => {
    await collectDay(W1, TODAY, 12, '2026-11-05T07:30:00+09:00');
    await collectDay(W2, TODAY, 5, '2026-11-05T07:31:00+09:00');
    await collectDay(W2, '2026-11-04', 99, '2026-11-04T07:31:00+09:00');
    await collectDay(WD, TODAY, 1000, '2026-11-05T08:00:00+09:00');
    await delivery(W1, 'bids', TODAY, 'sent');
    await delivery(W2, 'bids', TODAY, 'failed');
    await delivery(W3, 'bids', TODAY, 'sent');
    await delivery(WD, 'bids', TODAY, 'sent');
    const s = await statsWith().publicStatus();
    assert.deepEqual(s, { date: TODAY, bids: 17, lastRunAt: '2026-11-05T07:31:00+09:00', deliveries: 2, status: 'ok', example: false, collect: { trigger: 'scheduled', state: 'off' } });
  });

  test('no real data -> demo numbers with example true', async () => {
    await collectDay(WD, TODAY, 14, '2026-11-05T04:00:00+09:00');
    await delivery(WD, 'bids', TODAY, 'sent');
    await delivery(W1, 'bids', TODAY, 'sent');
    const s = await statsWith().publicStatus();
    assert.equal(s.example, true);
    assert.equal(s.bids, 14);
    assert.equal(s.deliveries, 1);
    assert.equal(s.lastRunAt, '2026-11-05T04:00:00+09:00');
  });

  test('no data and no demo -> zero, lastRunAt null, example false', async () => {
    const s = await statsWith({ demo: null }).publicStatus();
    assert.deepEqual(s, { date: TODAY, bids: 0, lastRunAt: null, deliveries: 0, status: 'ok', example: false, collect: { trigger: 'scheduled', state: 'off' } });
  });

  test('readiness false or throwing -> degraded', async () => {
    assert.equal((await statsWith({ readiness: async () => false }).publicStatus()).status, 'degraded');
    assert.equal(
      (await statsWith({ readiness: async () => { throw new Error('down'); } }).publicStatus()).status,
      'degraded',
    );
  });

  test('cached 60 seconds: second call makes no queries, after 60s queries again', async () => {
    await collectDay(W1, TODAY, 3, '2026-11-05T07:30:00+09:00');
    let t = T0.getTime();
    const { db: cdb, calls } = counting(db);
    const stats = statsWith({ db: cdb, now: () => new Date(t) });
    const a = await stats.publicStatus();
    const first = calls.n;
    assert.ok(first > 0);
    await collectDay(W1, TODAY, 3, '2026-11-05T07:40:00+09:00', 'other');
    t += 59_000;
    const b = await stats.publicStatus();
    assert.equal(calls.n, first, 'second call within 60s must not query');
    assert.deepEqual(b, a);
    t += 1_000;
    const c = await stats.publicStatus();
    assert.ok(calls.n > first);
    assert.equal(c.bids, 6);
  });

  test('collect: first-visit trigger reports the day start state fresh on every call (not cached)', async () => {
    let state = 'pending';
    const dayStart = { enabled: true, status: async () => ({ date: TODAY, collect: state, demoReset: 'off' }) };
    const stats = createOpsStats({ db, workspaceIds: async () => [W1], now: () => T0, dayStart });
    assert.deepEqual((await stats.publicStatus()).collect, { trigger: 'first-visit', state: 'pending' });
    state = 'done';
    assert.deepEqual((await stats.publicStatus()).collect, { trigger: 'first-visit', state: 'done' });
  });

  test('collect: disabled day start is scheduled with its own state; failing status falls back to off', async () => {
    const off = { enabled: false, status: async () => ({ date: TODAY, collect: 'off', demoReset: 'off' }) };
    assert.deepEqual((await createOpsStats({ db, workspaceIds: async () => [W1], now: () => T0, dayStart: off }).publicStatus()).collect, {
      trigger: 'scheduled',
      state: 'off',
    });
    const broken = { enabled: true, status: async () => { throw new Error('db down'); } };
    assert.deepEqual((await createOpsStats({ db, workspaceIds: async () => [W1], now: () => T0, dayStart: broken }).publicStatus()).collect, {
      trigger: 'first-visit',
      state: 'off',
    });
  });

  test('works on a single-company file database (no platform tables)', async () => {
    const lite = await openDb({ memory: true });
    try {
      await lite.applySchema(new URL('../../app/core/schema.sql', import.meta.url));
      await lite.withWorkspace(LEGACY_WS, () =>
        lite.run("INSERT INTO collect_days (source_id, day, ok, count, ran_at) VALUES ('nara', $1, 1, 8, '2026-11-05T07:30:00+09:00')", [TODAY]),
      );
      const stats = createOpsStats({ db: lite, workspaceIds: async () => [LEGACY_WS], now: () => T0 });
      const s = await stats.publicStatus();
      assert.equal(s.bids, 8);
      assert.equal(s.example, false);
      const a = await stats.adminSummary();
      assert.equal(a.mrr, 0);
      assert.equal(a.billingToday, null);
    } finally {
      await lite.close();
    }
  });
});

const ADMIN = 'ops-admin';
function adminApp({ env = { APP_PLATFORM_ADMIN_EMAILS: `${ADMIN}@example.com` } } = {}) {
  const app = new Hono();
  const platform = createFakePlatform();
  const plain = createHtml({ menus: () => [], env: {} });
  const page = async (status, opts) => plain.page(status, opts);
  registerAdminRoutes(app, { env, platform, stats: statsWith(), page });
  return app;
}
const as = (user) => ({ headers: { cookie: `fake-user=${user}` } });

describe('ops: admin routes', () => {
  test('signed out -> 302 /welcome', async () => {
    const res = await adminApp().request('/admin');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/welcome');
  });

  test('signed in but not admin -> 404 for page and json', async () => {
    const app = adminApp();
    const page = await app.request('/admin', as('someone'));
    assert.equal(page.status, 404);
    assert.ok(!(await page.text()).includes(OPS_TEXT.admin.title));
    const json = await app.request('/admin.json', as('someone'));
    assert.equal(json.status, 404);
    assert.deepEqual(await json.json(), { error: 'not_found' });
  });

  test('empty admin list -> 404 even for a signed-in user', async () => {
    const res = await adminApp({ env: {} }).request('/admin', as(ADMIN));
    assert.equal(res.status, 404);
  });

  test('admin sees 7 tiles and MRR 137,000원; json has the summary', async () => {
    await sub(W1, 'starter', 'active');
    await sub(W2, 'starter', 'active');
    await sub(W3, 'team', 'active');
    const app = adminApp();
    const res = await app.request('/admin', as(ADMIN));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('137,000원'));
    assert.ok(html.includes('<body class="bare">'));
    for (const label of OPS_TEXT.admin.tiles) assert.ok(html.includes(`<dt>${label}</dt>`), label);
    assert.equal((html.match(/<dt>/g) ?? []).length, 7);
    const json = await app.request('/admin.json', as(ADMIN));
    assert.equal(json.status, 200);
    const body = await json.json();
    assert.equal(body.mrr, 137000);
    assert.equal(body.workspaces.total, 4);
  });
});

describe('ops: status routes', () => {
  const plain = createHtml({ menus: () => [], env: {} });
  const page = async (status, opts) => plain.page(status, opts);

  test('Hono: /status bare page with example label when only demo data', async () => {
    await collectDay(WD, TODAY, 14, '2026-11-05T04:00:00+09:00');
    const app = new Hono();
    registerStatusRoutes(app, { stats: statsWith(), page });
    const res = await app.request('/status');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('<body class="bare">'));
    for (const w of [OPS_TEXT.status.title, OPS_TEXT.status.bids, OPS_TEXT.status.lastRun, OPS_TEXT.status.deliveries, OPS_TEXT.status.example, OPS_TEXT.status.ok]) {
      assert.ok(html.includes(w), w);
    }
    assert.ok(html.includes('14건'));
    const json = await app.request('/status.json');
    assert.equal(json.status, 200);
    const body = await json.json();
    assert.equal(body.example, true);
    assert.equal(body.bids, 14);
  });

  test('createRouter: same routes work, real data has no example label', async () => {
    await collectDay(W1, TODAY, 2, '2026-11-05T07:30:00+09:00');
    const router = createRouter({ ctx: {}, memberFrom: () => null, onNotFound: () => new Response('nf', { status: 404 }), onError: () => new Response('err', { status: 500 }) });
    registerStatusRoutes(router, { stats: statsWith({ readiness: async () => false }), page });
    const res = await router.fetch(new Request('http://localhost/status'));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes(OPS_TEXT.status.example));
    assert.ok(html.includes(OPS_TEXT.status.degraded));
    const json = await router.fetch(new Request('http://localhost/status.json'));
    const body = await json.json();
    assert.equal(body.example, false);
    assert.equal(body.status, 'degraded');
    assert.equal(body.bids, 2);
  });

  test('first-visit trigger adds the 오늘 수집 tile with the state wording; scheduled mode has none', async () => {
    const T = OPS_TEXT.status.collect;
    for (const [state, word] of [['pending', T.pending], ['running', T.running], ['done', T.done]]) {
      const app = new Hono();
      const dayStart = { enabled: true, status: async () => ({ date: TODAY, collect: state, demoReset: 'off' }) };
      registerStatusRoutes(app, { stats: createOpsStats({ db, workspaceIds: async () => [W1], now: () => T0, dayStart }), page });
      const html = await (await app.request('/status')).text();
      assert.ok(html.includes(`<dt>${T.label}</dt><dd>${word}</dd>`), state);
      assert.deepEqual((await (await app.request('/status.json')).json()).collect, { trigger: 'first-visit', state });
    }
    const app = new Hono();
    registerStatusRoutes(app, { stats: statsWith(), page });
    assert.ok(!(await (await app.request('/status')).text()).includes(`<dt>${T.label}</dt>`));
  });

  test('no collection yet shows the not-yet text', async () => {
    const app = new Hono();
    registerStatusRoutes(app, { stats: statsWith({ demo: null }), page });
    const html = await (await app.request('/status')).text();
    assert.ok(html.includes(OPS_TEXT.status.none));
  });
});
