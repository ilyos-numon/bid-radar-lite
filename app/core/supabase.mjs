// 플랫폼 클라이언트: 계정·회사·초대·인증키·감사 기록. 외부 호출은 전부 이 파일에서만 한다.
// 세션 쿠키·토큰 갱신은 @supabase/ssr, 토큰 검증은 jose 가 한다. 이 파일은 암호 코드를 갖지 않는다.
import { createServerClient, parseCookieHeader, serializeCookieHeader } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader, decodeJwt, customFetch } from 'jose';
import { hashInvite } from './auth.mjs';
import { openDb } from './db.mjs';

const MEMBERSHIP_TTL_MS = 30 * 1000;
const KEY_TTL_MS = 60 * 1000;
const JWKS_TTL_MS = 10 * 60 * 1000;

const KEY_NAMES = ['NARA_API_KEY', 'LLM_API_BASE', 'LLM_API_KEY', 'LLM_MODEL', 'SUPPORT_API_BASE', 'SUPPORT_API_KEY'];

// 인증 서버 오류 코드 → 앱 오류 코드 (한 곳에서만 매핑한다)
export const AUTH_ERROR_MAP = {
  user_already_exists: 'EMAIL_TAKEN',
  email_exists: 'EMAIL_TAKEN',
  weak_password: 'WEAK_PASSWORD',
  same_password: 'WEAK_PASSWORD',
  over_request_rate_limit: 'RATE_LIMIT',
  over_email_send_rate_limit: 'RATE_LIMIT',
  over_sms_send_rate_limit: 'RATE_LIMIT',
  invalid_credentials: 'BAD_CREDENTIALS',
  email_not_confirmed: 'EMAIL_NOT_CONFIRMED',
};
// 오래된 서버는 code 없이 문장만 준다
const AUTH_MESSAGE_MAP = {
  'invalid login credentials': 'BAD_CREDENTIALS',
  'email not confirmed': 'EMAIL_NOT_CONFIRMED',
  'user already registered': 'EMAIL_TAKEN',
};
// 데이터베이스 함수가 raise 하는 이름 → 앱 오류 코드
export const DB_ERROR_CODES = [
  'WORKSPACE_LIMIT',
  'INVITE_INVALID',
  'FORBIDDEN',
  'NOT_AUTHENTICATED',
  'INVALID_ROLE',
  'CANNOT_REMOVE_SELF',
  'CANNOT_REMOVE_OWNER',
];

function mapAuthError(error, allowed) {
  if (!error) return 'UNKNOWN';
  let code = AUTH_ERROR_MAP[error.code] ?? null;
  if (!code && error.name === 'AuthWeakPasswordError') code = 'WEAK_PASSWORD';
  if (!code && error.status === 429) code = 'RATE_LIMIT';
  if (!code && typeof error.message === 'string') code = AUTH_MESSAGE_MAP[error.message.trim().toLowerCase()] ?? null;
  return code && allowed.includes(code) ? code : 'UNKNOWN';
}

function mapDbError(error) {
  const msg = String(error?.message ?? '').trim();
  return DB_ERROR_CODES.includes(msg) ? msg : 'UNKNOWN';
}

