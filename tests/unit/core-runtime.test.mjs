import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../app/core/registry.mjs';
import { openDb } from '../../app/core/db.mjs';
import { esc, reasons, dday, empty, error } from '../../app/core/html.mjs';

const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/** files: { 'dir/manifest.mjs': 'source', ... } */
function makeDir(files) {
  const root = tmp('br-mod-');
  for (const [rel, src] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return root;
}

function manifest({ id, title, group, order, path: p, help = '도움말', extra = '', routes }) {
  return `export default {
  id: ${JSON.stringify(id)}, title: ${JSON.stringify(title)}, group: ${JSON.stringify(group)}, order: ${order},
  path: ${JSON.stringify(p)}, help: ${JSON.stringify(help)},
  ${extra}
  routes(router, ctx) { ${routes ?? `router.get(${JSON.stringify(p)}, (req, params, c, member) => c.html.layout({ title: ${JSON.stringify(title)}, help: ${JSON.stringify(help)}, body: '<p>${id} body</p>', member, active: ${JSON.stringify(id)} }));`} },
};
`;
}

const emptyCore = () => tmp('br-core-');
const stubFetch = async () => new Response('{}');

async function rt(modulesDir, extra = {}) {
  return createRuntime({
    dbPath: ':memory:',
    modulesDir,
    secret: 'x',
    jobToken: 't',
    env: {},
    fetchImpl: stubFetch,
    coreDir: emptyCore(),
    ...extra,
  });
}

function req(r, url, init = {}) {
  return r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
}

function form(obj) {
  return { method: 'POST', body: new URLSearchParams(obj) };
}

async function setup(r) {
  const res = await req(r, '/setup', form({ company: '테스트 조경', name: '대표' }));
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0];
  return { res, cookie };
}

const threeModules = () =>
  makeDir({
    'today/manifest.mjs': manifest({ id: 'today', title: '오늘의 공고', group: '매일', order: 10, path: '/today', help: '오늘 도움말' }),
    'settings/manifest.mjs': manifest({ id: 'settings', title: '알림 설정', group: '설정', order: 40, path: '/settings' }),
    'summary/manifest.mjs': manifest({
      id: 'summary',
      title: '공고 요약',
      group: '공고 더 알기',
      order: 20,
      path: '/summary',
      extra: `schema: new URL('./schema.sql', import.meta.url), decorate() { return null; }, pickMaybe() { return null; }, adapters: [{ type: 'fake' }], jobs: { reminders() { return null; } },`,
    }),
    'summary/schema.sql': 'CREATE TABLE IF NOT EXISTS summary_items (bid_id TEXT PRIMARY KEY, status TEXT);',
  });

