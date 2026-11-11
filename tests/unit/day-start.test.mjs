import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { rateKey } from '../../app/core/rate-store.mjs';
import { RUNS_SQL } from '../../app/core/routes-jobs.mjs';
import { DAY_START_PATHS, DAY_START_STATES, schedulerOff, kstDate, createDayStart, registerCollectRoutes } from '../../app/core/day-start.mjs';
import { createTestDb, WS_A, WS_B } from './helpers/fake-platform.mjs';

const WS_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const WS_DEMO = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
// 2026-11-04 10:00 KST
const NOW = new Date('2026-11-04T01:00:00Z');
const TODAY = '2026-11-04';
const ORIGIN = 'http://app.test';
const ON = { APP_SCHEDULER_OFF: '1', APP_JOB_TOKEN: 'job-secret', APP_BASE_URL: ORIGIN };

const quietLog = () => {
  const warns = [];
  return { warns, warn: (obj, msg) => warns.push({ obj, msg }) };
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = () => new Promise((r) => setTimeout(r, 20));

let db;
before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db.close();
});

/** db.admin 호출 수를 센다 */
function countingDb() {
  const spy = { calls: 0, admin: async (...a) => (spy.calls++, db.admin(...a)) };
  return spy;
}

describe('day-start: helpers', () => {
  test('constants, schedulerOff and kstDate', () => {
    assert.deepEqual(DAY_START_PATHS, { collect: '/api/jobs/collect?all=1', demoReset: '/api/jobs/demo-reset' });
    assert.deepEqual(DAY_START_STATES, ['off', 'pending', 'running', 'done']);
    assert.equal(schedulerOff({ APP_SCHEDULER_OFF: '1' }), true);
    assert.equal(schedulerOff({ APP_SCHEDULER_OFF: '0' }), false);
    assert.equal(schedulerOff({}), false);
    assert.equal(schedulerOff(undefined), false);
    assert.equal(kstDate(new Date('2026-11-04T14:59:59Z')), '2026-11-04');
    assert.equal(kstDate(new Date('2026-11-04T15:00:00Z')), '2026-11-05');
  });
});

