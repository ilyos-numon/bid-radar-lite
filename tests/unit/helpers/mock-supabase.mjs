// 모의 인증 서버(GoTrue)·데이터 API(PostgREST). fetchImpl 로 주입한다. 네트워크를 쓰지 않는다.
// 토큰 발급은 이 모의 서버 안에서만 jose 로 한다.
import { randomUUID, createHash } from 'node:crypto';
import { SignJWT, decodeJwt, generateKeyPair, exportJWK } from 'jose';

export const MOCK_URL = 'http://localhost:55399';

function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function authError(status, errorCode, msg, extra = {}) {
  return json(status, { code: status, error_code: errorCode, msg, ...extra });
}

function dbError(status, message, code = 'P0001') {
  return json(status, { code, message, details: null, hint: null });
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {{ alg?: 'HS256'|'ES256', confirmations?: boolean }} [opts]
 */
export async function createMockSupabase({ alg = 'HS256', confirmations = true } = {}) {
  const jwtSecret = 'mock-jwt-secret-for-unit-tests-only-0123456789';
  const anonKey = 'mock-anon-key';
  const serviceKey = 'mock-service-role-key';
  const hsKey = new TextEncoder().encode(jwtSecret);
  let esPair = null;
  let publicJwk = null;
  if (alg === 'ES256') {
    esPair = await generateKeyPair('ES256');
    publicJwk = { ...(await exportJWK(esPair.publicKey)), kid: 'mock-key-1', alg: 'ES256', use: 'sig' };
  }

  const state = {
    users: new Map(), // id → { id, email, password, confirmed, metadata, challenge }
    refresh: new Map(), // refresh token → user id
    codes: new Map(), // auth code → { userId, challenge, type }
    mails: [], // { to, type, link }
    workspaces: [],
    memberships: [],
    invites: [],
    workspace_keys: [],
    vault: new Map(), // secret id → value
    audit_log: [],
  };
  const calls = [];
  const failures = new Map(); // route → [{ status, errorCode }]

  function failNext(route, { status, errorCode, msg = 'mock failure' }) {
    if (!failures.has(route)) failures.set(route, []);
    failures.get(route).push({ status, errorCode, msg });
  }

  function takeFailure(route) {
    const list = failures.get(route);
    if (!list || list.length === 0) return null;
    const f = list.shift();
    return authError(f.status, f.errorCode, f.msg);
  }

  function publicUser(u) {
    return {
      id: u.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: u.email,
      email_confirmed_at: u.confirmed ? '2026-10-30T00:00:00Z' : null,
      user_metadata: { ...u.metadata, email_verified: u.confirmed },
      app_metadata: { provider: 'email' },
      identities: [{ id: u.id, provider: 'email' }],
      created_at: '2026-10-30T00:00:00Z',
    };
  }

  async function signToken(u, { expiresIn = 3600, amr = 'password' } = {}) {
    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + expiresIn;
    const claims = {
      email: u.email,
      role: 'authenticated',
      aud: 'authenticated',
      session_id: randomUUID(),
      user_metadata: { ...u.metadata, email_verified: u.confirmed },
      amr: [{ method: amr, timestamp: iat }],
    };
    const jwt = new SignJWT(claims).setSubject(u.id).setIssuedAt(iat).setExpirationTime(exp);
    const token =
      alg === 'ES256'
        ? await jwt.setProtectedHeader({ alg: 'ES256', kid: 'mock-key-1', typ: 'JWT' }).sign(esPair.privateKey)
        : await jwt.setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(hsKey);
    return { token, exp };
  }

  async function session(u, opts = {}) {
    const expiresIn = opts.expiresIn ?? 3600;
    const { token, exp } = await signToken(u, opts);
    const refresh = `rt-${randomUUID()}`;
    state.refresh.set(refresh, u.id);
    return {
      access_token: token,
      token_type: 'bearer',
      expires_in: expiresIn,
      expires_at: exp,
      refresh_token: refresh,
      user: publicUser(u),
    };
  }

  function addUser({ email, password, confirmed = true, metadata = {} }) {
    const u = { id: randomUUID(), email, password, confirmed, metadata };
    state.users.set(u.id, u);
    return u;
  }

  function userByEmail(email) {
    for (const u of state.users.values()) if (u.email === email) return u;
    return null;
  }

  /** 만료된(또는 유효한) 세션을 쿠키 값으로 만든다 (@supabase/ssr 기본 형식: base64- + base64url JSON) */
  async function sessionCookie(u, { expiresIn = 3600 } = {}) {
    const s = await session(u, { expiresIn });
    if (expiresIn <= 0) {
      s.expires_at = Math.floor(Date.now() / 1000) + expiresIn;
    }
    const ref = new URL(MOCK_URL).hostname.split('.')[0];
    const value = `base64-${b64url(JSON.stringify(s))}`;
    return { cookie: `sb-${ref}-auth-token=${value}`, session: s };
  }

  function bearer(req) {
    const h = req.headers.get('authorization') ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (token === serviceKey) return { kind: 'service' };
    if (!token || token === anonKey) return { kind: 'anon' };
    try {
      const claims = decodeJwt(token);
      if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return { kind: 'expired' };
      if (!state.users.has(claims.sub)) return { kind: 'expired' };
      return { kind: 'user', uid: claims.sub };
    } catch {
      return { kind: 'anon' };
    }
  }

  async function readBody(req) {
    const text = await req.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  // --- 인증 서버 ------------------------------------------------------------
  async function gotrue(req, path, url) {
    const who = bearer(req);
    if (req.method === 'GET' && path === '/.well-known/jwks.json') {
      return json(200, { keys: publicJwk ? [publicJwk] : [] });
    }
    if (req.method === 'POST' && path === '/signup') {
      const f = takeFailure('signup');
      if (f) return f;
      const body = await readBody(req);
      if (String(body.password ?? '').length < 8) {
        return authError(422, 'weak_password', 'Password should be at least 8 characters.', {
          weak_password: { reasons: ['length'] },
        });
      }
      const existing = userByEmail(body.email);
      if (existing) {
        if (!confirmations) return authError(422, 'user_already_exists', 'User already registered');
        // 실제 서버처럼 빈 identities 로 답한다
        return json(200, { ...publicUser({ ...existing, id: randomUUID() }), identities: [] });
      }
      const u = addUser({ email: body.email, password: body.password, confirmed: !confirmations, metadata: body.data ?? {} });
      if (!confirmations) return json(200, await session(u));
      const code = `code-${randomUUID()}`;
      state.codes.set(code, { userId: u.id, challenge: body.code_challenge ?? null, type: 'signup' });
      const redirect = url.searchParams.get('redirect_to') ?? '';
      state.mails.push({ to: u.email, type: 'signup', link: `${MOCK_URL}/auth/v1/verify?token=${code}&type=signup&redirect_to=${encodeURIComponent(redirect)}` });
      return json(200, publicUser(u));
    }
    if (req.method === 'GET' && path === '/verify') {
      const code = url.searchParams.get('token');
      const entry = state.codes.get(code);
      const redirect = url.searchParams.get('redirect_to') ?? MOCK_URL;
      if (!entry) return new Response(null, { status: 303, headers: { location: `${redirect}?error=access_denied` } });
      const u = state.users.get(entry.userId);
      if (u) u.confirmed = true;
      return new Response(null, { status: 303, headers: { location: `${redirect}?code=${code}` } });
    }
    if (req.method === 'POST' && path === '/token') {
      const f = takeFailure('token');
      if (f) return f;
      const grant = url.searchParams.get('grant_type');
      const body = await readBody(req);
      if (grant === 'password') {
        const u = userByEmail(body.email);
        if (!u || u.password !== body.password) return authError(400, 'invalid_credentials', 'Invalid login credentials');
        if (!u.confirmed) return authError(400, 'email_not_confirmed', 'Email not confirmed');
        return json(200, await session(u));
      }
      if (grant === 'refresh_token') {
        const uid = state.refresh.get(body.refresh_token);
        if (!uid || !state.users.has(uid)) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token');
        state.refresh.delete(body.refresh_token);
        return json(200, await session(state.users.get(uid)));
      }
      if (grant === 'pkce') {
        const entry = state.codes.get(body.auth_code);
        if (!entry) return authError(400, 'flow_state_not_found', 'invalid flow state');
        const verifier = String(body.code_verifier ?? '');
        const challenge = b64url(createHash('sha256').update(verifier).digest());
        if (entry.challenge && entry.challenge !== challenge && entry.challenge !== verifier) {
          return authError(400, 'bad_code_verifier', 'code challenge does not match');
        }
        state.codes.delete(body.auth_code);
        const u = state.users.get(entry.userId);
        return json(200, await session(u, { amr: entry.type === 'recovery' ? 'recovery' : 'password' }));
      }
      return authError(400, 'unsupported_grant_type', 'unsupported grant');
    }
    if (path === '/user') {
      if (who.kind !== 'user') return authError(403, 'bad_jwt', 'invalid JWT');
      const u = state.users.get(who.uid);
      if (req.method === 'GET') return json(200, publicUser(u));
      if (req.method === 'PUT') {
        const body = await readBody(req);
        if (body.password !== undefined) {
          if (String(body.password).length < 8) {
            return authError(422, 'weak_password', 'Password should be at least 8 characters.', { weak_password: { reasons: ['length'] } });
          }
          if (body.password === u.password) return authError(422, 'same_password', 'New password should be different.');
          u.password = body.password;
        }
        return json(200, publicUser(u));
      }
    }
    if (req.method === 'POST' && path === '/logout') {
      return new Response(null, { status: 204 });
    }
    if (req.method === 'POST' && path === '/recover') {
      const body = await readBody(req);
      const u = userByEmail(body.email);
      if (u) {
        const code = `code-${randomUUID()}`;
        state.codes.set(code, { userId: u.id, challenge: body.code_challenge ?? null, type: 'recovery' });
        state.mails.push({ to: u.email, type: 'recovery', link: `${MOCK_URL}/auth/v1/verify?token=${code}&type=recovery` });
      }
      return json(200, {});
    }
    return authError(404, 'not_found', 'not found');
  }

  // --- 데이터 API -----------------------------------------------------------
  const isMember = (uid, ws) => state.memberships.some((m) => m.user_id === uid && m.workspace_id === ws);
  const isOwner = (uid, ws) => state.memberships.some((m) => m.user_id === uid && m.workspace_id === ws && m.role === 'owner');

  const RLS = {
    workspaces: (uid, r) => isMember(uid, r.id),
    memberships: (uid, r) => isMember(uid, r.workspace_id),
    invites: (uid, r) => isOwner(uid, r.workspace_id),
    workspace_keys: (uid, r) => isMember(uid, r.workspace_id),
    audit_log: (uid, r) => isOwner(uid, r.workspace_id),
  };
  const USER_COLUMNS = { workspace_keys: ['name', 'masked', 'updated_at'] };

  function parseFilters(url) {
    const out = [];
    for (const [k, v] of url.searchParams) {
      if (['select', 'order', 'limit', 'offset', 'columns'].includes(k)) continue;
      if (v.startsWith('eq.')) out.push((r) => String(r[k]) === v.slice(3));
      else if (v.startsWith('in.(')) {
        const set = v
          .slice(4, -1)
          .split(',')
          .map((s) => s.replace(/^"|"$/g, ''));
        out.push((r) => set.includes(String(r[k])));
      }
    }
    return out;
  }

  async function rest(req, path, url) {
    const who = bearer(req);
    if (who.kind === 'expired') return dbError(401, 'JWT expired', 'PGRST303');
    if (path.startsWith('/rpc/')) return rpc(path.slice(5), await readBody(req), who);
    const table = path.slice(1);
    if (!state[table] || !Array.isArray(state[table])) return dbError(404, 'relation does not exist', '42P01');
    if (req.method === 'GET') {
      if (who.kind === 'anon') return dbError(401, 'permission denied', '42501');
      let rows = state[table];
      if (who.kind === 'user') rows = rows.filter((r) => RLS[table](who.uid, r));
      for (const f of parseFilters(url)) rows = rows.filter(f);
      const select = (url.searchParams.get('select') ?? '*').split(',').filter(Boolean);
      if (who.kind === 'user' && USER_COLUMNS[table]) {
        const bad = select.filter((c) => c === '*' || !USER_COLUMNS[table].includes(c));
        if (bad.length) return dbError(403, 'permission denied for table', '42501');
      }
      const out = rows.map((r) => (select.includes('*') ? { ...r } : Object.fromEntries(select.map((c) => [c, r[c] ?? null]))));
      return json(200, out);
    }
    if (req.method === 'POST') {
      if (who.kind !== 'service') return dbError(403, 'permission denied', '42501');
      const body = await readBody(req);
      const list = Array.isArray(body) ? body : [body];
      for (const row of list) state[table].push({ id: state[table].length + 1, at: new Date().toISOString(), ...row });
      return new Response(null, { status: 201 });
    }
    return dbError(405, 'method not allowed', 'PGRST000');
  }

  function rpc(fn, a, who) {
    const uid = who.kind === 'user' ? who.uid : null;
    const forbid = () => dbError(403, 'FORBIDDEN', '42501');
    const raise = (name) => dbError(400, name);
    const audit = (user_id, workspace_id, event, detail = null) =>
      state.audit_log.push({ id: state.audit_log.length + 1, at: new Date().toISOString(), user_id, workspace_id, event, detail });
    switch (fn) {
      case 'create_workspace': {
        if (!uid) return dbError(401, 'NOT_AUTHENTICATED', '42501');
        if (a.p_max != null && state.workspaces.length >= a.p_max) return raise('WORKSPACE_LIMIT');
        const id = randomUUID();
        state.workspaces.push({ id, name: a.p_name, created_by: uid, created_at: new Date().toISOString() });
        state.memberships.push({ workspace_id: id, user_id: uid, role: 'owner', member_id: 1, member_name: a.p_member_name, created_at: new Date().toISOString() });
        audit(uid, id, 'workspace.create');
        return json(200, id);
      }
      case 'register_invite': {
        if (!uid || !isOwner(uid, a.p_ws)) return forbid();
        if (!['owner', 'staff'].includes(a.p_role)) return raise('INVALID_ROLE');
        const id = randomUUID();
        state.invites.push({
          id,
          workspace_id: a.p_ws,
          token_hash: a.p_token_hash,
          member_id: a.p_member_id,
          member_name: a.p_member_name,
          role: a.p_role,
          created_by: uid,
          expires_at: Date.now() + 14 * 86400000,
          used_at: null,
          used_by: null,
        });
        audit(uid, a.p_ws, 'invite.create', { member_id: a.p_member_id, role: a.p_role });
        return json(200, id);
      }
      case 'accept_invite': {
        if (!uid) return dbError(401, 'NOT_AUTHENTICATED', '42501');
        const inv = state.invites.find((i) => i.token_hash === a.p_token_hash && !i.used_at && i.expires_at > Date.now());
        if (!inv) return raise('INVITE_INVALID');
        if (!isMember(uid, inv.workspace_id)) {
          state.memberships.push({
            workspace_id: inv.workspace_id,
            user_id: uid,
            role: inv.role,
            member_id: inv.member_id,
            member_name: inv.member_name,
            created_at: new Date().toISOString(),
          });
        }
        inv.used_at = new Date().toISOString();
        inv.used_by = uid;
        audit(uid, inv.workspace_id, 'invite.accept', { member_id: inv.member_id });
        const m = state.memberships.find((x) => x.user_id === uid && x.workspace_id === inv.workspace_id);
        return json(200, [{ workspace_id: m.workspace_id, member_id: m.member_id, role: m.role, member_name: m.member_name }]);
      }
      case 'remove_member': {
        if (who.kind !== 'service' && (!uid || !isOwner(uid, a.p_ws))) return forbid();
        const target = state.memberships.find((m) => m.workspace_id === a.p_ws && m.member_id === a.p_member_id);
        if (target && target.user_id === uid) return raise('CANNOT_REMOVE_SELF');
        if (target && target.role === 'owner') return raise('CANNOT_REMOVE_OWNER');
        state.memberships = state.memberships.filter((m) => !(m.workspace_id === a.p_ws && m.member_id === a.p_member_id));
        state.invites = state.invites.filter((i) => !(i.workspace_id === a.p_ws && i.member_id === a.p_member_id && !i.used_at));
        audit(uid, a.p_ws, 'member.remove', { member_id: a.p_member_id });
        return new Response(null, { status: 204 });
      }
      case 'set_workspace_key': {
        if (!uid || !isOwner(uid, a.p_ws)) return forbid();
        let row = state.workspace_keys.find((k) => k.workspace_id === a.p_ws && k.name === a.p_name);
        if (!row) {
          const secretId = randomUUID();
          state.vault.set(secretId, a.p_value);
          row = { workspace_id: a.p_ws, name: a.p_name, secret_id: secretId };
          state.workspace_keys.push(row);
        } else {
          state.vault.set(row.secret_id, a.p_value);
        }
        Object.assign(row, { masked: a.p_masked, updated_by: uid, updated_at: new Date().toISOString() });
        audit(uid, a.p_ws, 'key.set', { name: a.p_name });
        return new Response(null, { status: 204 });
      }
      case 'delete_workspace_key': {
        if (!uid || !isOwner(uid, a.p_ws)) return forbid();
        const i = state.workspace_keys.findIndex((k) => k.workspace_id === a.p_ws && k.name === a.p_name);
        if (i >= 0) {
          state.vault.delete(state.workspace_keys[i].secret_id);
          state.workspace_keys.splice(i, 1);
        }
        audit(uid, a.p_ws, 'key.delete', { name: a.p_name });
        return new Response(null, { status: 204 });
      }
      case 'delete_my_account': {
        if (!uid) return dbError(401, 'NOT_AUTHENTICATED', '42501');
        const owned = state.memberships.filter((m) => m.user_id === uid && m.role === 'owner').map((m) => m.workspace_id);
        state.workspaces = state.workspaces.filter((w) => !owned.includes(w.id));
        state.memberships = state.memberships.filter((m) => !owned.includes(m.workspace_id) && m.user_id !== uid);
        state.invites = state.invites.filter((i) => !owned.includes(i.workspace_id));
        for (const k of state.workspace_keys.filter((x) => owned.includes(x.workspace_id))) state.vault.delete(k.secret_id);
        state.workspace_keys = state.workspace_keys.filter((k) => !owned.includes(k.workspace_id));
        state.users.delete(uid);
        audit(uid, null, 'account.delete');
        return new Response(null, { status: 204 });
      }
      case 'get_workspace_key': {
        if (who.kind !== 'service') return dbError(403, 'permission denied for function', '42501');
        const row = state.workspace_keys.find((k) => k.workspace_id === a.p_ws && k.name === a.p_name);
        return json(200, row ? state.vault.get(row.secret_id) ?? null : null);
      }
      case 'list_workspaces_all': {
        if (who.kind !== 'service') return dbError(403, 'permission denied for function', '42501');
        return json(200, state.workspaces.map((w) => ({ id: w.id, name: w.name })));
      }
      default:
        return dbError(404, 'function not found', 'PGRST202');
    }
  }

  async function fetchImpl(input, init) {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    const url = new URL(req.url);
    const call = { method: req.method, path: url.pathname, search: url.search, auth: bearer(req).kind };
    calls.push(call);
    if (url.origin !== new URL(MOCK_URL).origin) return json(502, { error: 'unexpected host' });
    if (url.pathname.startsWith('/auth/v1')) return gotrue(req, url.pathname.slice('/auth/v1'.length), url);
    if (url.pathname.startsWith('/rest/v1')) return rest(req, url.pathname.slice('/rest/v1'.length), url);
    return json(404, { error: 'not found' });
  }

  return {
    url: MOCK_URL,
    anonKey,
    serviceKey,
    jwtSecret: alg === 'HS256' ? jwtSecret : '',
    env: {
      SUPABASE_URL: MOCK_URL,
      SUPABASE_ANON_KEY: anonKey,
      SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      SUPABASE_JWT_SECRET: alg === 'HS256' ? jwtSecret : '',
    },
    fetch: fetchImpl,
    calls,
    state,
    failNext,
    addUser,
    userByEmail,
    session,
    sessionCookie,
    resetCalls() {
      calls.length = 0;
    },
  };
}
