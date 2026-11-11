import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { KEY_NAMES, KEY_GROUPS, layeredEnv, legacyKeys, maskValue } from '../../app/core/keys.mjs';
import { LEGACY_WS } from '../../app/core/db.mjs';

const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function makeDir(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'br-keys-'));
  tmpRoots.push(root);
  for (const [rel, src] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return root;
}

function manifest({ id, title, group, order, path: p, extra = '' }) {
  return `export default {
  id: ${JSON.stringify(id)}, title: ${JSON.stringify(title)}, group: ${JSON.stringify(group)}, order: ${order},
  path: ${JSON.stringify(p)}, help: '도움말',
  ${extra}
  routes(router, ctx) { router.get(${JSON.stringify(p)}, (req, params, c, member) => c.html.layout({ title: ${JSON.stringify(title)}, help: '도움말', body: '<p>${id} body member=' + (member ? member.name : 'none') + '</p>', member, active: ${JSON.stringify(id)} })); },
};
`;
}

const twoModules = () =>
  makeDir({
    'today/manifest.mjs': manifest({ id: 'today', title: '오늘의 공고', group: '매일', order: 10, path: '/today' }),
    'connections/manifest.mjs': manifest({
      id: 'connections',
      title: '연결 설정',
      group: '설정',
      order: 50,
      path: '/connections',
      extra: 'when(ctx) { return ctx.keys.enabled === true; }, notifyLines() { return []; },',
    }),
  });

/** 메모리 KeyStore */
function memKeys(values = {}) {
  const store = { ...values };
  return {
    enabled: true,
    workspaceId: 'ws-1',
    get: (name) => (store[name] === undefined ? null : store[name]),
    async set(name, value) {
      store[name] = value;
    },
    async remove(name) {
      delete store[name];
    },
    async status() {
      return Object.keys(store).map((name) => ({ name, masked: maskValue(store[name]), updatedAt: null }));
    },
    invalidate() {},
  };
}

const stubFetch = async () => new Response('{}');

function rt(modulesDir, extra = {}) {
  return createRuntime({
    dbPath: ':memory:',
    modulesDir,
    secret: 'x',
    jobToken: 't',
    env: {},
    fetchImpl: stubFetch,
    coreDir: makeDir({}),
    ...extra,
  });
}

function workspaceOpt({ member = { id: 1, name: '대표', role: 'owner' }, onInvite = () => {}, keys = memKeys() } = {}) {
  return { id: '11111111-1111-4111-8111-111111111111', memberFrom: () => member, onInvite, keys };
}

function req(r, url, init = {}) {
  return r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
}

describe('keys: names and groups', () => {
  test('KEY_NAMES and KEY_GROUPS match the contract', () => {
    assert.deepEqual([...KEY_NAMES], ['NARA_API_KEY', 'LLM_API_BASE', 'LLM_API_KEY', 'LLM_MODEL', 'SUPPORT_API_BASE', 'SUPPORT_API_KEY']);
    assert.deepEqual(
      Object.fromEntries(Object.entries(KEY_GROUPS).map(([k, v]) => [k, [...v]])),
      { nara: ['NARA_API_KEY'], llm: ['LLM_API_KEY', 'LLM_API_BASE', 'LLM_MODEL'], support: ['SUPPORT_API_KEY', 'SUPPORT_API_BASE'] },
    );
  });
});