describe('day-start: claim and touch', () => {
  beforeEach(async () => {
    await db.admin('DELETE FROM rate_limits');
  });

  test('APP_SCHEDULER_OFF missing → enabled false, touch/status make no DB call and never kick', async () => {
    const spy = countingDb();
    let kicks = 0;
    const ds = createDayStart({ db: spy, env: { APP_JOB_TOKEN: 'x' }, now: () => NOW, kick: async () => (kicks++, json({ remaining: 0 })) });
    assert.equal(ds.enabled, false);
    assert.deepEqual(await ds.touch('collect', ORIGIN), { kicked: false, state: 'off' });
    assert.deepEqual(await ds.status(), { date: TODAY, collect: 'off', demoReset: 'off' });
    assert.equal(spy.calls, 0);
    assert.equal(kicks, 0);
  });

  test('scheduler off without APP_JOB_TOKEN stays disabled', () => {
    const ds = createDayStart({ db, env: { APP_SCHEDULER_OFF: '1' }, now: () => NOW, kick: async () => json({}) });
    assert.equal(ds.enabled, false);
  });

  for (const base of [undefined, '', '   ', 'not a url']) {
    test(`scheduler off with APP_BASE_URL ${JSON.stringify(base)} → disabled, warns once, never kicks even for a request origin`, async () => {
      const spy = countingDb();
      const log = quietLog();
      let kicks = 0;
      const env = { APP_SCHEDULER_OFF: '1', APP_JOB_TOKEN: 'job-secret', ...(base === undefined ? {} : { APP_BASE_URL: base }) };
      const ds = createDayStart({ db: spy, env, now: () => NOW, log, kick: async () => (kicks++, json({ remaining: 0 })) });
      assert.equal(ds.enabled, false);
      assert.deepEqual(await ds.touch('collect', 'http://attacker.example'), { kicked: false, state: 'off' });
      assert.deepEqual(await ds.touch('demoReset', 'http://attacker.example'), { kicked: false, state: 'off' });
      assert.deepEqual(await ds.status(), { date: TODAY, collect: 'off', demoReset: 'off' });
      assert.equal(kicks, 0);
      assert.equal(spy.calls, 0);
      assert.equal(log.warns.length, 1);
      assert.ok(!JSON.stringify(log.warns).includes('job-secret'));
    });
  }

  test('APP_BASE_URL set → kicks only its origin, whatever origin the caller passes', async () => {
    const urls = [];
    const log = quietLog();
    const ds = createDayStart({
      db,
      env: { ...ON, APP_BASE_URL: 'https://radar.example/some/path?q=1' },
      now: () => NOW,
      log,
      kick: async (url) => (urls.push(String(url)), json({ remaining: 0 })),
    });
    assert.equal(ds.enabled, true);
    await ds.touch('collect', 'http://attacker.example');
    assert.deepEqual(urls, ['https://radar.example/api/jobs/collect?all=1']);
    assert.equal(log.warns.length, 0);
  });

  test('first touch kicks the collect URL; remaining 0 → done; second touch kicks 0 times with no DB call', async () => {
    const spy = countingDb();
    const urls = [];
    const ds = createDayStart({ db: spy, env: ON, now: () => NOW, kick: async (url) => (urls.push(String(url)), json({ remaining: 0 })) });
    assert.equal(ds.enabled, true);
    assert.deepEqual(await ds.touch('collect', ORIGIN), { kicked: true, state: 'done' });
    assert.deepEqual(urls, [`${ORIGIN}/api/jobs/collect?all=1`]);
    assert.equal(await ds.state('collect', TODAY), 'done');
    const calls = spy.calls;
    assert.deepEqual(await ds.touch('collect', ORIGIN), { kicked: false, state: 'done' });
    assert.equal(spy.calls, calls);
    assert.equal(urls.length, 1);
    // 다른 인스턴스도 같은 날엔 킥하지 않는다
    let other = 0;
    const ds2 = createDayStart({ db, env: ON, now: () => NOW, kick: async () => (other++, json({ remaining: 0 })) });
    assert.deepEqual(await ds2.touch('collect', ORIGIN), { kicked: false, state: 'done' });
    assert.equal(other, 0);
  });

  test('finish keeps the row until the next KST midnight', async () => {
    const ds = createDayStart({ db, env: ON, now: () => NOW, kick: async () => json({ remaining: 0 }) });
    await ds.touch('collect', ORIGIN);
    const r = await db.admin('SELECT hits, extract(epoch from reset_at - now()) AS s FROM rate_limits WHERE key = $1', [rateKey(`daystart:collect:${TODAY}`)]);
    assert.equal(Number(r.rows[0].hits), 2);
    // NOW 는 KST 10:00 → 자정까지 14시간
    assert.ok(Math.abs(Number(r.rows[0].s) - 14 * 3600) < 60, String(r.rows[0].s));
  });

  test('remaining 2 → claim released, next touch kicks again', async () => {
    let remaining = 2;
    let kicks = 0;
    const ds = createDayStart({ db, env: ON, now: () => NOW, kick: async () => (kicks++, json({ remaining })) });
    assert.deepEqual(await ds.touch('collect', ORIGIN), { kicked: true, state: 'running' });
    await flush();
    assert.equal(await ds.state('collect', TODAY), 'pending');
    remaining = 0;
    assert.deepEqual(await ds.touch('collect', ORIGIN), { kicked: true, state: 'done' });
    assert.equal(kicks, 2);
  });

  test('kick throws → released and warned; next touch kicks again', async () => {
    const log = quietLog();
    let kicks = 0;
    const ds = createDayStart({
      db, env: ON, now: () => NOW, log,
      kick: async () => {
        kicks++;
        if (kicks === 1) throw Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
        return json({ remaining: 0 });
      },
    });
    assert.equal((await ds.touch('collect', ORIGIN)).kicked, true);
    await flush();
    assert.equal(await ds.state('collect', TODAY), 'pending');
    assert.equal(log.warns.length, 1);
    assert.equal(log.warns[0].obj.code, 'ECONNREFUSED');
    assert.ok(!JSON.stringify(log.warns).includes('connect refused'));
    assert.deepEqual(await ds.touch('collect', ORIGIN), { kicked: true, state: 'done' });
    assert.equal(kicks, 2);
  });

  test('non-200 kick response → released', async () => {
    const ds = createDayStart({ db, env: ON, now: () => NOW, kick: async () => json({ error: 'forbidden' }, 403) });
    await ds.touch('collect', ORIGIN);
    await flush();
    assert.equal(await ds.state('collect', TODAY), 'pending');
  });

  test('slow kick: touch returns after waitMs with running; another touch does not kick', async () => {
    let resolveKick;
    let kicks = 0;
    const ds = createDayStart({ db, env: ON, now: () => NOW, kick: () => (kicks++, new Promise((r) => (resolveKick = r))) });
    const t0 = Date.now();
    assert.deepEqual(await ds.touch('collect', ORIGIN, { waitMs: 30 }), { kicked: true, state: 'running' });
    assert.ok(Date.now() - t0 < 1000);
    const ds2 = createDayStart({ db, env: ON, now: () => NOW, kick: async () => (kicks++, json({ remaining: 0 })) });
    assert.deepEqual(await ds2.touch('collect', ORIGIN), { kicked: false, state: 'running' });
    assert.equal(kicks, 1);
    assert.deepEqual(await ds.status(), { date: TODAY, collect: 'running', demoReset: 'pending' });
    resolveKick(json({ remaining: 0 }));
    await flush();
    assert.equal(await ds2.state('collect', TODAY), 'done');
  });

  test('running claim past its TTL is re-acquired', async () => {
    const ds = createDayStart({ db, env: ON, now: () => NOW, kick: () => new Promise(() => {}) });
    await ds.touch('collect', ORIGIN, { waitMs: 5 });
    assert.equal(await ds.claim('collect', TODAY), false);
    await db.admin("UPDATE rate_limits SET reset_at = now() - interval '1 second' WHERE key = $1", [rateKey(`daystart:collect:${TODAY}`)]);
    assert.equal(await ds.state('collect', TODAY), 'pending');
    let kicks = 0;
    const ds2 = createDayStart({ db, env: ON, now: () => NOW, kick: async () => (kicks++, json({ remaining: 0 })) });
    assert.deepEqual(await ds2.touch('collect', ORIGIN), { kicked: true, state: 'done' });
    assert.equal(kicks, 1);
  });

  test('APP_DAY_START_CLAIM_TTL_MS sets the running claim lifetime', async () => {
    const ds = createDayStart({ db, env: { ...ON, APP_DAY_START_CLAIM_TTL_MS: '120000' }, now: () => NOW });
    assert.equal(await ds.claim('collect', TODAY), true);
    const r = await db.admin('SELECT extract(epoch from reset_at - now()) AS s FROM rate_limits WHERE key = $1', [rateKey(`daystart:collect:${TODAY}`)]);
    assert.ok(Math.abs(Number(r.rows[0].s) - 120) < 5);
    await ds.release('collect', TODAY);
    assert.equal(await ds.state('collect', TODAY), 'pending');
  });

  test('demoReset: body.ok true → done; ok false → released; separate from collect; new day starts over', async () => {
    let ok = false;
    const urls = [];
    let now = NOW;
    const ds = createDayStart({ db, env: ON, now: () => now, kick: async (url) => (urls.push(String(url)), json({ ok })) });
    await ds.touch('demoReset', ORIGIN, { waitMs: 500 });
    await flush();
    assert.equal(await ds.state('demoReset', TODAY), 'pending');
    ok = true;
    assert.deepEqual(await ds.touch('demoReset', ORIGIN, { waitMs: 500 }), { kicked: true, state: 'done' });
    assert.deepEqual(urls, [`${ORIGIN}/api/jobs/demo-reset`, `${ORIGIN}/api/jobs/demo-reset`]);
    assert.deepEqual(await ds.status(), { date: TODAY, collect: 'pending', demoReset: 'done' });
    now = new Date('2026-11-04T15:00:00Z');
    assert.deepEqual(await ds.touch('demoReset', ORIGIN), { kicked: true, state: 'done' });
    assert.equal(urls.length, 3);
  });
});

