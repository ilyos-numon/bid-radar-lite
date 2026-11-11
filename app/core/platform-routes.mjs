// 계정 라우트(Supabase 모드): 첫 화면·가입·메일 확인·로그인·로그아웃·비밀번호·내 계정·계정 삭제·회사 만들기/전환·초대 수락·/me.
// 가입·로그인·세션은 platform.auth 가 한다. 이 파일은 암호 코드를 갖지 않는다.
import { createHtml } from './html.mjs';
import { readCookie } from './auth.mjs';
import { createLegalPages } from './legal/pages.mjs';
import { createConsents, CONSENT_FIELDS } from './legal/consent.mjs';
import { clientIp } from './rate-store.mjs';
import { GUARD_TEXT } from './http-guard.mjs';
import { BUDGET_TEXT } from './budget.mjs';
import { demoEnabled } from './demo/seed.mjs';
import { blockedResponse } from './demo/guard.mjs';
import {
  TEXT,
  landingView,
  signupView,
  signupClosedView,
  verifyNoticeView,
  loginView,
  resetView,
  passwordView,
  accountView,
  meView,
  workspaceNewView,
  joinView,
  joinBadView,
  notMemberView,
} from './platform-views.mjs';

export const INVITE_COOKIE = 'invite';
const INVITE_MAX_AGE = 10 * 60;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_RE = /^[A-Za-z0-9_-]{16,128}$/;

function cookieSecure(env) {
  const v = String(env?.APP_COOKIE_SECURE ?? '').trim();
  if (v === '1') return true;
  if (v === '0') return false;
  return /^https:/i.test(String(env?.APP_BASE_URL ?? ''));
}

function maxWorkspaces(env) {
  const n = Number(env?.APP_MAX_WORKSPACES);
  return n > 0 ? Math.floor(n) : 50;
}

function signupMode(env) {
  const m = String(env?.APP_SIGNUP_MODE ?? '').trim().toLowerCase();
  return m === 'code' || m === 'closed' ? m : 'open';
}

/** 응답 헤더를 고칠 수 있도록 복사하고 Set-Cookie 를 덧붙인다 */
function withCookies(res, cookies) {
  const list = (cookies ?? []).filter(Boolean);
  if (list.length === 0) return res;
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
  for (const c of list) out.headers.append('set-cookie', c);
  return out;
}

function see(location, cookies) {
  return withCookies(new Response(null, { status: 303, headers: { location } }), cookies);
}

async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

const field = (form, name) => String(form.get(name) ?? '').trim();
// 비밀번호는 앞뒤 공백도 그대로 쓴다
const raw = (form, name) => String(form.get(name) ?? '');

function checkEmail(email) {
  return email.length <= 254 && EMAIL_RE.test(email);
}

function checkPassword(pw) {
  if (pw.length < 8) return 'WEAK_PASSWORD';
  if (pw.length > 72) return 'PASSWORD_TOO_LONG';
  return null;
}

function checkName(name, max) {
  const n = Array.from(name).length;
  return n >= 1 && n <= max;
}

/** 가입 때 적은 이름(검증된 토큰 클레임에서 읽은 user.memberName 만 쓴다. 없으면 '') */
function signupName(user) {
  const v = user?.memberName;
  return typeof v === 'string' ? v : '';
}

/**
 * @param {import('hono').Hono} app
 * @param {{ env: object, platform: object, runtimeFor(id: string): Promise<object>, dropRuntime(id: string): Promise<void>, db: { withWorkspace<T>(id: string, fn: () => Promise<T>): Promise<T>, admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, memberOf(m: object): object, appOrigin(req: Request): string, wsCookie(id: string): string, clearWsCookie(): string, WS_COOKIE: string, demo?: { isDemoUser(userId: string): Promise<boolean> }|null, guard?: { turnstile: { enabled: boolean, widgetHtml(): string, verify(token: string, ip: string): Promise<boolean> } }|null, budget?: { take(kind: string): Promise<{ ok: boolean }> }|null }} deps
 *   demo·guard·budget 이 없으면 예시 계정 차단·사람 확인·가입 예산을 건너뛴다
 */