// 로그용 원인: 오류 코드·HTTP 상태·메시지 앞 80자만 (헤더·키·응답 본문은 넣지 않는다)
function dbCause(error, status) {
  const code = String(error?.code ?? '').trim();
  const msg = String(error?.message ?? '')
    .replace(/eyJ[\w-]*\.[\w-]*\.[\w-]*/g, '[jwt]')
    .replace(/sb_(secret|publishable)_[\w-]+/g, '[key]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const parts = [];
  const db = [code, msg].filter(Boolean).join(' ');
  if (db) parts.push(`db=${db}`);
  if (Number.isInteger(status) && status > 0) parts.push(`http=${status}`);
  return parts.length ? ` (${parts.join(' ')})` : '';
}

function platformError(error, where, status) {
  const code = mapDbError(error);
  const cause = code === 'UNKNOWN' ? dbCause(error, status) : '';
  const err = new Error(`platform ${where} failed: ${code}${cause}`);
  err.code = code;
  return err;
}

const PREFLIGHT_MESSAGES = {
  connect: 'SUPABASE_URL 에 연결하지 못했습니다. 주소와 스택이 켜져 있는지 확인해 주세요 (npm run supabase:start).',
  key: 'SUPABASE_SERVICE_ROLE_KEY 가 맞지 않습니다. supabase status -o env 의 SERVICE_ROLE_KEY 를 그대로 복사했는지 확인해 주세요 (익명 키나 secret 키를 넣으면 안 됩니다).',
  anon: 'SUPABASE_ANON_KEY 가 맞지 않습니다. supabase status -o env 의 ANON_KEY 를 그대로 복사했는지 확인해 주세요.',
  schema: '플랫폼 스키마가 적용되지 않았습니다. supabase db reset 또는 supabase db push 를 실행해 주세요.',
  queue: '작업 큐(pgmq.q_jobs)가 없습니다. APP_DB_URL 이 이 Supabase 의 데이터베이스를 가리키는지 확인하고 supabase db reset 또는 supabase db push 를 실행해 주세요.',
  db: 'APP_DB_URL 로 데이터베이스에 연결하지 못했습니다. 주소·계정(app_worker)·비밀번호를 확인해 주세요.',
  unknown: 'Supabase 점검에 실패했습니다.',
};
const KEY_REJECT_CODES = ['PGRST301', 'PGRST302', 'PGRST303', '42501'];
const SCHEMA_MISSING_CODES = ['42P01', 'PGRST205'];

/** 키 종류 힌트: JWT payload 의 role 클레임만 읽는다 (서명 검증 아님). JWT 가 아니면 null */
function keyRole(key) {
  try {
    const role = decodeJwt(String(key).trim())?.role;
    return typeof role === 'string' && /^[a-z_]{1,32}$/.test(role) ? role : null;
  } catch {
    return null;
  }
}

function maskForStore(name, value) {
  const v = String(value);
  if (name.endsWith('_BASE') || name === 'LLM_MODEL') return v;
  return v.length >= 8 ? `${v.slice(0, 3)}…${v.slice(-2)}` : '••••';
}

// 감사 기록에는 값이 들어가지 않게 한다
const SECRET_FIELD = /pass|secret|token|value|api_?key|authorization|cookie/i;
function scrubDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const out = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_FIELD.test(k)) continue;
    if (v !== null && typeof v === 'object') continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// 가입 때 적은 이름: 값이 있을 때만 memberName 필드를 붙인다 (기존 반환 모양 유지)
function withMemberName(user, metadata) {
  const v = metadata?.member_name;
  return typeof v === 'string' && v !== '' ? { ...user, memberName: v } : user;
}

function toUser(u) {
  if (!u || !u.id) return null;
  return withMemberName(
    { id: u.id, email: u.email ?? null, emailConfirmed: Boolean(u.email_confirmed_at ?? u.confirmed_at) },
    u.user_metadata,
  );
}

function userFromClaims(claims) {
  return withMemberName(
    {
      id: claims.sub,
      email: claims.email ?? null,
      emailConfirmed: claims.user_metadata?.email_verified !== false,
    },
    claims.user_metadata,
  );
}

function cookieSecure(env) {
  if (env.APP_COOKIE_SECURE === '1') return true;
  if (env.APP_COOKIE_SECURE === '0') return false;
  return String(env.APP_BASE_URL ?? '').startsWith('https://');
}

/**
 * @param {{ env: object, fetchImpl?: typeof fetch, now?: () => Date }} deps
 */