describe('registry', () => {
  test('registers modules: nav order, groups, hooks, schema', async () => {
    const r = await rt(threeModules());
    try {
      assert.deepEqual(r.modules.map((m) => m.id), ['today', 'summary', 'settings']);
      assert.equal(r.ctx.hooks.decorate.length, 1);
      assert.equal(r.ctx.hooks.pickMaybe.id, 'summary');
      assert.equal(r.ctx.hooks.adapters.length, 1);
      assert.equal(r.ctx.hooks.jobs.reminders[0].id, 'summary');
      await r.ctx.db.run("INSERT INTO summary_items (bid_id, status) VALUES ('a', 'ready')");
      assert.equal((await r.ctx.db.get('SELECT COUNT(*) AS n FROM summary_items')).n, 1);

      const { cookie } = await setup(r);
      const res = await req(r, '/summary', { headers: { cookie } });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /summary body/);
      const navStart = html.indexOf('<nav');
      assert.ok(navStart > 0, 'nav present');
      const navOrder = ['매일', '오늘의 공고', '공고 더 알기', '공고 요약', '설정', '알림 설정'].map((s) => html.indexOf(s, navStart));
      assert.ok(navOrder.every((v) => v >= 0), 'nav has all groups and titles');
      assert.deepEqual([...navOrder].sort((a, b) => a - b), navOrder, 'nav order');
      assert.match(html, /<a href="\/summary" title="도움말" aria-current="page">공고 요약<\/a>/);
      assert.match(html, /<p class="help">도움말<\/p>/);
      assert.doesNotMatch(html, /더 넓게/, 'empty group hidden');
    } finally {
      await r.close();
    }
  });

  test('missing modules directory → 0 modules', async () => {
    const r = await rt(path.join(tmp('br-none-'), 'nope'));
    try {
      assert.equal(r.modules.length, 0);
    } finally {
      await r.close();
    }
  });

  test('duplicate id fails and names both directories', async () => {
    const dir = makeDir({
      'a/manifest.mjs': manifest({ id: 'a', title: 'A', group: '매일', order: 1, path: '/a' }),
      'b/manifest.mjs': manifest({ id: 'a', title: 'B', group: '매일', order: 2, path: '/b' }),
    });
    await assert.rejects(rt(dir), (e) => {
      assert.match(e.message, /duplicate module id 'a'/);
      assert.ok(e.message.includes(path.join(dir, 'a')) && e.message.includes(path.join(dir, 'b')));
      return true;
    });
  });

  test('id different from directory name fails', async () => {
    const dir = makeDir({ 'x/manifest.mjs': manifest({ id: 'y', title: 'Y', group: '매일', order: 1, path: '/y' }) });
    await assert.rejects(rt(dir), /must equal its directory name 'x'/);
  });

  test('two pickMaybe modules fail', async () => {
    const dir = makeDir({
      'a/manifest.mjs': manifest({ id: 'a', title: 'A', group: '매일', order: 1, path: '/a', extra: 'pickMaybe() { return null; },' }),
      'b/manifest.mjs': manifest({ id: 'b', title: 'B', group: '매일', order: 2, path: '/b', extra: 'pickMaybe() { return null; },' }),
    });
    await assert.rejects(rt(dir), (e) => {
      assert.match(e.message, /only one module may define pickMaybe/);
      assert.ok(e.message.includes(path.join(dir, 'a')) && e.message.includes(path.join(dir, 'b')));
      return true;
    });
  });

  test('route outside own path is rejected; /api/<id>/ is allowed', async () => {
    const bad = makeDir({
      'a/manifest.mjs': manifest({ id: 'a', title: 'A', group: '매일', order: 1, path: '/a', routes: `router.get('/other', () => new Response('x'));` }),
    });
    await assert.rejects(rt(bad), /module 'a' may not register GET \/other/);
    const prefixTrick = makeDir({
      'a/manifest.mjs': manifest({ id: 'a', title: 'A', group: '매일', order: 1, path: '/a', routes: `router.post('/abc', () => new Response('x'));` }),
    });
    await assert.rejects(rt(prefixTrick), /may not register POST \/abc/);
    const ok = makeDir({
      'a/manifest.mjs': manifest({
        id: 'a', title: 'A', group: '매일', order: 1, path: '/a',
        routes: `router.get('/a/:x', (q, p) => new Response(p.x)); router.post('/api/a/go', () => Response.json({ ok: true }));`,
      }),
    });
    const r = await rt(ok);
    try {
      assert.equal(await (await req(r, '/a/hello')).text(), 'hello');
      assert.deepEqual(await (await req(r, '/api/a/go', { method: 'POST' })).json(), { ok: true });
    } finally {
      await r.close();
    }
  });

  test('core files: missing → skipped, present → create(ctx) merged in order', async () => {
    const r0 = await rt(tmp('br-m-'));
    try {
      for (const k of ['criteria', 'bids', 'matches', 'sources', 'bidText', 'llm', 'notify', 'jobs']) {
        assert.equal(r0.ctx[k], undefined, k);
      }
      for (const k of ['db', 'now', 'today', 'settings', 'members', 'html', 'log', 'env', 'fetch', 'hooks']) {
        assert.ok(r0.ctx[k] !== undefined, k);
      }
      assert.equal(r0.ctx.fetch, stubFetch);
    } finally {
      await r0.close();
    }

    const coreDir = makeDir({
      'criteria.mjs': `export function create(ctx) { return { criteria: { get: () => ({ keywords: ['조경'] }) } }; }`,
      'bids.mjs': `export function create(ctx) { return { bids: { seenCriteria: typeof ctx.criteria.get }, matches: {} }; }`,
      'routes-jobs.mjs': `export function registerRoutes(router, ctx) { router.get('/api/jobs/ping', (req) => ctx.auth.checkJob(req) ? Response.json({ pong: true }) : Response.json({ error: 'forbidden' }, { status: 403 })); }`,
    });
    const r = await rt(tmp('br-m-'), { coreDir });
    try {
      assert.deepEqual(r.ctx.criteria.get(), { keywords: ['조경'] });
      assert.equal(r.ctx.bids.seenCriteria, 'function');
      assert.deepEqual(r.ctx.matches, {});
      assert.equal((await req(r, '/api/jobs/ping')).status, 403);
      assert.equal((await req(r, '/api/jobs/ping', { headers: { 'x-job-token': 't' } })).status, 200);
    } finally {
      await r.close();
    }
  });

  test('settings, clock, fake now', async () => {
    const r = await rt(tmp('br-m-'), { env: { APP_FAKE_NOW: '2026-10-29' } });
    try {
      assert.equal(await r.ctx.settings.get('nope'), null);
      await r.ctx.settings.set('k', 'v1');
      await r.ctx.settings.set('k', 'v2');
      assert.equal(await r.ctx.settings.get('k'), 'v2');
      assert.equal(r.ctx.today(), '2026-10-29');
      assert.equal(r.ctx.now().toISOString(), '2026-10-29T03:00:00.000Z');
    } finally {
      await r.close();
    }
  });
});

