import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../app/core/tenant.mjs';
import { registerPlatformRoutes } from '../../app/core/platform-routes.mjs';
import { TEXT } from '../../app/core/platform-views.mjs';
import { createConsents } from '../../app/core/legal/consent.mjs';
import { LEGAL_DEFAULT_VERSION } from '../../app/core/legal/texts.mjs';
import { createFakePlatform, createTestDb, WS_A, WS_B } from './helpers/fake-platform.mjs';
import { DEMO_TEXT } from '../../app/core/demo/fixture.mjs';
import { GUARD_TEXT } from '../../app/core/http-guard.mjs';
import { BUDGET_TEXT } from '../../app/core/budget.mjs';

const BASE = 'http://localhost:8820';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const tmpRoots = [];
const apps = [];
const dbs = [];

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

function modulesDir() {
  const root = tmp('br-pr-mod-');
  const files = {
    'today/manifest.mjs': `export default { id: 'today', title: '오늘의 공고', group: '매일', order: 10, path: '/today', help: '',
  routes(router) { router.get('/today', () => new Response('today')); } };`,
    'settings/manifest.mjs': `export default { id: 'settings', title: '알림 설정', group: '설정', order: 40, path: '/settings', help: '',
  routes(router) { router.get('/settings', () => new Response('settings')); } };`,
  };
  for (const [rel, src] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return root;
}

async function makeApp({ env = {}, seed } = {}) {
  const platform = createFakePlatform(seed);
  const wsDir = tmp('br-pr-ws-');
  const db = await createTestDb();
  dbs.push(db);
  await platform.useDb(db);
  const app = await createApp({
    env: { APP_SECRET: 's', APP_JOB_TOKEN: 'jt', APP_BASE_URL: BASE, APP_WS_DIR: wsDir, APP_SHARED_KEYS: '0', ...env },
    platform,
    db,
    fetchImpl: async () => new Response('{}'),
    modulesDir: modulesDir(),
    coreDir: tmp('br-pr-core-'),
    registerPlatformRoutes,
  });
  apps.push(app);
  return { app, platform, wsDir, db };
}

function call(app, url, { user, cookie = '', method = 'GET', form } = {}) {
  const h = new Headers();
  const cookies = [cookie, user ? `fake-user=${user}` : ''].filter(Boolean).join('; ');
  if (cookies) h.set('cookie', cookies);
  if (method !== 'GET') h.set('origin', BASE);
  const init = { method, headers: h, redirect: 'manual' };
  if (form) init.body = new URLSearchParams(form);
  return app.fetch(new Request(BASE + url, init));
}

const setCookies = (res) => res.headers.getSetCookie();
const GOOD = { email: 'new@example.com', password: 'longenough1', name: '홍길동', agree_terms: '1', agree_privacy: '1' };

describe('platform routes: landing and signup', () => {
  test('platform: landing without session shows h1, signup and login', async () => {
    const { app } = await makeApp();
    for (const p of ['/', '/welcome']) {
      const res = await call(app, p);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.match(html, /<h1>입찰 레이더<\/h1>/);
      assert.match(html, /href="\/signup"/);
      assert.match(html, /href="\/login"/);
      assert.ok(html.includes(TEXT.landing.privacy));
      assert.equal((html.match(/class="button"/g) ?? []).length, 1, 'one primary action');
    }
  });

  test('platform: landing with session redirects by membership', async () => {
    const { app } = await makeApp();
    const a = await call(app, '/', { user: 'user-a' });
    assert.equal(a.status, 303);
    assert.equal(a.headers.get('location'), '/today');
    const z = await call(app, '/', { user: 'nobody' });
    assert.equal(z.headers.get('location'), '/workspaces/new');
    const d = await call(app, '/welcome?deleted=1');
    assert.ok((await d.text()).includes(TEXT.landing.deleted));
  });

  test('platform: signup success redirects to verify notice with cookies', async () => {
    const { app, platform } = await makeApp();
    let got;
    platform.auth.signUp = async (args) => {
      got = args;
      return { ok: true, needsConfirm: true, setCookies: ['sb-x-auth-token-code-verifier=v; Path=/'] };
    };
    const res = await call(app, '/signup', { method: 'POST', form: GOOD });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), `/verify-notice?email=${encodeURIComponent(GOOD.email)}`);
    assert.ok(setCookies(res).some((c) => c.startsWith('sb-x-auth-token-code-verifier=')));
    assert.equal(got.memberName, '홍길동');
    assert.equal(got.redirectTo, `${BASE}/auth/callback`);
  });

  test('platform: signup error branches (taken, weak, long, rate)', async () => {
    const { app, platform } = await makeApp();
    platform.auth.signUp = async () => ({ ok: false, error: 'EMAIL_TAKEN' });
    let res = await call(app, '/signup', { method: 'POST', form: GOOD });
    assert.equal(res.status, 409);
    let html = await res.text();
    assert.ok(html.includes('이미 가입한 이메일입니다'));
    assert.equal((html.match(/class="error"/g) ?? []).length, 1);

    res = await call(app, '/signup', { method: 'POST', form: { ...GOOD, password: 'short' } });
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes('비밀번호는 8자 이상으로 적어 주세요'));

    res = await call(app, '/signup', { method: 'POST', form: { ...GOOD, password: 'x'.repeat(73) } });
    assert.equal(res.status, 400);

    platform.auth.signUp = async () => ({ ok: false, error: 'WEAK_PASSWORD' });
    res = await call(app, '/signup', { method: 'POST', form: GOOD });
    assert.ok((await res.text()).includes('비밀번호는 8자 이상으로 적어 주세요'));

    res = await call(app, '/signup', { method: 'POST', form: { ...GOOD, email: 'not-an-email' } });
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes(TEXT.errors.BAD_EMAIL));
  });

  test('platform: signup code mode needs the code', async () => {
    const { app, platform } = await makeApp({ env: { APP_SIGNUP_MODE: 'code', APP_SIGNUP_CODE: 'open-sesame' } });
    let called = 0;
    platform.auth.signUp = async () => {
      called += 1;
      return { ok: true, needsConfirm: true, setCookies: [] };
    };
    const form = await call(app, '/signup');
    assert.match(await form.text(), /name="code"/);
    const bad = await call(app, '/signup', { method: 'POST', form: { ...GOOD, code: 'nope' } });
    assert.equal(bad.status, 403);
    assert.ok((await bad.text()).includes('가입 코드가 맞지 않습니다'));
    assert.equal(called, 0);
    const ok = await call(app, '/signup', { method: 'POST', form: { ...GOOD, code: 'open-sesame' } });
    assert.equal(ok.status, 303);
    assert.equal(called, 1);
  });

  test('platform: signup closed mode refuses unless invited', async () => {
    const { app } = await makeApp({ env: { APP_SIGNUP_MODE: 'closed' } });
    const get = await call(app, '/signup');
    assert.ok((await get.text()).includes('지금은 가입을 받지 않습니다'));
    const post = await call(app, '/signup', { method: 'POST', form: GOOD });
    assert.equal(post.status, 403);
    const invited = await call(app, '/signup', { method: 'POST', form: GOOD, cookie: `invite=${TOKEN}` });
    assert.equal(invited.status, 303);
  });

  test('platform: verify notice names the mail', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/verify-notice?email=a%40example.com');
    const html = await res.text();
    assert.ok(html.includes('입찰 레이더 가입 확인'));
    assert.ok(html.includes('a@example.com'));
    assert.match(html, /href="\/login"/);
  });
});