export function createPlatform({ env, fetchImpl = globalThis.fetch, now = () => new Date() }) {
  const url = String(env?.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!url) return null;
  const anonKey = String(env.SUPABASE_ANON_KEY ?? '');
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY ?? '');
  const jwtSecret = String(env.SUPABASE_JWT_SECRET ?? '');
  const maxWorkspaces = Number(env.APP_MAX_WORKSPACES) > 0 ? Number(env.APP_MAX_WORKSPACES) : 50;
  const cookieOptions = { secure: cookieSecure(env), sameSite: 'lax', path: '/', httpOnly: true };
  const clock = () => now().getTime();
  const fetchFn = (...args) => fetchImpl(...args);

  // 서비스 롤: 세션을 저장·갱신하지 않는다
  const service = createClient(url, serviceKey || anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchFn },
  });

  function serverClient(req, setCookies) {
    const header = req?.headers?.get?.('cookie') ?? '';
    return createServerClient(url, anonKey, {
      cookies: {
        getAll: () => parseCookieHeader(header).map(({ name, value }) => ({ name, value: value ?? '' })),
        setAll: (list) => {
          for (const { name, value, options } of list) setCookies.push(serializeCookieHeader(name, value, options));
        },
      },
      cookieOptions,
      global: { fetch: fetchFn },
    });
  }

  // 현재 비밀번호 확인용: 쿠키를 쓰지 않는 일회용 클라이언트
  function throwawayClient() {
    return createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: fetchFn },
    });
  }

  // --- 토큰 검증 -----------------------------------------------------------
  const hsKey = jwtSecret ? new TextEncoder().encode(jwtSecret) : null;
  let jwks = null;
  function remoteKeys() {
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`), {
        cacheMaxAge: JWKS_TTL_MS,
        [customFetch]: fetchFn,
      });
    }
    return jwks;
  }

  async function verifyAccessToken(token) {
    if (typeof token !== 'string' || !token) return null;
    try {
      const { alg } = decodeProtectedHeader(token);
      const options = { audience: 'authenticated' };
      const { payload } =
        hsKey && alg === 'HS256'
          ? await jwtVerify(token, hsKey, { ...options, algorithms: ['HS256'] })
          : await jwtVerify(token, remoteKeys(), options);
      return payload && payload.sub ? payload : null;
    } catch {
      return null;
    }
  }

  async function sessionClaims(client) {
    const { data } = await client.auth.getSession();
    const token = data?.session?.access_token;
    if (!token) return { token: null, claims: null };
    return { token, claims: await verifyAccessToken(token) };
  }

  async function userIdOf(client) {
    try {
      const { claims } = await sessionClaims(client);
      return claims?.sub ?? null;
    } catch {
      return null;
    }
  }

  // --- 인증 ----------------------------------------------------------------
  const auth = {
    async fromRequest(req) {
      const setCookies = [];
      const client = serverClient(req, setCookies);
      let user = null;
      try {
        const { token, claims } = await sessionClaims(client);
        if (claims) user = userFromClaims(claims);
        else if (token) {
          const { data } = await client.auth.getUser();
          user = toUser(data?.user);
        }
      } catch {
        user = null;
      }
      return { client, user, setCookies };
    },

    async signUp({ email, password, memberName, redirectTo }) {
      const setCookies = [];
      const client = serverClient(null, setCookies);
      try {
        const { data, error } = await client.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: redirectTo, data: { member_name: memberName ?? '' } },
        });
        if (error) return { ok: false, error: mapAuthError(error, ['EMAIL_TAKEN', 'WEAK_PASSWORD', 'RATE_LIMIT']) };
        // 메일 인증을 켠 서버는 이미 있는 주소에 빈 identities 로 답한다
        if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          return { ok: false, error: 'EMAIL_TAKEN' };
        }
        return { ok: true, needsConfirm: !data?.session, userId: data?.user?.id ?? null, setCookies };
      } catch {
        return { ok: false, error: 'UNKNOWN' };
      }
    },

    async signIn({ email, password }) {
      const setCookies = [];
      const client = serverClient(null, setCookies);
      try {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) {
          return { ok: false, error: mapAuthError(error, ['BAD_CREDENTIALS', 'EMAIL_NOT_CONFIRMED', 'RATE_LIMIT']) };
        }
        return { ok: true, setCookies, user: toUser(data?.user) };
      } catch {
        return { ok: false, error: 'UNKNOWN' };
      }
    },

    async signOut(req) {
      const setCookies = [];
      const client = serverClient(req, setCookies);
      try {
        await client.auth.signOut();
      } catch {
        // 서버에 못 알려도 쿠키는 지운다
      }
      const cleared = new Set(setCookies.map((c) => c.slice(0, c.indexOf('='))));
      const header = req?.headers?.get?.('cookie') ?? '';
      for (const { name } of parseCookieHeader(header)) {
        if (name.startsWith('sb-') && !cleared.has(name)) {
          setCookies.push(serializeCookieHeader(name, '', { ...cookieOptions, maxAge: 0 }));
        }
      }
      return { setCookies };
    },

    async exchangeCode(req, code) {
      const setCookies = [];
      const client = serverClient(req, setCookies);
      try {
        const { data, error } = await client.auth.exchangeCodeForSession(String(code ?? ''));
        if (error || !data?.session) return { ok: false, setCookies };
        return { ok: true, setCookies, user: toUser(data.user) };
      } catch {
        return { ok: false, setCookies };
      }
    },

    async resetPassword({ email, redirectTo }) {
      const setCookies = [];
      const client = serverClient(null, setCookies);
      try {
        await client.auth.resetPasswordForEmail(email, { redirectTo });
      } catch {
        // 계정 존재 여부를 드러내지 않는다
      }
      return { ok: true, setCookies };
    },

    async updatePassword(req, { current, next }) {
      const setCookies = [];
      const client = serverClient(req, setCookies);
      try {
        const { claims } = await sessionClaims(client);
        if (!claims) return { ok: false, error: 'BAD_CURRENT' };
        const viaRecovery = Array.isArray(claims.amr) && claims.amr.some((a) => a?.method === 'recovery' || a?.method === 'otp');
        if (current) {
          const check = await throwawayClient().auth.signInWithPassword({ email: claims.email, password: current });
          if (check.error) return { ok: false, error: 'BAD_CURRENT' };
        } else if (!viaRecovery) {
          return { ok: false, error: 'BAD_CURRENT' };
        }
        const { error } = await client.auth.updateUser({ password: next });
        if (error) return { ok: false, error: mapAuthError(error, ['WEAK_PASSWORD']) };
        return { ok: true, setCookies };
      } catch {
        return { ok: false, error: 'UNKNOWN' };
      }
    },
  };

  // --- 멤버십 (30초 캐시) ----------------------------------------------------
  const membershipCache = new Map();

  async function memberships(userId, client) {
    const hit = membershipCache.get(userId);
    if (hit && clock() - hit.at < MEMBERSHIP_TTL_MS) return hit.list;
    const db = client ?? service;
    const { data: rows, error, status } = await db
      .from('memberships')
      .select('workspace_id,role,member_id,member_name,created_at')
      .eq('user_id', userId);
    if (error) throw platformError(error, 'memberships', status);
    const ids = [...new Set((rows ?? []).map((r) => r.workspace_id))];
    const names = new Map();
    if (ids.length > 0) {
      const { data: ws, error: wsError, status: wsStatus } = await db.from('workspaces').select('id,name').in('id', ids);
      if (wsError) throw platformError(wsError, 'memberships', wsStatus);
      for (const w of ws ?? []) names.set(w.id, w.name);
    }
    const list = (rows ?? [])
      .slice()
      .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')))
      .map((r) => ({
        workspaceId: r.workspace_id,
        workspaceName: names.get(r.workspace_id) ?? '',
        role: r.role,
        memberId: Number(r.member_id),
        memberName: r.member_name,
      }));
    membershipCache.set(userId, { at: clock(), list });
    return list;
  }
  memberships.invalidate = (userId) => {
    if (userId === undefined) membershipCache.clear();
    else membershipCache.delete(userId);
  };

  async function rpc(client, fn, args, where) {
    const { data, error, status } = await (client ?? service).rpc(fn, args);
    if (error) throw platformError(error, where, status);
    return data;
  }

  async function createWorkspace(client, { name, memberName }) {
    const workspaceId = await rpc(
      client,
      'create_workspace',
      { p_name: name, p_member_name: memberName, p_max: maxWorkspaces },
      'createWorkspace',
    );
    const uid = await userIdOf(client);
    if (uid) memberships.invalidate(uid);
    return { workspaceId };
  }

  async function registerInvite(client, { workspaceId, memberId, memberName, role, tokenHash }) {
    const inviteId = await rpc(
      client,
      'register_invite',
      { p_ws: workspaceId, p_token_hash: tokenHash, p_member_id: memberId, p_member_name: memberName, p_role: role ?? 'staff' },
      'registerInvite',
    );
    return { inviteId };
  }

  async function acceptInvite(client, { tokenHash }) {
    let data;
    try {
      data = await rpc(client, 'accept_invite', { p_token_hash: tokenHash }, 'acceptInvite');
    } catch (e) {
      if (e.code === 'INVITE_INVALID') return null;
      throw e;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    const uid = await userIdOf(client);
    if (uid) memberships.invalidate(uid);
    return { workspaceId: row.workspace_id, memberId: Number(row.member_id), role: row.role, memberName: row.member_name };
  }

  /** 대표가 구성원(가입·초대 대기)을 내보낸다. 오류 코드: CANNOT_REMOVE_SELF | CANNOT_REMOVE_OWNER | FORBIDDEN */
  async function removeMember(client, workspaceId, memberId) {
    await rpc(client, 'remove_member', { p_ws: workspaceId, p_member_id: Number(memberId) }, 'removeMember');
    memberships.invalidate();
  }

  async function listWorkspaces() {
    const data = await rpc(service, 'list_workspaces_all', {}, 'listWorkspaces');
    return (data ?? []).map((w) => ({ id: w.id, name: w.name }));
  }

  // --- 인증키 (KeyStore, 60초 캐시) ------------------------------------------
  const keyStores = new Map();

  function keys(workspaceId) {
    const existing = keyStores.get(workspaceId);
    if (existing) return existing;
    let cache = null; // { at, values: Map }
    let loading = null;

    function checkName(name) {
      if (!KEY_NAMES.includes(name)) {
        const err = new Error('platform keys: unknown key name');
        err.code = 'KEY_NAME';
        throw err;
      }
    }

    async function status() {
      const { data, error, status: httpStatus } = await service
        .from('workspace_keys')
        .select('name,masked,updated_at')
        .eq('workspace_id', workspaceId);
      if (error) throw platformError(error, 'keys.status', httpStatus);
      return (data ?? [])
        .map((r) => ({ name: r.name, masked: r.masked, updatedAt: r.updated_at }))
        .sort((a, b) => KEY_NAMES.indexOf(a.name) - KEY_NAMES.indexOf(b.name));
    }

    async function fetchAll() {
      const values = new Map();
      for (const { name } of await status()) {
        const value = await rpc(service, 'get_workspace_key', { p_ws: workspaceId, p_name: name }, 'keys.get');
        if (typeof value === 'string' && value !== '') values.set(name, value);
      }
      cache = { at: clock(), values };
      return cache;
    }

    function load() {
      if (cache && clock() - cache.at < KEY_TTL_MS) return Promise.resolve();
      if (!loading) {
        loading = fetchAll().finally(() => {
          loading = null;
        });
      }
      return loading.then(() => undefined);
    }

    const store = {
      enabled: true,
      workspaceId,
      // 동기 조회: 캐시에서 읽는다. 오래됐으면 뒤에서 다시 읽어 둔다. 요청 전에 load() 를 기다리면 최신 값이다.
      get(name) {
        checkName(name);
        if (cache && clock() - cache.at >= KEY_TTL_MS) load().catch(() => {});
        return cache?.values.get(name) ?? null;
      },
      load,
      async set(name, value, { byUserId, client } = {}) {
        checkName(name);
        const v = String(value ?? '');
        if (!v) {
          const err = new Error('platform keys: empty value');
          err.code = 'KEY_EMPTY';
          throw err;
        }
        await rpc(client ?? service, 'set_workspace_key', { p_ws: workspaceId, p_name: name, p_value: v, p_masked: maskForStore(name, v) }, 'keys.set');
        void byUserId;
        store.invalidate();
        await load();
      },
      async remove(name, { byUserId, client } = {}) {
        checkName(name);
        await rpc(client ?? service, 'delete_workspace_key', { p_ws: workspaceId, p_name: name }, 'keys.remove');
        void byUserId;
        store.invalidate();
        await load();
      },
      status,
      invalidate() {
        cache = null;
      },
    };
    keyStores.set(workspaceId, store);
    return store;
  }

  async function deleteAccount(client) {
    const uid = await userIdOf(client);
    await rpc(client, 'delete_my_account', {}, 'deleteAccount');
    try {
      // 계정이 이미 없으므로 서버에 알리지 않고 쿠키만 지운다
      await client.auth.signOut({ scope: 'local' });
    } catch {
      // 무시
    }
    if (uid) memberships.invalidate(uid);
    return { ok: true };
  }

  async function audit(event, { userId = null, workspaceId = null, detail = null } = {}) {
    try {
      const { error } = await service
        .from('audit_log')
        .insert({ event: String(event), user_id: userId, workspace_id: workspaceId, detail: scrubDetail(detail) });
      return { ok: !error };
    } catch {
      return { ok: false };
    }
  }

  // --- 시작 점검 (키 값은 결과에 넣지 않는다) ----------------------------------
  function preflightFail(kind, extra = '') {
    let message = PREFLIGHT_MESSAGES[kind] + extra;
    if (kind === 'key') {
      const role = keyRole(serviceKey);
      if (role) message += `\n지금 들어 있는 키의 종류: ${role}`;
    }
    return { ok: false, kind, retryable: kind === 'connect' || kind === 'unknown' || kind === 'db', message };
  }

  /** @param {{ db?: object }} [opts] db 를 주면 그 연결로 작업 큐를 확인한다 */
  async function preflight(opts = {}) {
    let res;
    try {
      res = await service.from('workspace_keys').select('workspace_id').limit(1).retry(false);
    } catch {
      return preflightFail('connect');
    }
    const { error, status } = res;
    if (error) {
      const code = String(error.code ?? '');
      const msg = String(error.message ?? '');
      if (!status) return preflightFail('connect');
      if (SCHEMA_MISSING_CODES.includes(code)) return preflightFail('schema');
      if (status === 401 || status === 403 || KEY_REJECT_CODES.includes(code) || /JWS|JWT|signature|api key/i.test(msg)) {
        return preflightFail('key');
      }
      return preflightFail('unknown', dbCause(error, status));
    }
    let health;
    try {
      health = await fetchFn(`${url}/auth/v1/health`, { headers: { apikey: anonKey } });
    } catch {
      return preflightFail('connect');
    }
    if (health.status === 401 || health.status === 403) return preflightFail('anon');
    if (!health.ok) return preflightFail('unknown', ` (auth http=${health.status})`);
    return queueCheck(opts.db);
  }

  // 업무 DB(APP_DB_URL) 에 작업 큐 테이블이 있는지. db 를 주지 않으면 APP_DB_URL 로 잠깐 연결한다(없으면 건너뛴다)
  async function queueCheck(given) {
    const dbUrl = String(env.APP_DB_URL ?? '').trim();
    if (!given && !dbUrl) return { ok: true };
    let db = given;
    try {
      if (!db) db = await openDb({ url: dbUrl, poolSize: 1 });
      const row = (await db.admin("select to_regclass('pgmq.q_jobs') is not null as ok")).rows[0];
      return row && row.ok === true ? { ok: true } : preflightFail('queue');
    } catch (err) {
      return preflightFail('db', dbCause(err, 0));
    } finally {
      if (db && !given) await db.close().catch(() => {});
    }
  }

  return {
    enabled: true,
    auth,
    preflight,
    verifyAccessToken,
    memberships,
    createWorkspace,
    registerInvite,
    acceptInvite,
    removeMember,
    listWorkspaces,
    keys,
    deleteAccount,
    audit,
    hashToken: (token) => hashInvite(token),
    serviceClient: service,
  };
}