describe('keys: layeredEnv', () => {
  const env = {
    NARA_API_KEY: 'env-nara',
    NARA_API_BASE: 'http://localhost:9/nara',
    NARA_BID_OPERATION: 'op',
    LLM_API_KEY: 'env-llm',
    LLM_API_BASE: 'http://localhost:9/llm',
    LLM_MODEL: 'env-model',
    LLM_TIMEOUT_MS: '500',
    SUPPORT_API_KEY: 'env-sup',
    SUPPORT_API_BASE: 'http://localhost:9/sup',
  };

  test('workspace key wins over env', () => {
    const e = layeredEnv(env, memKeys({ NARA_API_KEY: 'ws-nara', LLM_API_KEY: 'ws-llm', LLM_API_BASE: 'http://localhost:8/llm', LLM_MODEL: 'ws-model' }));
    assert.equal(e.NARA_API_KEY, 'ws-nara');
    assert.equal(e.LLM_API_KEY, 'ws-llm');
    assert.equal(e.LLM_API_BASE, 'http://localhost:8/llm');
    assert.equal(e.LLM_MODEL, 'ws-model');
  });

  test('group with workspace key falls back to env for missing items', () => {
    const e = layeredEnv(env, memKeys({ LLM_API_KEY: 'ws-llm' }));
    assert.equal(e.LLM_API_KEY, 'ws-llm');
    assert.equal(e.LLM_API_BASE, 'http://localhost:9/llm');
    assert.equal(e.LLM_MODEL, 'env-model');
    const noEnv = layeredEnv({}, memKeys({ LLM_API_KEY: 'ws-llm' }));
    assert.equal(noEnv.LLM_MODEL, undefined);
  });

  test('APP_SHARED_KEYS 0 hides env keys when workspace has none', () => {
    const e = layeredEnv({ ...env, APP_SHARED_KEYS: '0' }, memKeys({}));
    for (const name of KEY_NAMES) assert.equal(e[name], '', name);
    const unset = layeredEnv(env, memKeys({ LLM_API_KEY: 'ws-llm' }));
    assert.equal(unset.NARA_API_KEY, '');
    assert.equal(unset.SUPPORT_API_KEY, '');
    assert.equal(unset.SUPPORT_API_BASE, '');
  });

  test('APP_SHARED_KEYS 1 uses env keys when workspace has none', () => {
    const e = layeredEnv({ ...env, APP_SHARED_KEYS: '1' }, memKeys({ NARA_API_KEY: 'ws-nara' }));
    assert.equal(e.NARA_API_KEY, 'ws-nara');
    assert.equal(e.LLM_API_KEY, 'env-llm');
    assert.equal(e.SUPPORT_API_BASE, 'http://localhost:9/sup');
  });

  test('names outside KEY_NAMES always come from env', () => {
    const e = layeredEnv({ ...env, APP_SECRET: 's' }, memKeys({ NARA_API_KEY: 'ws-nara' }));
    assert.equal(e.NARA_API_BASE, 'http://localhost:9/nara');
    assert.equal(e.NARA_BID_OPERATION, 'op');
    assert.equal(e.LLM_TIMEOUT_MS, '500');
    assert.equal(e.APP_SECRET, 's');
    for (const name of KEY_NAMES) assert.ok(Object.keys(e).includes(name), name);
  });

  test('reads the key store on every access (set takes effect without rebuilding)', async () => {
    const keys = memKeys({});
    const e = layeredEnv(env, keys);
    assert.equal(e.NARA_API_KEY, '');
    await keys.set('NARA_API_KEY', 'later');
    assert.equal(e.NARA_API_KEY, 'later');
  });
});

describe('keys: legacyKeys and maskValue', () => {
  test('legacyKeys is disabled and throws on set/remove', () => {
    const k = legacyKeys();
    assert.equal(k.enabled, false);
    assert.equal(k.get('NARA_API_KEY'), null);
    assert.deepEqual(k.status(), []);
    assert.throws(() => k.set('NARA_API_KEY', 'v', { byUserId: 'u' }));
    assert.throws(() => k.remove('NARA_API_KEY', { byUserId: 'u' }));
  });

  test('maskValue: length >= 8 shows 3 head + 2 tail, otherwise dots', () => {
    assert.equal(maskValue('abcdefgh'), 'abc…gh');
    assert.equal(maskValue('sk-1234567890xy'), 'sk-…xy');
    assert.equal(maskValue('abcdefg'), '••••');
    assert.equal(maskValue(''), '••••');
    assert.equal(maskValue('http://localhost:9/llm'), 'htt…lm');
  });
});

describe('registry: legacy mode keys', () => {
  test('legacy runtime gets disabled keys and env unchanged', async () => {
    const env = { NARA_API_KEY: 'env-nara' };
    const r = await rt(twoModules(), { env });
    try {
      assert.equal(r.ctx.env, env);
      assert.equal(r.ctx.keys.enabled, false);
    } finally {
      r.close();
    }
  });

  test('module with when=false is not registered (menu, route, hooks)', async () => {
    const r = await rt(twoModules());
    try {
      assert.deepEqual(r.modules.map((m) => m.id), ['today']);
      assert.equal(r.ctx.hooks.notifyLines.length, 0);
      const res = await req(r, '/connections');
      assert.equal(res.status, 404);
    } finally {
      r.close();
    }
  });
});