describe('platform routes: callback, login, logout, reset', () => {
  test('platform: callback success goes to workspaces/new, today or invite', async () => {
    const { app, platform } = await makeApp();
    platform.auth.exchangeCode = async (req, code) =>
      code === 'good-b' ? { ok: true, setCookies: ['sb-s=1; Path=/'], user: { id: 'user-b' } } : { ok: true, setCookies: ['sb-s=1; Path=/'], user: { id: 'fresh' } };
    let res = await call(app, '/auth/callback?code=good');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/workspaces/new');
    assert.ok(setCookies(res).some((c) => c.startsWith('sb-s=1')));
    res = await call(app, '/auth/callback?code=good-b');
    assert.equal(res.headers.get('location'), '/today');
    res = await call(app, '/auth/callback?code=good', { cookie: `invite=${TOKEN}` });
    assert.equal(res.headers.get('location'), `/join/${TOKEN}`);
  });

  test('platform: callback failure shows landing with message', async () => {
    const { app } = await makeApp();
    for (const u of ['/auth/callback?code=bad', '/auth/callback']) {
      const res = await call(app, u);
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.ok(html.includes(TEXT.landing.badLink));
      assert.match(html, /<h1>입찰 레이더<\/h1>/);
    }
  });

  test('platform: callback recovery goes to password change', async () => {
    const { app, platform } = await makeApp();
    platform.auth.exchangeCode = async () => ({ ok: true, setCookies: [], user: { id: 'user-a' } });
    const res = await call(app, '/auth/callback?code=x&type=recovery');
    assert.equal(res.headers.get('location'), '/account/password?recovery=1');
    const pw = await call(app, '/account/password?recovery=1', { user: 'user-a' });
    const html = await pw.text();
    assert.doesNotMatch(html, /name="current"/);
  });

  test('platform: login success and 3 error branches', async () => {
    const { app, platform } = await makeApp();
    const ok = await call(app, '/login', { method: 'POST', form: { email: 'user-a@example.com', password: 'whatever1' } });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/');
    assert.ok(setCookies(ok).some((c) => c.startsWith('fake-user=user-a')));
    const cases = [
      ['BAD_CREDENTIALS', '이메일 또는 비밀번호가 맞지 않습니다', 400],
      ['EMAIL_NOT_CONFIRMED', '메일 인증이 아직 안 됐습니다', 400],
      ['RATE_LIMIT', '너무 여러 번 시도했습니다. 15분 뒤 다시', 429],
    ];
    for (const [code, text, status] of cases) {
      platform.auth.signIn = async () => ({ ok: false, error: code });
      const res = await call(app, '/login', { method: 'POST', form: { email: 'x@example.com', password: 'whatever1' } });
      assert.equal(res.status, status, code);
      assert.ok((await res.text()).includes(text), code);
    }
  });

  test('platform: logout POST clears session and workspace cookie', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/logout', { method: 'POST', user: 'user-a' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/welcome');
    const sc = setCookies(res);
    assert.ok(sc.some((c) => c.startsWith('fake-user=;')));
    assert.ok(sc.some((c) => c.startsWith('br_ws=;') && /Max-Age=0/.test(c)));
  });

  test('platform-routes: GET /logout does not sign out', async () => {
    const { app, platform } = await makeApp();
    let signedOut = 0;
    platform.auth.signOut = async () => {
      signedOut += 1;
      return { setCookies: ['fake-user=; Path=/; Max-Age=0'] };
    };
    const res = await call(app, '/logout', { user: 'user-a' });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/account');
    const sc = setCookies(res);
    assert.ok(!sc.some((c) => c.startsWith('fake-user=;')));
    assert.ok(!sc.some((c) => c.startsWith('br_ws=;')));
    const anon = await call(app, '/logout');
    assert.equal(anon.status, 303);
    assert.equal(anon.headers.get('location'), '/welcome');
    assert.equal(signedOut, 0);
  });

  test('platform: reset always says mail was sent', async () => {
    const { app, platform } = await makeApp();
    let got;
    platform.auth.resetPassword = async (args) => {
      got = args;
      return { ok: true, setCookies: ['sb-v=1; Path=/'] };
    };
    const res = await call(app, '/reset', { method: 'POST', form: { email: 'nobody@example.com' } });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes(TEXT.reset.sent));
    assert.ok(setCookies(res).some((c) => c.startsWith('sb-v=1')));
    assert.equal(got.redirectTo, `${BASE}/auth/callback?type=recovery`);
  });
});

