import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createApp } from '../../app/core/tenant.mjs';
import { createRuntime } from '../../app/core/registry.mjs';
import { maskValue } from '../../app/core/keys.mjs';
import { createFakePlatform, createTestDb, WS_A } from './helpers/fake-platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = 'http://localhost:8820';
const NARA_SECRET = 'nara-secret-ABCDEFG-1234';
const LLM_SECRET = 'sk-live-QWERTY-987654';
const SUPPORT_SECRET = 'support-secret-ZXCV-5555';

const tmpRoots = [];
const closers = [];
const tick = () => new Promise((r) => setImmediate(r));

after(async () => {
  for (const c of closers) await c();
  await tick();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/** 연결 설정 모듈 하나만 든 모듈 디렉토리 */
function onlyConnections() {
  const d = tmp('br-conn-mod-');
  symlinkSync(path.join(ROOT, 'app/modules/connections'), path.join(d, 'connections'), 'dir');
  return d;
}

const realJobs = pathToFileURL(path.join(ROOT, 'app/core/routes-jobs.mjs')).href;
function coreDir() {
  const d = tmp('br-conn-core-');
  writeFileSync(path.join(d, 'routes-jobs.mjs'), `export { registerRoutes } from ${JSON.stringify(realJobs)};`);
  writeFileSync(
    path.join(d, 'jobs.mjs'),
    `export function create() { return { jobs: { async runDaily({ date }) { return { kind: 'daily', date, count: 0 }; }, async runReminders() { return null; }, async runSupport() { return null; } } }; }`,
  );
  return d;
}

const SEED = {
  memberships: [
    { userId: 'user-a', workspaceId: WS_A, role: 'owner', memberId: 1, memberName: '김대표' },
    { userId: 'user-s', workspaceId: WS_A, role: 'staff', memberId: 2, memberName: '박직원' },
  ],
};

/** 모의 외부 호출: handler(url, init) 를 테스트마다 바꾼다 */
function mockFetch() {
  const calls = [];
  let handler = async () => new Response('{}');
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  fn.calls = calls;
  fn.use = (h) => {
    handler = h;
  };
  return fn;
}

async function makeApp({ env = {} } = {}) {
  const platform = createFakePlatform(SEED);
  const fetchImpl = mockFetch();
  const db = await createTestDb();
  await platform.useDb(db);
  closers.push(() => db.close());
  const app = await createApp({
    db,
    env: {
      APP_SECRET: 's',
      APP_JOB_TOKEN: 'jt',
      APP_BASE_URL: BASE,
      APP_WS_DIR: tmp('br-conn-ws-'),
      APP_SHARED_KEYS: '0',
      NARA_API_BASE: 'http://nara.test/svc',
      ...env,
    },
    platform,
    fetchImpl,
    modulesDir: onlyConnections(),
    coreDir: coreDir(),
    fakeNow: '2026-10-30',
  });
  closers.push(() => app.close());
  return { app, platform, fetchImpl };
}

function call(app, url, { user = 'user-a', method = 'GET', form } = {}) {
  const h = new Headers();
  if (user) h.set('cookie', `fake-user=${user}`);
  if (method !== 'GET') h.set('origin', BASE);
  const init = { method, headers: h, redirect: 'manual' };
  if (form) init.body = new URLSearchParams(form);
  return app.fetch(new Request(BASE + url, init));
}

const post = (app, url, form = {}, user = 'user-a') => call(app, url, { method: 'POST', form, user });

async function storedValues(platform) {
  const store = platform.keys(WS_A);
  await store.load();
  const out = {};
  for (const n of ['NARA_API_KEY', 'LLM_API_BASE', 'LLM_API_KEY', 'LLM_MODEL', 'SUPPORT_API_BASE', 'SUPPORT_API_KEY']) out[n] = store.get(n);
  return out;
}

/** 로그 줄(process.stdout) 을 잡아 둔다. 원래 출력도 그대로 보낸다 */
async function captureLogs(fn) {
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

async function checkWith(handler, group = 'nara') {
  const { app, fetchImpl } = await makeApp();
  await post(app, '/connections/nara', { NARA_API_KEY: NARA_SECRET });
  await post(app, '/connections/llm', { LLM_API_KEY: LLM_SECRET, LLM_API_BASE: 'http://llm.test/v1', LLM_MODEL: 'm-test' });
  await post(app, '/connections/support', { SUPPORT_API_KEY: SUPPORT_SECRET, SUPPORT_API_BASE: 'http://support.test/api' });
  fetchImpl.use(handler);
  const res = await post(app, `/connections/${group}/check`, {}, 'user-s');
  assert.equal(res.status, 303);
  const loc = new URL(res.headers.get('location'), BASE);
  return { app, fetchImpl, loc, params: loc.searchParams };
}

describe('connections: menu visibility', () => {
  test('connections: legacy mode hides the menu (when is false)', async () => {
    const r = await createRuntime({
      dbPath: ':memory:',
      modulesDir: onlyConnections(),
      coreDir: coreDir(),
      secret: 'x',
      jobToken: 't',
      env: {},
      fetchImpl: async () => new Response('{}'),
      fakeNow: '2026-10-30',
    });
    closers.push(() => r.close());
    assert.equal(r.modules.some((m) => m.id === 'connections'), false);
    const res = await r.router.fetch(new Request('http://localhost/connections', { redirect: 'manual' }));
    assert.notEqual(res.status, 200);
  });

  test('connections: workspace mode shows the menu and the screen', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/connections');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /href="\/connections"/);
    assert.match(html, /연결 설정/);
    for (const g of ['nara', 'llm', 'support']) assert.match(html, new RegExp(`id="conn-${g}"`));
    assert.match(html, /알림 받을 곳은 알림 설정에서 바꿉니다/);
    assert.match(html, /href="\/settings"/);
    assert.match(html, /등록 안 됨/);
    assert.match(html, /data-busy="확인하는 중…"/);
    assert.match(html, /name="NARA_API_KEY" type="password" autocomplete="off"/);
  });

  test('connections: no primary button on the screen (every button is secondary)', async () => {
    const { app } = await makeApp();
    const html = await (await call(app, '/connections')).text();
    const main = html.slice(html.indexOf('<main'));
    const buttons = main.match(/<button\b[^>]*>/g) || [];
    assert.ok(buttons.length >= 9, `expected buttons, got ${buttons.length}`);
    for (const b of buttons) assert.match(b, /class="secondary/, b);
  });
});

describe('connections: save and remove', () => {
  test('connections: staff cannot save or remove (403), but sees disabled form', async () => {
    const { app, platform } = await makeApp();
    const res = await post(app, '/connections/nara', { NARA_API_KEY: NARA_SECRET }, 'user-s');
    assert.equal(res.status, 403);
    assert.match(await res.text(), /인증키는 대표만 바꿀 수 있습니다/);
    const rm = await post(app, '/connections/nara/remove', {}, 'user-s');
    assert.equal(rm.status, 403);
    assert.equal((await storedValues(platform)).NARA_API_KEY, null);
    const html = await (await call(app, '/connections', { user: 'user-s' })).text();
    assert.match(html, /data-owner-only/);
    assert.match(html, /<fieldset disabled/);
  });

  test('connections: owner saves with the signed-in user client, status shows masked value', async () => {
    const { app, platform } = await makeApp();
    const res = await post(app, '/connections/nara', { NARA_API_KEY: NARA_SECRET });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/connections?saved=nara');
    assert.equal((await storedValues(platform)).NARA_API_KEY, NARA_SECRET);
    const st = await platform.keys(WS_A).status();
    assert.deepEqual(st.map((s) => [s.name, s.masked]), [['NARA_API_KEY', 'nar…34']]);
    const html = await (await call(app, '/connections?saved=nara')).text();
    assert.ok(html.includes(`등록됨 ${maskValue(NARA_SECRET)}`));
    assert.match(html, /나라장터 연결을 저장했습니다/);
  });

  test('connections: blank fields keep the current values', async () => {
    const { app, platform } = await makeApp();
    await post(app, '/connections/llm', { LLM_API_KEY: LLM_SECRET, LLM_API_BASE: 'http://llm.test/v1', LLM_MODEL: 'm-one' });
    const res = await post(app, '/connections/llm', { LLM_API_KEY: '', LLM_API_BASE: '', LLM_MODEL: 'm-two' });
    assert.equal(res.status, 303);
    const v = await storedValues(platform);
    assert.equal(v.LLM_API_KEY, LLM_SECRET);
    assert.equal(v.LLM_API_BASE, 'http://llm.test/v1');
    assert.equal(v.LLM_MODEL, 'm-two');
  });

  test('connections: address must be http(s), key at most 256 chars, empty form rejected', async () => {
    const { app, platform } = await makeApp();
    const bad = await post(app, '/connections/llm', { LLM_API_KEY: LLM_SECRET, LLM_API_BASE: 'ftp://llm.test' });
    assert.equal(bad.status, 400);
    const html = await bad.text();
    assert.match(html, /http:\/\/ 또는 https:\/\//);
    assert.equal(html.includes(LLM_SECRET), false, 'key value echoed in error page');
    const js = await post(app, '/connections/support', { SUPPORT_API_BASE: 'javascript:alert(1)' });
    assert.equal(js.status, 400);
    const long = await post(app, '/connections/nara', { NARA_API_KEY: 'x'.repeat(257) });
    assert.equal(long.status, 400);
    assert.match(await long.text(), /256자/);
    const empty = await post(app, '/connections/nara', { NARA_API_KEY: '   ' });
    assert.equal(empty.status, 400);
    assert.match(await empty.text(), /바꿀 값을 하나 이상 적어 주세요/);
    const v = await storedValues(platform);
    assert.equal(v.LLM_API_KEY, null);
    assert.equal(v.NARA_API_KEY, null);
    const ok = await post(app, '/connections/nara', { NARA_API_KEY: 'x'.repeat(256) });
    assert.equal(ok.status, 303);
  });

  test('connections: remove deletes the whole group', async () => {
    const { app, platform } = await makeApp();
    await post(app, '/connections/support', { SUPPORT_API_KEY: SUPPORT_SECRET, SUPPORT_API_BASE: 'http://support.test/api' });
    await post(app, '/connections/nara', { NARA_API_KEY: NARA_SECRET });
    const res = await post(app, '/connections/support/remove');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/connections?removed=support');
    const v = await storedValues(platform);
    assert.equal(v.SUPPORT_API_KEY, null);
    assert.equal(v.SUPPORT_API_BASE, null);
    assert.equal(v.NARA_API_KEY, NARA_SECRET);
    assert.match(await (await call(app, '/connections?removed=support')).text(), /지원사업 연결을 삭제했습니다/);
  });

  test('connections: unknown group is 404', async () => {
    const { app } = await makeApp();
    assert.equal((await post(app, '/connections/other', { X: '1' })).status, 404);
    assert.equal((await post(app, '/connections/other/check')).status, 404);
  });
});

describe('connections: check', () => {
  test('connections: check ok → 연결됨 (staff may check, one real call with the saved key)', async () => {
    const { app, fetchImpl, params, loc } = await checkWith(async () => new Response(JSON.stringify({ response: { header: { resultCode: '00' }, body: { items: [] } } })));
    assert.equal(params.get('check'), 'nara');
    assert.equal(params.get('result'), 'ok');
    assert.equal(fetchImpl.calls.length, 1);
    assert.ok(fetchImpl.calls[0].url.startsWith('http://nara.test/svc/'));
    assert.ok(fetchImpl.calls[0].url.includes(encodeURIComponent(NARA_SECRET)) || fetchImpl.calls[0].url.includes(NARA_SECRET));
    assert.match(fetchImpl.calls[0].url, /numOfRows=1(&|$)/);
    const html = await (await call(app, loc.pathname + loc.search)).text();
    assert.match(html, /data-check-result="ok"/);
    assert.match(html, /연결됨/);
  });

  test('connections: check 401 → 인증키가 맞지 않습니다', async () => {
    const { app, params, loc } = await checkWith(async () => new Response('unauthorized', { status: 401 }), 'llm');
    assert.equal(params.get('result'), 'badkey');
    assert.match(await (await call(app, loc.pathname + loc.search)).text(), /인증키가 맞지 않습니다/);
  });

  test('connections: llm check posts a one-word request with the saved name', async () => {
    const { fetchImpl, params } = await checkWith(async () => new Response(JSON.stringify({ choices: [] })), 'llm');
    assert.equal(params.get('result'), 'ok');
    const c = fetchImpl.calls[0];
    assert.equal(c.url, 'http://llm.test/v1/chat/completions');
    assert.equal(c.init.method, 'POST');
    assert.deepEqual(JSON.parse(c.init.body), { model: 'm-test', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 });
  });

  test('connections: nara key error body (200) → badkey', async () => {
    const xml = '<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
    const { params } = await checkWith(async () => new Response(xml));
    assert.equal(params.get('result'), 'badkey');
  });

  test('connections: check timeout → 시간이 오래 걸립니다', async () => {
    const { app, params, loc } = await checkWith(async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }, 'support');
    assert.equal(params.get('result'), 'slow');
    assert.match(await (await call(app, loc.pathname + loc.search)).text(), /시간이 오래 걸립니다. 잠시 뒤 다시 확인해 주세요/);
  });

  test('connections: check other error → 연결하지 못했습니다 (응답 오류 500) / (연결 안 됨)', async () => {
    const a = await checkWith(async () => new Response('boom', { status: 500 }), 'support');
    assert.equal(a.params.get('result'), 'fail');
    assert.equal(a.params.get('code'), '500');
    assert.match(await (await call(a.app, a.loc.pathname + a.loc.search)).text(), /연결하지 못했습니다 \(응답 오류 500\)/);
    const b = await checkWith(async () => {
      throw new TypeError('fetch failed');
    });
    assert.equal(b.params.get('result'), 'fail');
    assert.equal(b.params.get('code'), '');
    assert.match(await (await call(b.app, b.loc.pathname + b.loc.search)).text(), /연결하지 못했습니다 \(연결 안 됨\)/);
  });

  test('connections: forged result in the address is ignored', async () => {
    const { app } = await makeApp();
    const html = await (await call(app, '/connections?check=nara&result=<script>&code=<b>')).text();
    assert.equal(html.includes('data-check-result'), false);
  });
});

describe('connections: shared keys and secrecy', () => {
  test('connections: APP_SHARED_KEYS=1 and no company key → blue shared-key notice', async () => {
    const { app } = await makeApp({ env: { APP_SHARED_KEYS: '1', NARA_API_KEY: 'shared-env-key-0000' } });
    const html = await (await call(app, '/connections')).text();
    assert.match(html, /운영자가 둔 공용 인증키를 쓰는 중입니다. 우리 회사 키를 넣으면 그 키를 씁니다/);
    assert.match(html, /<div data-shared><div class="notice info">/);
    assert.equal(html.includes('shared-env-key-0000'), false);
    await post(app, '/connections/nara', { NARA_API_KEY: NARA_SECRET });
    const after1 = await (await call(app, '/connections')).text();
    const nara = after1.slice(after1.indexOf('id="conn-nara"'), after1.indexOf('id="conn-llm"'));
    assert.equal(nara.includes('data-shared'), false);
  });

  test('connections: no shared notice when APP_SHARED_KEYS=0', async () => {
    const { app } = await makeApp();
    assert.equal((await (await call(app, '/connections')).text()).includes('data-shared'), false);
  });

  test('connections: response HTML never contains a key in plain text', async () => {
    const { app } = await makeApp();
    await post(app, '/connections/nara', { NARA_API_KEY: NARA_SECRET });
    await post(app, '/connections/llm', { LLM_API_KEY: LLM_SECRET, LLM_API_BASE: 'http://llm.test/v1', LLM_MODEL: 'm-test' });
    await post(app, '/connections/support', { SUPPORT_API_KEY: SUPPORT_SECRET, SUPPORT_API_BASE: 'http://support.test/api' });
    for (const u of ['/connections', '/connections?saved=llm', '/connections?check=nara&result=badkey']) {
      for (const user of ['user-a', 'user-s']) {
        const html = await (await call(app, u, { user })).text();
        for (const s of [NARA_SECRET, LLM_SECRET, SUPPORT_SECRET]) assert.equal(html.includes(s), false, `${s} leaked on ${u}`);
        assert.equal(/<input[^>]*\bvalue="[^"]+"/.test(html), false, 'input has a value');
        assert.equal(/type="hidden"/.test(html), false);
      }
    }
    const html = await (await call(app, '/connections')).text();
    assert.ok(html.includes(maskValue(LLM_SECRET)));
    assert.ok(html.includes(maskValue(SUPPORT_SECRET)));
  });

  test('connections: key values never reach the log', async () => {
    const { app, fetchImpl } = await makeApp();
    const lines = await captureLogs(async () => {
      await post(app, '/connections/nara', { NARA_API_KEY: NARA_SECRET });
      await post(app, '/connections/llm', { LLM_API_KEY: LLM_SECRET, LLM_API_BASE: 'http://llm.test/v1' });
      fetchImpl.use(async () => new Response('nope', { status: 401 }));
      await post(app, '/connections/nara/check');
      fetchImpl.use(async () => {
        throw new Error(`boom ${NARA_SECRET}`);
      });
      await post(app, '/connections/nara/check');
      await post(app, '/connections/llm/check');
      await post(app, '/connections/nara/remove');
    });
    assert.ok(lines.some((l) => l.includes('[connections] check nara: badkey')), lines.join('\n'));
    for (const l of lines) {
      for (const s of [NARA_SECRET, LLM_SECRET, encodeURIComponent(NARA_SECRET)]) assert.equal(l.includes(s), false, `leaked: ${l}`);
    }
  });
});