describe('registry: workspace mode', () => {
  test('/setup is 404, / redirects to /today, memberFrom is injected, when=true registers', async () => {
    const r = await rt(twoModules(), { workspace: workspaceOpt({ member: { id: 7, name: '김담당', role: 'staff' } }) });
    try {
      assert.equal((await req(r, '/setup')).status, 404);
      assert.equal((await req(r, '/welcome')).status, 404);
      const root = await req(r, '/');
      assert.ok(root.status >= 300 && root.status < 400);
      assert.equal(root.headers.get('location'), '/today');
      const today = await req(r, '/today');
      assert.equal(today.status, 200);
      assert.match(await today.text(), /member=김담당/);
      assert.deepEqual(r.modules.map((m) => m.id), ['today', 'connections']);
      assert.equal((await req(r, '/connections')).status, 200);
    } finally {
      r.close();
    }
  });

  test('ctx.keys is the workspace store and ctx.env is layered', async () => {
    const keys = memKeys({ NARA_API_KEY: 'ws-nara' });
    const r = await rt(twoModules(), { env: { NARA_API_KEY: 'env-nara', NARA_API_BASE: 'b' }, workspace: workspaceOpt({ keys }) });
    try {
      assert.equal(r.ctx.keys, keys);
      assert.equal(r.ctx.env.NARA_API_KEY, 'ws-nara');
      assert.equal(r.ctx.env.NARA_API_BASE, 'b');
    } finally {
      r.close();
    }
  });

  test('members.create calls onInvite with the token hash', async () => {
    const calls = [];
    const r = await rt(twoModules(), { workspace: workspaceOpt({ onInvite: (i) => calls.push(i) }) });
    try {
      const { member, inviteToken } = await r.ctx.members.create({ name: '김담당' });
      assert.equal(typeof inviteToken, 'string');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].memberId, member.id);
      assert.equal(calls[0].name, '김담당');
      assert.equal(calls[0].role, 'staff');
      assert.match(calls[0].tokenHash, /^[0-9a-f]{64}$/);
      assert.equal(await r.ctx.members.count(), 1);
    } finally {
      r.close();
    }
  });

  test('members.create rolls back and throws INVITE_REGISTER when onInvite fails', async () => {
    const r = await rt(twoModules(), {
      workspace: workspaceOpt({
        onInvite: () => {
          throw new Error('platform down');
        },
      }),
    });
    try {
      await assert.rejects(r.ctx.members.create({ name: '김담당' }), (err) => err.code === 'INVITE_REGISTER');
      assert.equal(await r.ctx.members.count(), 0);
    } finally {
      r.close();
    }
  });

  test('async onInvite rejection removes the member row', async () => {
    let reject;
    const r = await rt(twoModules(), {
      workspace: workspaceOpt({ onInvite: () => new Promise((_, rej) => (reject = rej)) }),
    });
    try {
      await r.ctx.members.create({ name: '김담당' });
      assert.equal(await r.ctx.members.count(), 1);
      reject(Object.assign(new Error('x'), { code: 'FORBIDDEN' }));
      // 뒤에서 도는 rollback(비동기 DELETE)이 끝날 때까지 기다린다
      for (let i = 0; i < 50 && (await r.ctx.members.count()) !== 0; i++) await new Promise((res) => setTimeout(res, 10));
      assert.equal(await r.ctx.members.count(), 0);
    } finally {
      r.close();
    }
  });
});

describe('routes-jobs: all=1', () => {
  const realJobs = pathToFileURL(path.resolve('app/core/routes-jobs.mjs')).href;
  const coreWith = (jobs) =>
    makeDir({
      'routes-jobs.mjs': `export { registerRoutes } from ${JSON.stringify(realJobs)};`,
      'jobs.mjs': `export function create() { return { jobs: ${jobs} }; }`,
    });
  const jobsSrc = `{
    async runDaily({ date }) { return { kind: 'daily', date, count: 0 }; },
    async runReminders({ date }) { return { kind: 'reminders', date, count: 2 }; },
    async runSupport() { return null; },
  }`;
  const H = { headers: { 'x-job-token': 't' } };

  test('all=1 returns an array of one payload; no parameter keeps the object', async () => {
    const r = await rt(twoModules(), { coreDir: coreWith(jobsSrc) });
    try {
      const arr = await (await req(r, '/api/jobs/reminders?all=1&date=2026-10-30', H)).json();
      assert.deepEqual(arr, [{ kind: 'reminders', date: '2026-10-30', count: 2, runId: `reminders:2026-10-30:${LEGACY_WS}`, notifyUrl: null }]);
      const daily = await (await req(r, '/api/jobs/daily?all=1&date=2026-10-30', H)).json();
      assert.deepEqual(daily, [{ kind: 'daily', date: '2026-10-30', count: 0, runId: `daily:2026-10-30:${LEGACY_WS}`, notifyUrl: null }]);
      const obj = await (await req(r, '/api/jobs/reminders?date=2026-10-30', H)).json();
      assert.deepEqual(obj, { kind: 'reminders', date: '2026-10-30', count: 2, runId: `reminders:2026-10-30:${LEGACY_WS}`, notifyUrl: null });
    } finally {
      r.close();
    }
  });

  test('all=1 with nothing to send returns [] (no parameter stays 204)', async () => {
    const r = await rt(twoModules(), { coreDir: coreWith(jobsSrc) });
    try {
      const res = await req(r, '/api/jobs/support?all=1', H);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
      assert.equal((await req(r, '/api/jobs/support', H)).status, 204);
      assert.equal((await req(r, '/api/jobs/support?all=1')).status, 403);
    } finally {
      r.close();
    }
  });
});