describe('day-start: GET /api/jobs/collect', () => {
  const ALL = [WS_A, WS_B, WS_C, WS_DEMO];
  let calls;
  let failIds;
  let clock;
  let onRun;
  const makeApp = (env = {}, extra = {}) => {
    const app = new Hono();
    registerCollectRoutes(app, {
      env,
      jobAuthorized: (req) => req.headers.get('x-job-token') === 'job-secret',
      workspaceIds: async () => ALL,
      activeWorkspaceIds: async (ids) => ids,
      isDemoWorkspace: async (id) => id === WS_DEMO,
      runIn: (id, fn) =>
        db.withWorkspace(id, () =>
          fn({
            ctx: {
              jobs: {
                runDaily: async ({ date }) => {
                  calls.push([id, date]);
                  onRun?.();
                  if (failIds.includes(id)) throw Object.assign(new Error('boom'), { code: 'NARA_DOWN' });
                  return { count: 1 };
                },
              },
            },
          }),
        ),
      db,
      now: () => new Date(clock),
      ...extra,
    });
    return app;
  };
  const get = (app, qs = '?all=1', token = 'job-secret') =>
    app.request(`/api/jobs/collect${qs}`, { headers: token ? { 'x-job-token': token } : {} });
  const runOf = (id, date = TODAY) => db.withWorkspace(id, () => db.get(RUNS_SQL, ['daily', date]));

  beforeEach(async () => {
    calls = [];
    failIds = [];
    clock = NOW.getTime();
    onRun = null;
    for (const id of ALL) await db.withWorkspace(id, () => db.run('DELETE FROM job_runs'));
  });

  test('403 without job token, 400 without all=1, 400 on bad date', async () => {
    const app = makeApp();
    let r = await get(app, '?all=1', null);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: 'forbidden' });
    r = await get(app, '?all=1', 'wrong');
    assert.equal(r.status, 403);
    r = await get(app, '');
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'all_required' });
    r = await get(app, '?all=1&date=2026-13-01');
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'bad_date' });
    assert.equal(calls.length, 0);
  });

  test('runs every active non-demo company for today (KST) and records job_runs done', async () => {
    const r = await get(makeApp());
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { date: TODAY, total: 3, processed: 3, failed: 0, skipped: 0, remaining: 0 });
    assert.deepEqual(calls, [[WS_A, TODAY], [WS_B, TODAY], [WS_C, TODAY]]);
    for (const id of [WS_A, WS_B, WS_C]) {
      const row = await runOf(id);
      assert.equal(row.status, 'done');
      assert.equal(row.run_id, `daily:${TODAY}:${id}`);
    }
    // 데모 회사는 돌지 않고 기록도 없다
    assert.equal(await runOf(WS_DEMO), null);
  });

  test('inactive companies are left out (activeWorkspaceIds)', async () => {
    const app = makeApp({}, { activeWorkspaceIds: async (ids) => ids.filter((id) => id !== WS_B) });
    const body = await (await get(app)).json();
    assert.equal(body.total, 2);
    assert.deepEqual(calls.map((c) => c[0]), [WS_A, WS_C]);
  });

  test('company with job_runs done for the date is skipped; explicit date is used', async () => {
    const app = makeApp();
    await get(app, '?all=1&date=2026-11-01');
    calls = [];
    await db.withWorkspace(WS_B, () => db.run('DELETE FROM job_runs'));
    const body = await (await get(app, '?all=1&date=2026-11-01')).json();
    assert.deepEqual(body, { date: '2026-11-01', total: 3, processed: 1, failed: 0, skipped: 2, remaining: 0 });
    assert.deepEqual(calls, [[WS_B, '2026-11-01']]);
  });

  test('failed company is recorded failed with its code and does not stop the others', async () => {
    failIds = [WS_A];
    const body = await (await get(makeApp())).json();
    assert.deepEqual(body, { date: TODAY, total: 3, processed: 2, failed: 1, skipped: 0, remaining: 0 });
    const row = await runOf(WS_A);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, 'NARA_DOWN');
    // 다음 실행은 실패한 회사만 다시 돈다
    failIds = [];
    calls = [];
    const again = await (await get(makeApp())).json();
    assert.deepEqual(again, { date: TODAY, total: 3, processed: 1, failed: 0, skipped: 2, remaining: 0 });
    assert.equal((await runOf(WS_A)).attempt, 2);
  });

  test('stops after APP_DAY_START_MAX_MS and reports remaining > 0', async () => {
    onRun = () => {
      clock += 2000;
    };
    const app = makeApp({ APP_DAY_START_MAX_MS: '1500' });
    const body = await (await get(app)).json();
    assert.deepEqual(body, { date: TODAY, total: 3, processed: 1, failed: 0, skipped: 0, remaining: 2 });
    assert.equal(calls.length, 1);
    const next = await (await get(app)).json();
    assert.equal(next.skipped, 1);
    assert.equal(next.processed, 1);
    assert.equal(next.remaining, 1);
  });
});