describe('auth and core routes', () => {
  test('/healthz', async () => {
    const r = await rt(tmp('br-m-'));
    try {
      const res = await req(r, '/healthz');
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: 'ok' });
    } finally {
      await r.close();
    }
  });

  test('/ redirects: setup, welcome, today', async () => {
    const r = await rt(threeModules());
    try {
      let res = await req(r, '/');
      assert.equal(res.headers.get('location'), '/setup');
      const { cookie } = await setup(r);
      res = await req(r, '/');
      assert.equal(res.headers.get('location'), '/welcome');
      res = await req(r, '/', { headers: { cookie } });
      assert.equal(res.headers.get('location'), '/today');
    } finally {
      await r.close();
    }
  });

  test('setup: first succeeds with cookie, second is 409', async () => {
    const r = await rt(tmp('br-m-'));
    try {
      const page = await req(r, '/setup');
      assert.equal(page.status, 200);
      assert.match(await page.text(), /name="company"[\s\S]*name="name"/);
      const { res, cookie } = await setup(r);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/settings?first=1');
      const sc = res.headers.get('set-cookie');
      assert.match(sc, /^br_session=1\.[0-9a-f]{64};/);
      assert.match(sc, /HttpOnly/);
      assert.match(sc, /SameSite=Lax/);
      assert.match(sc, /Max-Age=15552000/);
      assert.ok(cookie.startsWith('br_session='));
      assert.equal(await r.ctx.settings.get('company_name'), '테스트 조경');
      assert.deepEqual(await r.ctx.members.list(), [{ id: 1, name: '대표', role: 'owner' }]);
      const again = await req(r, '/setup', form({ company: 'b', name: 'c' }));
      assert.equal(again.status, 409);
      assert.equal(await r.ctx.members.count(), 1);
    } finally {
      await r.close();
    }
  });

  test('forged or tampered cookie is rejected', async () => {
    const r = await rt(threeModules());
    try {
      const { cookie } = await setup(r);
      const value = cookie.slice('br_session='.length);
      const sig = value.split('.')[1];
      const forged = [
        `br_session=1.${'0'.repeat(64)}`,
        `br_session=2.${sig}`,
        `br_session=1.${sig.slice(0, -1)}`,
        'br_session=1',
        'br_session=abc.def',
      ];
      for (const c of forged) {
        const res = await req(r, '/', { headers: { cookie: c } });
        assert.equal(res.headers.get('location'), '/welcome', c);
      }
      const ok = await req(r, '/', { headers: { cookie: `other=1; ${cookie}` } });
      assert.equal(ok.headers.get('location'), '/today');
      const other = await rt(threeModules(), { secret: 'different' });
      try {
        await setup(other);
        const res = await req(other, '/', { headers: { cookie } });
        assert.equal(res.headers.get('location'), '/welcome');
      } finally {
        await other.close();
      }
    } finally {
      await r.close();
    }
  });

  test('join: bad token 403 with message, good token 303 + cookie', async () => {
    const r = await rt(threeModules());
    try {
      await setup(r);
      const bad = await req(r, '/join/not-a-real-token');
      assert.equal(bad.status, 403);
      assert.match(await bad.text(), /초대 링크가 맞지 않습니다\. 대표에게 새 링크를 요청하세요\./);
      const { member, inviteToken } = await r.ctx.members.create({ name: '직원', role: 'staff' });
      assert.match(inviteToken, /^[A-Za-z0-9_-]{32}$/);
      const stored = (await r.ctx.db.get('SELECT token_hash FROM members WHERE id = $1', [member.id])).token_hash;
      assert.notEqual(stored, inviteToken);
      assert.match(stored, /^[0-9a-f]{64}$/);
      const good = await req(r, '/join/' + inviteToken);
      assert.equal(good.status, 303);
      assert.equal(good.headers.get('location'), '/today');
      const cookie = good.headers.get('set-cookie').split(';')[0];
      assert.equal(cookie.split('=')[1].split('.')[0], String(member.id));
      const home = await req(r, '/', { headers: { cookie } });
      assert.equal(home.headers.get('location'), '/today');
    } finally {
      await r.close();
    }
  });

  test('welcome, logout, auth.required', async () => {
    const dir = makeDir({
      'a/manifest.mjs': manifest({
        id: 'a', title: 'A', group: '매일', order: 1, path: '/a',
        routes: `router.get('/a', ctx.auth.required((q, p, c, m) => new Response('hi ' + m.name)));`,
      }),
    });
    const r = await rt(dir);
    try {
      const w = await req(r, '/welcome');
      assert.equal(w.status, 200);
      assert.match(await w.text(), /초대 링크/);
      const anon = await req(r, '/a');
      assert.equal(anon.status, 302);
      assert.equal(anon.headers.get('location'), '/welcome');
      const { cookie } = await setup(r);
      assert.equal(await (await req(r, '/a', { headers: { cookie } })).text(), 'hi 대표');
      const out = await req(r, '/logout', { headers: { cookie } });
      assert.equal(out.headers.get('location'), '/welcome');
      assert.match(out.headers.get('set-cookie'), /^br_session=;.*Max-Age=0/);
      // 첫 메뉴로 이동 (today 모듈 없음)
      assert.equal((await req(r, '/', { headers: { cookie } })).headers.get('location'), '/a');
    } finally {
      await r.close();
    }
  });

  test('members: at most 5 including owner', async () => {
    const r = await rt(tmp('br-m-'));
    try {
      await setup(r);
      for (let i = 0; i < 4; i++) await r.ctx.members.create({ name: '직원' + i });
      assert.equal(await r.ctx.members.count(), 5);
      await assert.rejects(r.ctx.members.create({ name: '여섯째' }), (e) => {
        assert.equal(e.code, 'MEMBER_LIMIT');
        assert.match(e.message, /^더 추가할 수 없습니다/);
        return true;
      });
      assert.equal(await r.ctx.members.count(), 5);
      assert.equal((await r.ctx.members.get(2)).role, 'staff');
      assert.equal(await r.ctx.members.get(99), null);
    } finally {
      await r.close();
    }
  });

  test('members.remove deletes the row; given db is not closed by runtime', async () => {
    const db = await openDb({ memory: true });
    try {
      const r = await rt(tmp('br-m-'), { dbPath: undefined, db });
      assert.equal(r.ctx.db, db);
      await setup(r);
      const { member } = await r.ctx.members.create({ name: '직원' });
      assert.equal(await r.ctx.members.remove(member.id), true);
      assert.equal(await r.ctx.members.get(member.id), null);
      assert.equal(await r.ctx.members.remove(member.id), false);
      assert.equal(await r.ctx.members.remove('x'), false);
      await r.close();
      assert.equal((await db.get('SELECT COUNT(*) AS n FROM members')).n, 1);
    } finally {
      await db.close();
    }
  });

  test('404 page in Korean with link to today', async () => {
    const r = await rt(tmp('br-m-'));
    try {
      const res = await req(r, '/no/such/page');
      assert.equal(res.status, 404);
      const html = await res.text();
      assert.match(html, /찾는 페이지가 없습니다\. 위 메뉴에서 골라 주세요\./);
      assert.match(html, /<a href="\/today">오늘의 공고<\/a>/);
      assert.match(html, /<html lang="ko">/);
    } finally {
      await r.close();
    }
  });
});