describe('platform routes: account', () => {
  test('platform: password change errors (current, mismatch) and success', async () => {
    const { app, platform } = await makeApp();
    platform.auth.updatePassword = async () => ({ ok: false, error: 'BAD_CURRENT' });
    let res = await call(app, '/account/password', { method: 'POST', user: 'user-a', form: { current: 'wrong-one', next: 'newpass123', next2: 'newpass123' } });
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes('현재 비밀번호가 맞지 않습니다'));
    res = await call(app, '/account/password', { method: 'POST', user: 'user-a', form: { current: 'right-one', next: 'newpass123', next2: 'newpass124' } });
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes('두 번 적은 새 비밀번호가 다릅니다'));
    platform.auth.updatePassword = async () => ({ ok: true, setCookies: [] });
    res = await call(app, '/account/password', { method: 'POST', user: 'user-a', form: { current: 'right-one', next: 'newpass123', next2: 'newpass123' } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/account?saved=1');
    const anon = await call(app, '/account/password');
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/welcome');
  });

  test('platform: account screen in app frame with companies and delete section', async () => {
    const { app } = await makeApp({
      seed: {
        memberships: [
          { userId: 'user-a', workspaceId: WS_A, role: 'owner', memberId: 1, memberName: '김대표' },
          { userId: 'user-a', workspaceId: WS_B, role: 'staff', memberId: 2, memberName: '김직원' },
        ],
      },
    });
    const res = await call(app, '/account?saved=1', { user: 'user-a', cookie: `br_ws=${WS_A}` });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<nav class="menu"/, 'sidebar');
    assert.ok(html.includes('user-a@example.com'));
    assert.ok(html.includes('가나 조경') && html.includes('다라 전기'));
    assert.match(html, /action="\/workspaces\/switch"/);
    assert.match(html, /action="\/account\/delete"/);
    assert.ok(html.includes(TEXT.account.deleteConfirm));
    assert.ok(html.includes(TEXT.account.saved));
    assert.match(html, /<form method="post" action="\/logout"/);
  });

  test('platform: delete needs password re-check and confirm', async () => {
    const { app, platform, wsDir } = await makeApp();
    let deleted = 0;
    platform.deleteAccount = async () => {
      deleted += 1;
      return { ok: true };
    };
    const noConfirm = await call(app, '/account/delete', { method: 'POST', user: 'user-a', form: { password: 'pw-123456' } });
    assert.equal(noConfirm.status, 400);
    assert.ok((await noConfirm.text()).includes(TEXT.errors.DELETE_CONFIRM));
    platform.auth.signIn = async () => ({ ok: false, error: 'BAD_CREDENTIALS' });
    const badPw = await call(app, '/account/delete', { method: 'POST', user: 'user-a', form: { password: 'wrong-pw', confirm: '1' } });
    assert.equal(badPw.status, 400);
    assert.ok((await badPw.text()).includes(TEXT.errors.DELETE_PASSWORD));
    assert.equal(deleted, 0);

    // 회사 런타임을 한 번 연 뒤 삭제 (업무 행은 플랫폼 FK cascade 가 지운다. 앱은 파일을 만들지도 지우지도 않는다)
    await call(app, '/today', { user: 'user-a' });
    assert.deepEqual(readdirSync(wsDir), []);
    platform.auth.signIn = async () => ({ ok: true, setCookies: ['fresh-session=1'] });
    const ok = await call(app, '/account/delete', { method: 'POST', user: 'user-a', form: { password: 'right-pw', confirm: '1' } });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/welcome?deleted=1');
    assert.equal(deleted, 1);
    assert.deepEqual(readdirSync(wsDir), [], 'no workspace files');
    assert.ok(!setCookies(ok).some((c) => c.startsWith('fresh-session')), 're-check session is not sent');
    assert.ok(setCookies(ok).some((c) => c.startsWith('br_ws=;')));
  });
});