export function registerPlatformRoutes(app, deps) {
  const { env, platform, runtimeFor, db, memberOf, wsCookie, clearWsCookie, WS_COOKIE } = deps;
  const demo = deps.demo ?? null;
  const guard = deps.guard ?? null;
  const budget = deps.budget ?? null;
  const ipOf = clientIp(env.APP_TRUST_PROXY);
  const turnstileHtml = () => (guard?.turnstile?.enabled ? guard.turnstile.widgetHtml() : '');
  const isDemoUser = async (user) => Boolean(demo && user && (await demo.isDemoUser(user.id)));
  const secure = cookieSecure(env);
  const plain = createHtml({ menus: () => [], logoutPost: true, env });
  const legal = createLegalPages({ env, html: plain });
  const consents = createConsents({ db, env });

  const page = async (status, opts, cookies) => withCookies(await plain.page(status, opts), cookies);
  const inviteCookie = (token) =>
    `${INVITE_COOKIE}=${token}; Path=/; Max-Age=${INVITE_MAX_AGE}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const clearInviteCookie = () => `${INVITE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  const pendingInvite = (req) => {
    const t = readCookie(req, INVITE_COOKIE);
    return t && INVITE_RE.test(t) ? t : null;
  };
  const callbackUrl = (req, extra = '') => `${deps.appOrigin(req)}/auth/callback${extra}`;

  async function session(req) {
    const s = await platform.auth.fromRequest(req);
    return { client: s.client, user: s.user, cookies: [...(s.setCookies ?? [])] };
  }

  /** 로그인한 사람이 갈 곳: 약관 버전이 바뀜 → 재동의, 초대 대기 → 수락 화면, 회사 없음 → 회사 만들기, 그 외 → 오늘의 공고 */
  async function homeFor(req, user, client) {
    if (await consents.needsReconsent(user.id)) return '/consent';
    const invite = pendingInvite(req);
    if (invite) return `/join/${invite}`;
    const list = await platform.memberships(user.id, client);
    return list && list.length > 0 ? '/today' : '/workspaces/new';
  }

  function currentMembership(req, list) {
    const wanted = readCookie(req, WS_COOKIE);
    return list.find((m) => m.workspaceId === wanted) ?? list[0] ?? null;
  }

  /** 앱 틀(사이드바)로 그린다. 회사가 없으면 틀 없이 */
  async function appPage(req, user, client, opts, cookies, status = 200) {
    const list = await platform.memberships(user.id, client);
    const m = list && list.length > 0 ? currentMembership(req, list) : null;
    if (!m) return page(status, opts, cookies);
    const res = await db.withWorkspace(m.workspaceId, async () => {
      const runtime = await runtimeFor(m.workspaceId);
      return runtime.ctx.html.page(status, { ...opts, member: memberOf(m) });
    });
    return withCookies(res, cookies);
  }

  // --- 첫 화면 --------------------------------------------------------------
  async function landing(c) {
    const req = c.req.raw;
    const { client, user, cookies } = await session(req);
    if (user) return see(await homeFor(req, user, client), cookies);
    const url = new URL(req.url);
    const showDemo = demoEnabled(env);
    const opts =
      url.searchParams.get('deleted') === '1'
        ? landingView({ message: TEXT.landing.deleted, kind: 'success', demo: showDemo })
        : landingView({ demo: showDemo });
    return page(200, opts, cookies);
  }
  app.get('/', landing);
  app.get('/welcome', landing);

  // --- 가입 ------------------------------------------------------------------
  app.get('/signup', async (c) => {
    const req = c.req.raw;
    const { user, cookies } = await session(req);
    if (user) return see('/', cookies);
    const invited = Boolean(pendingInvite(req));
    const mode = signupMode(env);
    if (mode === 'closed' && !invited) return page(200, signupClosedView(), cookies);
    return page(200, signupView({ showCode: mode === 'code' && !invited, invited, turnstileHtml: turnstileHtml() }), cookies);
  });

  app.post('/signup', async (c) => {
    const req = c.req.raw;
    const form = await readForm(req);
    const email = field(form, 'email').toLowerCase();
    const password = raw(form, 'password');
    const name = field(form, 'name');
    const invited = Boolean(pendingInvite(req));
    const mode = signupMode(env);
    const showCode = mode === 'code' && !invited;
    const agreed = { terms: field(form, CONSENT_FIELDS.terms) === '1', privacy: field(form, CONSENT_FIELDS.privacy) === '1' };
    const fail = (code, status = 400, message = null) =>
      page(status, signupView({ email, name, code, showCode, invited, agreed, turnstileHtml: turnstileHtml(), message }));

    if (mode === 'closed' && !invited) return page(403, signupClosedView());
    if (showCode) {
      const expected = String(env.APP_SIGNUP_CODE ?? '');
      if (!expected || field(form, 'code') !== expected) return fail('BAD_CODE', 403);
    }
    if (!checkEmail(email)) return fail('BAD_EMAIL');
    const pwErr = checkPassword(password);
    if (pwErr) return fail(pwErr);
    if (!checkName(name, 40)) return fail('BAD_NAME');
    if (!agreed.terms || !agreed.privacy) return fail('CONSENT_REQUIRED');
    if (guard?.turnstile?.enabled && !(await guard.turnstile.verify(field(form, 'cf-turnstile-response'), ipOf(c)))) {
      return fail(null, 400, GUARD_TEXT.human);
    }
    if (budget && !(await budget.take('signup')).ok) return fail(null, 429, BUDGET_TEXT.signup);

    const r = await platform.auth.signUp({ email, password, memberName: name, redirectTo: callbackUrl(req) });
    if (!r || !r.ok) {
      const code = r?.error ?? 'UNKNOWN';
      return fail(code, code === 'RATE_LIMIT' ? 429 : code === 'EMAIL_TAKEN' ? 409 : 400);
    }
    await consents.record({ userId: r.userId, email, req });
    // PKCE 검증 쿠키: 메일 링크의 /auth/callback 에서 코드 교환에 쓴다
    return see(`/verify-notice?email=${encodeURIComponent(email)}`, r.setCookies);
  });

  app.get('/verify-notice', (c) => {
    const email = new URL(c.req.url).searchParams.get('email') ?? '';
    return page(200, verifyNoticeView({ email: email.slice(0, 254) }));
  });

  // --- 메일 링크 돌아오는 곳 ----------------------------------------------------
  app.get('/auth/callback', async (c) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const badLink = (cookies) => page(400, landingView({ message: TEXT.landing.badLink }), cookies);
    if (!code) return badLink();
    const r = await platform.auth.exchangeCode(req, code);
    const cookies = [...(r?.setCookies ?? [])];
    if (!r || !r.ok || !r.user) return badLink(cookies);
    if (url.searchParams.get('type') === 'recovery') return see('/account/password?recovery=1', cookies);
    return see(await homeFor(req, r.user, undefined), cookies);
  });

  // --- 로그인·로그아웃 -----------------------------------------------------------
  app.get('/login', async (c) => {
    const { user, cookies } = await session(c.req.raw);
    if (user) return see('/', cookies);
    return page(200, loginView(), cookies);
  });

  app.post('/login', async (c) => {
    const form = await readForm(c.req.raw);
    const email = field(form, 'email').toLowerCase();
    const password = raw(form, 'password');
    if (!checkEmail(email) || password === '') return page(400, loginView({ email, code: 'BAD_CREDENTIALS' }));
    const r = await platform.auth.signIn({ email, password });
    if (!r || !r.ok) {
      const code = r?.error ?? 'UNKNOWN';
      return page(code === 'RATE_LIMIT' ? 429 : 400, loginView({ email, code }));
    }
    return see('/', r.setCookies);
  });

  app.post('/logout', async (c) => {
    const r = await platform.auth.signOut(c.req.raw);
    return see('/welcome', [...(r?.setCookies ?? []), clearWsCookie()]);
  });
  // GET 으로는 로그아웃하지 않는다(링크·미리 불러오기로 세션이 끊기지 않게)
  app.get('/logout', async (c) => {
    const { user, cookies } = await session(c.req.raw);
    return see(user ? '/account' : '/welcome', cookies);
  });

  // --- 비밀번호 다시 정하기 --------------------------------------------------------
  app.get('/reset', (c) => page(200, resetView()));

  app.post('/reset', async (c) => {
    const req = c.req.raw;
    const form = await readForm(req);
    const email = field(form, 'email').toLowerCase();
    if (!checkEmail(email)) return page(400, resetView({ email, code: 'BAD_EMAIL' }));
    const r = await platform.auth.resetPassword({ email, redirectTo: callbackUrl(req, '?type=recovery') });
    return page(200, resetView({ sent: true }), r?.setCookies);
  });

  // --- 약관·개인정보처리방침 ------------------------------------------------------
  app.get('/terms', () => legal.terms());
  app.get('/privacy', () => legal.privacy());

  // --- 로그인한 사람만 ----------------------------------------------------------
  /** user 가 없으면 GET 은 /welcome 으로, 그 외는 403 */
  function signedIn(handler) {
    return async (c) => {
      const req = c.req.raw;
      const s = await session(req);
      if (!s.user) {
        const safe = req.method === 'GET' || req.method === 'HEAD';
        return withCookies(safe ? new Response(null, { status: 302, headers: { location: '/welcome' } }) : new Response('Forbidden', { status: 403 }), s.cookies);
      }
      return handler(c, s);
    };
  }

  // 약관 버전이 바뀐 뒤 다시 동의
  app.get(
    '/consent',
    signedIn(async (c, { cookies }) => withCookies(await legal.consent({}), cookies)),
  );

  app.post(
    '/consent',
    signedIn(async (c, { client, user, cookies }) => {
      const req = c.req.raw;
      const form = await readForm(req);
      if (field(form, CONSENT_FIELDS.terms) !== '1' || field(form, CONSENT_FIELDS.privacy) !== '1') {
        return withCookies(await legal.consent({ error: true }), cookies);
      }
      await consents.record({ userId: user.id, email: user.email, req });
      return see(await homeFor(req, user, client), cookies);
    }),
  );

  app.get(
    '/account/password',
    signedIn((c, { cookies }) => {
      const recovery = new URL(c.req.url).searchParams.get('recovery') === '1';
      return page(200, passwordView({ recovery }), cookies);
    }),
  );

  app.post(
    '/account/password',
    signedIn(async (c, { user, cookies }) => {
      const req = c.req.raw;
      if (await isDemoUser(user)) return withCookies(await blockedResponse(req, plain), cookies);
      const recovery = new URL(req.url).searchParams.get('recovery') === '1';
      const form = await readForm(req);
      const current = recovery ? '' : raw(form, 'current');
      const next = raw(form, 'next');
      const next2 = raw(form, 'next2');
      const fail = (code) => page(400, passwordView({ recovery, code }), cookies);
      if (!recovery && current === '') return fail('BAD_CURRENT');
      if (next !== next2) return fail('PASSWORD_MISMATCH');
      const pwErr = checkPassword(next);
      if (pwErr) return fail(pwErr);
      const r = await platform.auth.updatePassword(req, { current, next });
      if (!r || !r.ok) return fail(r?.error ?? 'UNKNOWN');
      return see('/account?saved=1', [...cookies, ...(r.setCookies ?? [])]);
    }),
  );

  async function accountPage(c, { client, user, cookies }, { code = null, status = 200 } = {}) {
    const req = c.req.raw;
    const list = (await platform.memberships(user.id, client)) ?? [];
    const current = list.length ? currentMembership(req, list) : null;
    const saved = new URL(req.url).searchParams.get('saved') === '1';
    const opts = accountView({ email: user.email, list, currentId: current?.workspaceId ?? null, saved, code, demoUser: await isDemoUser(user) });
    return appPage(req, user, client, opts, cookies, status);
  }

  app.get('/account', signedIn((c, s) => accountPage(c, s)));

  app.post(
    '/account/delete',
    signedIn(async (c, s) => {
      const req = c.req.raw;
      const { client, user, cookies } = s;
      if (await isDemoUser(user)) return withCookies(await blockedResponse(req, plain), cookies);
      const form = await readForm(req);
      const password = raw(form, 'password');
      if (password === '') return accountPage(c, s, { code: 'DELETE_PASSWORD', status: 400 });
      if (field(form, 'confirm') !== '1') return accountPage(c, s, { code: 'DELETE_CONFIRM', status: 400 });
      // 비밀번호 재확인: 새로 만든 세션 쿠키는 내보내지 않는다
      const check = await platform.auth.signIn({ email: user.email, password });
      if (!check || !check.ok) return accountPage(c, s, { code: 'DELETE_PASSWORD', status: 400 });

      const list = (await platform.memberships(user.id, client)) ?? [];
      const owned = list.filter((m) => m.role === 'owner' && UUID_RE.test(String(m.workspaceId))).map((m) => m.workspaceId);
      const r = await platform.deleteAccount(client);
      if (!r || !r.ok) return accountPage(c, s, { code: 'UNKNOWN', status: 500 });

      // 대표였던 회사의 업무 행은 플랫폼이 회사 삭제와 함께 지운다(FK cascade). 열린 런타임만 캐시에서 뺀다
      for (const id of owned) {
        try {
          await deps.dropRuntime(id);
        } catch {
          // 열지 못했으면 닫을 것도 없다
        }
      }
      const out = await platform.auth.signOut(req);
      return see('/welcome?deleted=1', [...cookies, ...(out?.setCookies ?? []), clearWsCookie()]);
    }),
  );

  // --- 회사 만들기·전환 ---------------------------------------------------------
  app.get(
    '/workspaces/new',
    signedIn(async (c, { user, cookies }) => {
      const name = signupName(user);
      return page(200, workspaceNewView({ name, max: maxWorkspaces(env) }), cookies);
    }),
  );

  app.post(
    '/workspaces/new',
    signedIn(async (c, { client, user, cookies }) => {
      if (await isDemoUser(user)) return withCookies(await blockedResponse(c.req.raw, plain), cookies);
      const form = await readForm(c.req.raw);
      const company = field(form, 'company');
      const name = field(form, 'name');
      const max = maxWorkspaces(env);
      const fail = (code, status = 400) => page(status, workspaceNewView({ company, name, code, max }), cookies);
      if (!checkName(company, 60)) return fail('BAD_COMPANY');
      if (!checkName(name, 40)) return fail('BAD_NAME');
      let workspaceId;
      try {
        ({ workspaceId } = await platform.createWorkspace(client, { name: company, memberName: name }));
      } catch (err) {
        if (err && err.code === 'WORKSPACE_LIMIT') return fail('WORKSPACE_LIMIT', 409);
        return fail('UNKNOWN', 500);
      }
      await db.withWorkspace(workspaceId, async () => {
        const runtime = await runtimeFor(workspaceId);
        await runtime.ctx.settings.set('company_name', company);
      });
      return see('/settings?first=1', [...cookies, wsCookie(workspaceId)]);
    }),
  );

  app.post(
    '/workspaces/switch',
    signedIn(async (c, { client, user, cookies }) => {
      const form = await readForm(c.req.raw);
      const id = field(form, 'workspace');
      const list = (await platform.memberships(user.id, client)) ?? [];
      if (!UUID_RE.test(id) || !list.some((m) => m.workspaceId === id)) return page(403, notMemberView(), cookies);
      return see('/today', [...cookies, wsCookie(id)]);
    }),
  );

  // --- 초대 수락 ---------------------------------------------------------------
  app.get('/join/:token', async (c) => {
    const req = c.req.raw;
    const token = c.req.param('token');
    const { user, cookies } = await session(req);
    if (!INVITE_RE.test(token)) return page(403, joinBadView(), cookies);
    if (!user) return see('/signup?invite=1', [...cookies, inviteCookie(token)]);
    return page(200, joinView({ token }), cookies);
  });

  app.post(
    '/join/:token',
    signedIn(async (c, { client, user, cookies }) => {
      const token = c.req.param('token');
      if (!INVITE_RE.test(token)) return page(403, joinBadView(), cookies);
      let accepted = null;
      try {
        accepted = await platform.acceptInvite(client, { tokenHash: platform.hashToken(token) });
      } catch {
        accepted = null;
      }
      if (!accepted) return page(403, joinBadView(), [...cookies, clearInviteCookie()]);
      return see('/today', [...cookies, clearInviteCookie(), wsCookie(accepted.workspaceId)]);
    }),
  );

  // --- 내 정보 ----------------------------------------------------------------
  app.get(
    '/me',
    signedIn(async (c, { client, user, cookies }) => {
      const req = c.req.raw;
      const list = (await platform.memberships(user.id, client)) ?? [];
      if (list.length === 0) return see('/workspaces/new', cookies);
      const m = currentMembership(req, list);
      const member = memberOf(m);
      const res = await db.withWorkspace(m.workspaceId, async () => {
        const runtime = await runtimeFor(m.workspaceId);
        const company = (await runtime.ctx.settings.get('company_name')) ?? m.workspaceName;
        return runtime.ctx.html.layout({ ...meView({ member, company }), member });
      });
      return withCookies(res, cookies);
    }),
  );
}