describe('registry: billing, email and legal wiring', () => {
  const limitsModule = () =>
    makeDir({
      'today/manifest.mjs': manifest({
        id: 'today',
        title: '오늘의 공고',
        group: '매일',
        order: 10,
        path: '/today',
        routes: `router.get('/today', async (req, params, c) => Response.json({
          check: c.limits ? await c.limits.check('members', 99) : null,
          billing: c.billing ? c.billing.workspaceId : null,
          email: await c.emailAlerts.deliver({ payload: { kind: 'bids', date: '2026-11-03' }, runId: 'r1' }),
        }));`,
      }),
    });

  test('legacy mode: no ctx.limits (checks skipped), ctx.billing is null, email channel is a no-op', async () => {
    const r = await rt(limitsModule());
    try {
      const res = await req(r, '/today');
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.check, null);
      assert.equal(body.billing, null);
      assert.deepEqual(body.email, { sent: false, reason: 'no_target' });
    } finally {
      await r.close();
    }
  });

  test('workspace mode: ctx.limits / ctx.billing / ctx.emailAlerts come from the workspace', async () => {
    const db = await openDb({ memory: true });
    const seen = [];
    const ws = '11111111-1111-4111-8111-111111111111';
    const r = await createRuntime({
      db,
      modulesDir: limitsModule(),
      secret: 'x',
      jobToken: 't',
      env: {},
      fetchImpl: stubFetch,
      coreDir: emptyCore(),
      workspace: {
        id: ws,
        memberFrom: () => null,
        onInvite: () => {},
        keys: { workspaceId: ws, load: async () => {}, get: () => undefined },
        limits: { check: async (kind, n) => ({ ok: false, code: 'PLAN_LIMIT', kind, max: 3, message: `limit ${n}` }) },
        billing: { workspaceId: ws },
        emailAlerts: (ctx) => {
          seen.push(typeof ctx.settings.get);
          return { deliver: async () => ({ sent: true, to: 1 }) };
        },
      },
    });
    try {
      const body = await (await req(r, '/today')).json();
      assert.equal(body.check.ok, false);
      assert.equal(body.check.code, 'PLAN_LIMIT');
      assert.equal(body.billing, ws);
      assert.deepEqual(body.email, { sent: true, to: 1 });
      assert.deepEqual(seen, ['function']);
    } finally {
      await r.close();
      await db.close();
    }
  });

  test('legacy mode: /terms and /privacy are 200 with the legal footer', async () => {
    const r = await rt(tmp('br-m-'));
    try {
      const terms = await req(r, '/terms');
      assert.equal(terms.status, 200);
      const html = await terms.text();
      assert.match(html, /이용약관/);
      assert.match(html, /<footer class="legal">/);
      const privacy = await req(r, '/privacy');
      assert.equal(privacy.status, 200);
      assert.match(await privacy.text(), /개인정보처리방침/);
      const welcome = await (await req(r, '/welcome')).text();
      assert.match(welcome, /<footer class="legal">/);
    } finally {
      await r.close();
    }
  });
});