describe('platform routes: account deletion runtime', () => {
  test('platform-routes: account deletion drops cached runtime', async () => {
    const { app, platform, db } = await makeApp();
    platform.auth.signIn = async () => ({ ok: true, setCookies: [] });
    await call(app, '/today', { user: 'user-a' });
    const before = await app.runtimeFor(WS_A);
    let closed = 0;
    const realClose = before.close;
    before.close = () => {
      closed += 1;
      return realClose();
    };
    const ok = await call(app, '/account/delete', { method: 'POST', user: 'user-a', form: { password: 'right-pw', confirm: '1' } });
    assert.equal(ok.status, 303);
    assert.equal(closed, 1, 'cached runtime closed once');
    const after = await app.runtimeFor(WS_A);
    assert.notEqual(after, before, 'closed runtime is not served from cache');
    assert.equal(await db.withWorkspace(WS_A, () => after.ctx.settings.get('company_name')), null);
  });
});

describe('platform routes: workspaces, join, me', () => {
  test('platform: workspaces/new creates, sets br_ws and company name; limit message', async () => {
    const { app, platform, db } = await makeApp({ env: { APP_MAX_WORKSPACES: '7' } });
    const form = await call(app, '/workspaces/new', { user: 'fresh' });
    assert.equal(form.status, 200);
    assert.match(await form.text(), /name="company"/);
    const res = await call(app, '/workspaces/new', { method: 'POST', user: 'fresh', form: { company: '마바 건설', name: '최대표' } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/settings?first=1');
    const ws = platform.workspaces.at(-1).id;
    assert.ok(setCookies(res).some((c) => c.startsWith(`br_ws=${ws}`)));
    const me = await call(app, '/me', { user: 'fresh', cookie: `br_ws=${ws}` });
    const meHtml = await me.text();
    assert.ok(meHtml.includes('마바 건설') && meHtml.includes('최대표'));
    // 회사 이름은 그 회사 행으로만 저장되고 members 표에는 쓰지 않는다
    const rt = await app.runtimeFor(ws);
    await db.withWorkspace(ws, async () => {
      assert.equal(await rt.ctx.settings.get('company_name'), '마바 건설');
      assert.equal(Number((await rt.ctx.db.get('SELECT COUNT(*) AS n FROM members')).n), 0);
    });

    platform.createWorkspace = async () => {
      throw Object.assign(new Error('limit'), { code: 'WORKSPACE_LIMIT' });
    };
    const lim = await call(app, '/workspaces/new', { method: 'POST', user: 'fresh', form: { company: '하나 더', name: '최대표' } });
    assert.equal(lim.status, 409);
    assert.ok((await lim.text()).includes('회사는 7개까지 만들 수 있습니다. 운영자에게 문의해 주세요'));
    const empty = await call(app, '/workspaces/new', { method: 'POST', user: 'fresh', form: { company: '', name: '최대표' } });
    assert.equal(empty.status, 400);
  });

  test('platform: workspaces/new prefills my name from verified claims only, never calls getSession', async () => {
    const { app, platform } = await makeApp();
    let getSessionCalls = 0;
    let memberName;
    const orig = platform.auth.fromRequest;
    platform.auth.fromRequest = async (req) => {
      const s = await orig(req);
      if (!s.user) return s;
      const auth = {
        async getSession() {
          getSessionCalls += 1;
          return { data: { session: { user: { user_metadata: { member_name: '세션값' } } } } };
        },
      };
      const user = memberName === undefined ? s.user : { ...s.user, memberName };
      return { ...s, client: { ...s.client, auth }, user };
    };
    memberName = '홍길동';
    const filled = await (await call(app, '/workspaces/new', { user: 'fresh' })).text();
    assert.match(filled, /<input name="name" value="홍길동"/);
    memberName = undefined;
    const empty = await (await call(app, '/workspaces/new', { user: 'fresh' })).text();
    assert.match(empty, /<input name="name" value=""/);
    assert.equal(filled.includes('세션값') || empty.includes('세션값'), false);
    assert.equal(getSessionCalls, 0);
  });

  test('platform: switch checks membership', async () => {
    const { app } = await makeApp();
    const other = await call(app, '/workspaces/switch', { method: 'POST', user: 'user-a', form: { workspace: WS_B } });
    assert.equal(other.status, 403);
    assert.ok(!setCookies(other).some((c) => c.startsWith('br_ws=')));
    const own = await call(app, '/workspaces/switch', { method: 'POST', user: 'user-a', form: { workspace: WS_A } });
    assert.equal(own.status, 303);
    assert.equal(own.headers.get('location'), '/today');
    assert.ok(setCookies(own).some((c) => c.startsWith(`br_ws=${WS_A}`)));
  });

  test('platform: join without session stores invite cookie, bad token is 403', async () => {
    const { app } = await makeApp();
    const res = await call(app, `/join/${TOKEN}`);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/signup?invite=1');
    const c = setCookies(res).find((x) => x.startsWith('invite='));
    assert.ok(c && /Max-Age=600/.test(c) && /HttpOnly/.test(c));
    const signup = await call(app, '/signup?invite=1', { cookie: `invite=${TOKEN}` });
    assert.ok((await signup.text()).includes(TEXT.signup.invited));
    const bad = await call(app, '/join/bad!token');
    assert.equal(bad.status, 403);
    assert.ok((await bad.text()).includes('초대 링크가 맞지 않습니다. 대표에게 새 링크를 요청하세요.'));
  });

  test('platform: join with session confirms then accepts', async () => {
    const { app, platform } = await makeApp();
    platform.invites.push({ workspaceId: WS_A, memberId: 3, memberName: '박직원', role: 'staff', tokenHash: platform.hashToken(TOKEN) });
    const get = await call(app, `/join/${TOKEN}`, { user: 'user-c' });
    assert.equal(get.status, 200);
    const html = await get.text();
    assert.match(html, new RegExp(`action="/join/${TOKEN}"`));
    assert.equal((html.match(/<button type="submit"/g) ?? []).length, 1);
    const post = await call(app, `/join/${TOKEN}`, { method: 'POST', user: 'user-c', cookie: `invite=${TOKEN}` });
    assert.equal(post.status, 303);
    assert.equal(post.headers.get('location'), '/today');
    const sc = setCookies(post);
    assert.ok(sc.some((c) => c.startsWith(`br_ws=${WS_A}`)));
    assert.ok(sc.some((c) => c.startsWith('invite=;')));
    const again = await call(app, `/join/${TOKEN}`, { method: 'POST', user: 'user-d' });
    assert.equal(again.status, 403);
  });

  test('platform: me shows tiles, account link and post logout', async () => {
    const { app } = await makeApp();
    const res = await call(app, '/me', { user: 'user-a' });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('김대표'));
    assert.match(html, /href="\/account"/);
    assert.match(html, /<form method="post" action="\/logout"/);
    const anon = await call(app, '/me');
    assert.equal(anon.status, 302);
  });
});

describe('platform routes: legal pages and consent', () => {
  const USER_U = '11111111-2222-4333-8444-555555555555';
  const seedU = {
    memberships: [{ userId: USER_U, workspaceId: WS_A, role: 'owner', memberId: 1, memberName: '김대표' }],
  };

  test('legal: signup without consent → 400 CONSENT_REQUIRED, signUp not called', async () => {
    const { app, platform, db } = await makeApp();
    let called = 0;
    platform.auth.signUp = async () => {
      called += 1;
      return { ok: true, needsConfirm: true, userId: USER_U, setCookies: [] };
    };
    for (const form of [
      { email: GOOD.email, password: GOOD.password, name: GOOD.name },
      { ...GOOD, agree_privacy: '' },
      { ...GOOD, agree_terms: '0' },
    ]) {
      const res = await call(app, '/signup', { method: 'POST', form });
      assert.equal(res.status, 400);
      const html = await res.text();
      assert.ok(html.includes(TEXT.signup.consentRequired));
      assert.match(html, /name="agree_terms"/);
      assert.match(html, /name="agree_privacy"/);
    }
    assert.equal(called, 0);
    assert.equal((await db.admin('SELECT count(*)::int AS n FROM consents')).rows[0].n, 0);
  });

  test('legal: signup form has two consent checks and links', async () => {
    const { app } = await makeApp();
    const html = await (await call(app, '/signup')).text();
    assert.match(html, /type="checkbox" name="agree_terms" value="1" required/);
    assert.match(html, /type="checkbox" name="agree_privacy" value="1" required/);
    assert.match(html, /href="\/terms"/);
    assert.match(html, /href="\/privacy"/);
  });

  test('legal: signup with consent records 2 consents at default version', async () => {
    const { app, db } = await makeApp();
    const res = await call(app, '/signup', { method: 'POST', form: GOOD });
    assert.equal(res.status, 303);
    const rows = (await db.admin('SELECT user_id, email, doc, version, ip_hash, user_agent FROM consents ORDER BY doc')).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.doc), ['privacy', 'terms']);
    for (const r of rows) {
      assert.equal(r.version, LEGAL_DEFAULT_VERSION);
      assert.equal(r.email, GOOD.email);
      assert.match(String(r.user_id), /^[0-9a-f-]{36}$/);
      assert.match(r.ip_hash, /^[0-9a-f]{16}$/);
    }
  });

  test('legal: version change → homeFor sends to /consent, POST /consent records and continues', async () => {
    const { app, db } = await makeApp({ seed: seedU, env: { LEGAL_TERMS_VERSION: '2027-01-01' } });
    // 예전 버전에 동의해 둔 사용자
    await createConsents({ db, env: {} }).record({ userId: USER_U, email: 'u@example.com', req: new Request(BASE) });
    const first = await call(app, '/', { user: USER_U });
    assert.equal(first.status, 303);
    assert.equal(first.headers.get('location'), '/consent');

    const form = await call(app, '/consent', { user: USER_U });
    assert.equal(form.status, 200);
    const html = await form.text();
    assert.match(html, /action="\/consent"/);
    assert.equal((html.match(/type="checkbox"/g) ?? []).length, 2);

    const bad = await call(app, '/consent', { user: USER_U, method: 'POST', form: { agree_terms: '1' } });
    assert.equal(bad.status, 400);

    const ok = await call(app, '/consent', { user: USER_U, method: 'POST', form: { agree_terms: '1', agree_privacy: '1' } });
    assert.equal(ok.status, 303);
    assert.equal(ok.headers.get('location'), '/today');
    const terms = (await db.admin("SELECT version FROM consents WHERE doc = 'terms' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(terms.version, '2027-01-01');
    const again = await call(app, '/', { user: USER_U });
    assert.equal(again.headers.get('location'), '/today');
  });

  test('legal: current consent → no reconsent; /consent needs login', async () => {
    const { app, db } = await makeApp({ seed: seedU });
    await createConsents({ db, env: {} }).record({ userId: USER_U, email: 'u@example.com', req: new Request(BASE) });
    const res = await call(app, '/', { user: USER_U });
    assert.equal(res.headers.get('location'), '/today');
    const anon = await call(app, '/consent');
    assert.equal(anon.status, 302);
    assert.equal(anon.headers.get('location'), '/welcome');
  });

  test('legal: /terms and /privacy are public and show footer business info', async () => {
    const { app } = await makeApp({ env: { BUSINESS_NAME: '예시상호', LEGAL_DRAFT_NOTICE: '1' } });
    const t = await call(app, '/terms');
    assert.equal(t.status, 200);
    const th = await t.text();
    assert.match(th, /<h1>이용약관<\/h1>/);
    assert.ok(th.includes('초안 — 시행 전 법률 검토 필요'));
    assert.match(th, /<footer class="legal">/);
    assert.ok(th.includes('상호 예시상호'));
    const p = await call(app, '/privacy');
    assert.equal(p.status, 200);
    assert.match(await p.text(), /<h1>개인정보처리방침<\/h1>/);
  });

  test('legal: footer shows 미설정 when BUSINESS_* empty (landing)', async () => {
    const { app } = await makeApp();
    const html = await (await call(app, '/welcome')).text();
    assert.ok(html.includes('사업자 정보 미설정'));
    assert.match(html, /<footer class="legal">.*href="\/terms".*href="\/privacy"/s);
  });
});

describe('platform routes: demo, turnstile and signup budget', () => {
  const DEMO_SCHEMA = readFileSync(path.resolve('app/core/demo/schema.sql'), 'utf8');
  const DEMO_OWNER = '22222222-2222-4222-8222-222222222222';
  const demoSeed = {
    memberships: [
      { userId: DEMO_OWNER, workspaceId: WS_A, role: 'owner', memberId: 1, memberName: '예시 대표' },
      { userId: 'user-b', workspaceId: WS_B, role: 'owner', memberId: 1, memberName: '이대표' },
    ],
  };

  async function demoApp(env = {}) {
    const made = await makeApp({ env: { APP_DEMO: '1', ...env }, seed: demoSeed });
    await made.db.admin(DEMO_SCHEMA);
    await made.db.admin('INSERT INTO demo_workspaces (workspace_id, owner_user_id, staff_user_ids, seeded_at, reset_count) VALUES ($1, $2, $3::uuid[], now(), 1)', [
      WS_A,
      DEMO_OWNER,
      [],
    ]);
    return made;
  }

  test('platform-routes: landing shows the demo button only with APP_DEMO=1', async () => {
    const { app } = await makeApp({ env: { APP_DEMO: '1' } });
    const html = await (await call(app, '/welcome')).text();
    assert.match(html, /<form method="post" action="\/demo\/login"/);
    assert.ok(html.includes(DEMO_TEXT.button));
    assert.ok(html.includes(DEMO_TEXT.caption));
    assert.ok(html.indexOf(DEMO_TEXT.button) < html.indexOf('href="/signup"'), 'demo button above signup');
    const { app: off } = await makeApp();
    const plain = await (await call(off, '/welcome')).text();
    assert.ok(!plain.includes('/demo/login'));
    assert.ok(!plain.includes(DEMO_TEXT.button));
  });

  test('platform-routes: demo user — POST /account/delete, /account/password and /workspaces/new are 403', async () => {
    const { app, platform } = await demoApp();
    for (const p of ['/account/delete', '/account/password', '/workspaces/new']) {
      const res = await call(app, p, { user: DEMO_OWNER, method: 'POST', form: { password: 'x', confirm: '1', next: 'longenough1', next2: 'longenough1', company: 'a', name: 'b' } });
      assert.equal(res.status, 403, p);
      assert.deepEqual(await res.json(), { error: 'demo_blocked' }, p);
    }
    assert.equal(platform.workspaces.length, 2);
    // 다른 사용자는 그대로 (비밀번호 비면 400)
    assert.equal((await call(app, '/account/delete', { user: 'user-b', method: 'POST', form: { password: '' } })).status, 400);
  });

  test('platform-routes: demo user account screen shows the locked note instead of password and delete', async () => {
    const { app } = await demoApp();
    const html = await (await call(app, '/account', { user: DEMO_OWNER })).text();
    assert.ok(html.includes(DEMO_TEXT.accountLocked));
    assert.ok(!html.includes('action="/account/delete"'));
    assert.ok(!html.includes('href="/account/password"'));
    const other = await (await call(app, '/account', { user: 'user-b' })).text();
    assert.ok(other.includes('action="/account/delete"'));
    assert.ok(!other.includes(DEMO_TEXT.accountLocked));
  });

  test('platform-routes: signup budget — APP_DAILY_MAX_SIGNUP=1 refuses the second signup with 429', async () => {
    const { app } = await makeApp({ env: { APP_DAILY_MAX_SIGNUP: '1' } });
    assert.equal((await call(app, '/signup', { method: 'POST', form: GOOD })).status, 303);
    const second = await call(app, '/signup', { method: 'POST', form: { ...GOOD, email: 'two@example.com' } });
    assert.equal(second.status, 429);
    assert.ok((await second.text()).includes(BUDGET_TEXT.signup));
  });

  test('platform-routes: turnstile on — form has the widget; failed verify → 400 human check message', async () => {
    const { app } = await makeApp({ env: { TURNSTILE_SITE_KEY: 'site-1', TURNSTILE_SECRET_KEY: 'secret-1', TURNSTILE_VERIFY_URL: 'https://verify.test/siteverify' } });
    const form = await (await call(app, '/signup')).text();
    assert.match(form, /class="cf-turnstile" data-sitekey="site-1"/);
    const res = await call(app, '/signup', { method: 'POST', form: { ...GOOD, 'cf-turnstile-response': 'tok' } });
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes(GUARD_TEXT.human));
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /script-src [^;]*https:\/\/challenges\.cloudflare\.com/);
    // 꺼져 있으면 위젯도 CSP 추가도 없다
    const { app: off } = await makeApp();
    const plain = await call(off, '/signup');
    assert.ok(!(await plain.text()).includes('cf-turnstile'));
    assert.ok(!(plain.headers.get('content-security-policy') ?? '').includes('challenges.cloudflare.com'));
  });
});