describe('registry: demo flag, banner, status and body limit', () => {
  const flagModule = () =>
    makeDir({
      'today/manifest.mjs': manifest({
        id: 'today',
        title: '오늘의 공고',
        group: '매일',
        order: 10,
        path: '/today',
        routes: `router.get('/today', (req, params, c) => Response.json({ demo: c.demo, budget: c.budget ? 'yes' : null, credits: c.credits ? Object.keys(c.credits).sort() : null }));
        router.get('/today/page', (req, params, c) => c.html.page(200, { title: 't', body: '<p>b</p>' }));
        router.post('/today/echo', () => new Response('ok'));`,
      }),
    });

  async function wsRuntime(db, extra) {
    const ws = '11111111-1111-4111-8111-111111111111';
    return createRuntime({
      db,
      modulesDir: flagModule(),
      secret: 'x',
      jobToken: 't',
      env: {},
      fetchImpl: stubFetch,
      coreDir: emptyCore(),
      workspace: { id: ws, memberFrom: () => null, onInvite: () => {}, keys: { workspaceId: ws, load: async () => {}, get: () => undefined }, ...extra },
    });
  }

  test('legacy mode: ctx.demo, ctx.budget and ctx.credits are null; no banner', async () => {
    const r = await rt(flagModule());
    try {
      assert.deepEqual(await (await req(r, '/today')).json(), { demo: null, budget: null, credits: null });
      assert.ok(!(await (await req(r, '/today/page')).text()).includes('class="banner demo"'));
    } finally {
      await r.close();
    }
  });

  test('workspace mode: workspace.demo / budget / credits / banner reach ctx and the page', async () => {
    const db = await openDb({ memory: true });
    const r = await wsRuntime(db, {
      demo: { enabled: true },
      budget: { take: async () => ({ ok: true }) },
      credits: { summary: async () => ({}), take: async () => ({ ok: true }) },
      banner: () => '예시 안내 <a href="/signup">시작</a>' });
    const plain = await wsRuntime(db, { banner: () => null });
    try {
      assert.deepEqual(await (await req(r, '/today')).json(), { demo: { enabled: true }, budget: 'yes', credits: ['summary', 'take'] });
      const html = await (await req(r, '/today/page')).text();
      assert.ok(html.includes('<div class="banner demo" role="note">예시 안내 <a href="/signup">시작</a></div>'));
      assert.deepEqual(await (await req(plain, '/today')).json(), { demo: null, budget: null, credits: null });
      assert.ok(!(await (await req(plain, '/today/page')).text()).includes('class="banner demo"'));
    } finally {
      await r.close();
      await plain.close();
      await db.close();
    }
  });

  test('legacy mode: /status and /status.json are 200 without a session', async () => {
    const r = await rt(flagModule());
    try {
      const page = await req(r, '/status');
      assert.equal(page.status, 200);
      assert.match(await page.text(), /서비스 현황/);
      const j = await req(r, '/status.json');
      assert.equal(j.status, 200);
      const body = await j.json();
      assert.equal(body.bids, 0);
      assert.equal(body.example, false);
      assert.equal(body.status, 'ok');
    } finally {
      await r.close();
    }
  });

  test('legacy mode: body over APP_BODY_LIMIT_BYTES is 413 (router.use)', async () => {
    const r = await rt(flagModule(), { env: { APP_BODY_LIMIT_BYTES: '512' } });
    try {
      const big = await req(r, '/today/echo', { method: 'POST', body: 'x'.repeat(2048), headers: { 'content-length': '2048' } });
      assert.equal(big.status, 413);
      assert.equal((await req(r, '/today/echo', { method: 'POST', body: 'x' })).status, 200);
    } finally {
      await r.close();
    }
  });
});

describe('html helpers', () => {
  test('esc', () => {
    assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(3), '3');
  });

  test('reasons', () => {
    assert.equal(reasons(['키워드 조경', '지역 경기']), '왜 추천: 키워드 조경 · 지역 경기');
    assert.equal(reasons(['<b>']), '왜 추천: &lt;b&gt;');
    assert.equal(reasons([]), '');
  });

  test('dday boundaries', () => {
    assert.equal(dday('2026-11-07 18:00:00', '2026-10-29'), 'D-9 18:00');
    assert.equal(dday('2026-11-07', '2026-10-29'), 'D-9');
    assert.equal(dday('2026-10-29 10:00', '2026-10-29'), 'D-0 10:00');
    assert.equal(dday('2026-10-28 23:59:59', '2026-10-29'), '마감 지남');
    assert.equal(dday('', '2026-10-29'), '마감 미확인');
    assert.equal(dday(null, '2026-10-29'), '마감 미확인');
    assert.equal(dday('9999-12-31 00:00:00', '2026-10-29'), '마감 미확인');
    assert.equal(dday('곧', '2026-10-29'), '마감 미확인');
  });

  test('empty and error patterns', () => {
    const e = empty('관심 표시한 공고가 없습니다.', { href: '/today', label: '오늘의 공고에서 고르기' });
    assert.match(e, /<p>관심 표시한 공고가 없습니다\.<\/p>/);
    assert.match(e, /<a class="button secondary" href="\/today">오늘의 공고에서 고르기<\/a>/);
    assert.equal((e.match(/<a /g) || []).length, 1);
    const er = error('공고를 가져오지 못했습니다', '잠시 뒤 다시 눌러 주세요');
    assert.match(er, /role="alert"/);
    assert.match(er, /공고를 가져오지 못했습니다\. 잠시 뒤 다시 눌러 주세요\./);
  });

  test('html.mjs source has no forbidden screen words', () => {
    const src = readFileSync(new URL('../../app/core/html.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /n8n|LLM|워크플로|MCP|프롬프트|토큰|모델/i);
  });
});
