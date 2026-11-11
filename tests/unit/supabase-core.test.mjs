import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPlatform } from '../../app/core/supabase.mjs';
import { hashInvite } from '../../app/core/auth.mjs';
import { createMockSupabase } from './helpers/mock-supabase.mjs';

const BASE = 'http://localhost:8820';

async function setup({ alg, confirmations, env = {}, now } = {}) {
  const mock = await createMockSupabase({ alg, confirmations });
  const platform = createPlatform({ env: { ...mock.env, APP_BASE_URL: BASE, ...env }, fetchImpl: mock.fetch, now });
  return { mock, platform };
}

function reqWith(cookie) {
  return new Request(`${BASE}/`, { headers: cookie ? { cookie } : {} });
}

/** set-cookie 목록 → cookie 헤더 (지우는 쿠키는 뺀다) */
function cookieHeader(setCookies, base = '') {
  const jar = new Map();
  for (const part of base.split(';').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    jar.set(part.slice(0, i), part.slice(i + 1));
  }
  for (const c of setCookies) {
    const first = c.split(';')[0];
    const i = first.indexOf('=');
    const name = first.slice(0, i);
    const value = first.slice(i + 1);
    if (/max-age=0/i.test(c) || value === '') jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function userClient(platform, mock, email, password = 'password-123') {
  let u = mock.userByEmail(email);
  if (!u) u = mock.addUser({ email, password });
  const { cookie } = await mock.sessionCookie(u);
  const { client, user } = await platform.auth.fromRequest(reqWith(cookie));
  return { client, user, cookie, u };
}

describe('createPlatform', () => {
  test('returns null when SUPABASE_URL is empty (legacy mode)', () => {
    assert.equal(createPlatform({ env: {} }), null);
    assert.equal(createPlatform({ env: { SUPABASE_URL: '' } }), null);
    assert.equal(createPlatform({ env: { SUPABASE_URL: '   ' } }), null);
  });

  test('enabled platform exposes the contract methods', async () => {
    const { platform } = await setup();
    assert.equal(platform.enabled, true);
    for (const fn of ['fromRequest', 'signUp', 'signIn', 'signOut', 'exchangeCode', 'resetPassword', 'updatePassword']) {
      assert.equal(typeof platform.auth[fn], 'function', fn);
    }
    for (const fn of ['verifyAccessToken', 'memberships', 'createWorkspace', 'registerInvite', 'acceptInvite', 'removeMember', 'listWorkspaces', 'keys', 'deleteAccount', 'audit', 'hashToken']) {
      assert.equal(typeof platform[fn], 'function', fn);
    }
    assert.equal(typeof platform.memberships.invalidate, 'function');
  });

  test('hashToken matches hashInvite (sha256 hex)', async () => {
    const { platform } = await setup();
    assert.equal(platform.hashToken('abc'), hashInvite('abc'));
    assert.match(platform.hashToken('abc'), /^[0-9a-f]{64}$/);
  });
});

describe('signUp', () => {
  test('new email with mail confirmation → ok, needsConfirm', async () => {
    const { platform, mock } = await setup();
    const r = await platform.auth.signUp({ email: 'a@example.com', password: 'password-123', memberName: '김대표', redirectTo: `${BASE}/auth/callback` });
    assert.equal(r.ok, true);
    assert.equal(r.needsConfirm, true);
    assert.equal(mock.userByEmail('a@example.com').metadata.member_name, '김대표');
    assert.equal(mock.state.mails.length, 1);
  });

  test('without mail confirmation → ok, needsConfirm false, session cookies', async () => {
    const { platform } = await setup({ confirmations: false });
    const r = await platform.auth.signUp({ email: 'b@example.com', password: 'password-123', memberName: 'B' });
    assert.equal(r.ok, true);
    assert.equal(r.needsConfirm, false);
    assert.ok(r.setCookies.some((c) => c.startsWith('sb-localhost-auth-token')));
  });

  test('existing email → EMAIL_TAKEN (both server styles)', async () => {
    const a = await setup();
    a.mock.addUser({ email: 'c@example.com', password: 'password-123' });
    assert.deepEqual(await a.platform.auth.signUp({ email: 'c@example.com', password: 'password-456' }), { ok: false, error: 'EMAIL_TAKEN' });
    const b = await setup({ confirmations: false });
    b.mock.addUser({ email: 'c@example.com', password: 'password-123' });
    assert.deepEqual(await b.platform.auth.signUp({ email: 'c@example.com', password: 'password-456' }), { ok: false, error: 'EMAIL_TAKEN' });
  });

  test('short password → WEAK_PASSWORD', async () => {
    const { platform } = await setup();
    assert.deepEqual(await platform.auth.signUp({ email: 'd@example.com', password: 'short' }), { ok: false, error: 'WEAK_PASSWORD' });
  });

  test('rate limited → RATE_LIMIT, other server error → UNKNOWN', async () => {
    const { platform, mock } = await setup();
    mock.failNext('signup', { status: 429, errorCode: 'over_email_send_rate_limit' });
    assert.deepEqual(await platform.auth.signUp({ email: 'e@example.com', password: 'password-123' }), { ok: false, error: 'RATE_LIMIT' });
    mock.failNext('signup', { status: 500, errorCode: 'unexpected_failure' });
    assert.deepEqual(await platform.auth.signUp({ email: 'e@example.com', password: 'password-123' }), { ok: false, error: 'UNKNOWN' });
  });
});

describe('signIn', () => {
  test('correct password → ok with HttpOnly session cookie', async () => {
    const { platform, mock } = await setup();
    mock.addUser({ email: 'f@example.com', password: 'password-123' });
    const r = await platform.auth.signIn({ email: 'f@example.com', password: 'password-123' });
    assert.equal(r.ok, true);
    const c = r.setCookies.find((x) => x.startsWith('sb-localhost-auth-token'));
    assert.ok(c, 'session cookie');
    assert.match(c, /HttpOnly/i);
    assert.match(c, /SameSite=Lax/i);
    assert.match(c, /Path=\//);
  });

  test('wrong password → BAD_CREDENTIALS', async () => {
    const { platform, mock } = await setup();
    mock.addUser({ email: 'g@example.com', password: 'password-123' });
    assert.deepEqual(await platform.auth.signIn({ email: 'g@example.com', password: 'nope-nope-nope' }), { ok: false, error: 'BAD_CREDENTIALS' });
    assert.deepEqual(await platform.auth.signIn({ email: 'nobody@example.com', password: 'nope-nope-nope' }), { ok: false, error: 'BAD_CREDENTIALS' });
  });

  test('unconfirmed email → EMAIL_NOT_CONFIRMED', async () => {
    const { platform, mock } = await setup();
    mock.addUser({ email: 'h@example.com', password: 'password-123', confirmed: false });
    assert.deepEqual(await platform.auth.signIn({ email: 'h@example.com', password: 'password-123' }), { ok: false, error: 'EMAIL_NOT_CONFIRMED' });
  });

  test('rate limited → RATE_LIMIT', async () => {
    const { platform, mock } = await setup();
    mock.addUser({ email: 'i@example.com', password: 'password-123' });
    mock.failNext('token', { status: 429, errorCode: 'over_request_rate_limit' });
    assert.deepEqual(await platform.auth.signIn({ email: 'i@example.com', password: 'password-123' }), { ok: false, error: 'RATE_LIMIT' });
  });

  test('secure cookie when APP_BASE_URL is https or APP_COOKIE_SECURE=1', async () => {
    const { platform, mock } = await setup({ env: { APP_BASE_URL: 'https://radar.example.com' } });
    mock.addUser({ email: 'j@example.com', password: 'password-123' });
    const r = await platform.auth.signIn({ email: 'j@example.com', password: 'password-123' });
    assert.ok(r.setCookies.every((c) => /Secure/.test(c)));
  });
});

describe('fromRequest / verifyAccessToken', () => {
  test('valid token → user from claims with zero network calls', async () => {
    const { platform, mock } = await setup();
    const u = mock.addUser({ email: 'k@example.com', password: 'password-123' });
    const { cookie } = await mock.sessionCookie(u);
    mock.resetCalls();
    const r = await platform.auth.fromRequest(reqWith(cookie));
    assert.deepEqual(r.user, { id: u.id, email: 'k@example.com', emailConfirmed: true });
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(r.setCookies, []);
  });

  test('expired token → one refresh call and new session cookies', async () => {
    const { platform, mock } = await setup();
    const u = mock.addUser({ email: 'l@example.com', password: 'password-123' });
    const { cookie } = await mock.sessionCookie(u, { expiresIn: -60 });
    mock.resetCalls();
    const r = await platform.auth.fromRequest(reqWith(cookie));
    assert.equal(r.user?.id, u.id);
    assert.equal(mock.calls.length, 1, JSON.stringify(mock.calls));
    assert.equal(mock.calls[0].path, '/auth/v1/token');
    assert.match(mock.calls[0].search, /grant_type=refresh_token/);
    assert.ok(r.setCookies.some((c) => c.startsWith('sb-localhost-auth-token')));
  });

  test('no cookie → user null, no network', async () => {
    const { platform, mock } = await setup();
    const r = await platform.auth.fromRequest(reqWith(''));
    assert.equal(r.user, null);
    assert.ok(r.client);
    assert.equal(mock.calls.length, 0);
  });

  test('verifyAccessToken rejects garbage and accepts a valid HS256 token', async () => {
    const { platform, mock } = await setup();
    const u = mock.addUser({ email: 'm@example.com', password: 'password-123' });
    const s = await mock.session(u);
    assert.equal(await platform.verifyAccessToken('not-a-token'), null);
    assert.equal(await platform.verifyAccessToken(''), null);
    assert.equal(await platform.verifyAccessToken(mock.anonKey), null);
    const claims = await platform.verifyAccessToken(s.access_token);
    assert.equal(claims.sub, u.id);
  });

  test('without JWT secret → remote key set fetched once and cached', async () => {
    const { platform, mock } = await setup({ alg: 'ES256' });
    const u = mock.addUser({ email: 'n@example.com', password: 'password-123' });
    const s1 = await mock.session(u);
    const s2 = await mock.session(u);
    assert.equal((await platform.verifyAccessToken(s1.access_token)).sub, u.id);
    assert.equal((await platform.verifyAccessToken(s2.access_token)).sub, u.id);
    assert.equal(mock.calls.filter((c) => c.path === '/auth/v1/.well-known/jwks.json').length, 1);
  });
});

describe('mail link, sign out, reset, password change', () => {
  test('signUp → mail link → exchangeCode signs in', async () => {
    const { platform, mock } = await setup();
    const r = await platform.auth.signUp({ email: 'o@example.com', password: 'password-123', redirectTo: `${BASE}/auth/callback` });
    assert.ok(r.setCookies.some((c) => c.includes('code-verifier')), 'verifier cookie kept for the mail link');
    assert.ok([...mock.state.codes.values()].every((e) => e.challenge), 'challenge sent to server');
    const link = mock.state.mails.at(-1).link;
    const res = await mock.fetch(link, { redirect: 'manual' });
    const code = new URL(res.headers.get('location')).searchParams.get('code');
    const ex = await platform.auth.exchangeCode(reqWith(cookieHeader(r.setCookies)), code);
    assert.equal(ex.ok, true);
    assert.equal(ex.user.email, 'o@example.com');
    assert.equal(ex.user.emailConfirmed, true);
    assert.ok(ex.setCookies.some((c) => c.startsWith('sb-localhost-auth-token')));
    const bad = await platform.auth.exchangeCode(reqWith(''), 'code-unknown');
    assert.equal(bad.ok, false);
  });

  test('signOut clears the session cookies', async () => {
    const { platform, mock } = await setup();
    const u = mock.addUser({ email: 'p@example.com', password: 'password-123' });
    const { cookie } = await mock.sessionCookie(u);
    const r = await platform.auth.signOut(reqWith(cookie));
    const c = r.setCookies.find((x) => x.startsWith('sb-localhost-auth-token'));
    assert.ok(c);
    assert.match(c, /Max-Age=0/i);
  });

  test('resetPassword is always ok (unknown email too)', async () => {
    const { platform, mock } = await setup();
    mock.addUser({ email: 'q@example.com', password: 'password-123' });
    assert.equal((await platform.auth.resetPassword({ email: 'q@example.com', redirectTo: `${BASE}/auth/callback` })).ok, true);
    assert.equal((await platform.auth.resetPassword({ email: 'nobody@example.com', redirectTo: `${BASE}/auth/callback` })).ok, true);
    assert.equal(mock.state.mails.filter((m) => m.type === 'recovery').length, 1);
  });

  test('updatePassword: BAD_CURRENT, WEAK_PASSWORD, ok', async () => {
    const { platform, mock } = await setup();
    const u = mock.addUser({ email: 'r@example.com', password: 'password-123' });
    const { cookie } = await mock.sessionCookie(u);
    const req = () => reqWith(cookie);
    assert.deepEqual(await platform.auth.updatePassword(req(), { current: 'wrong-password', next: 'password-456' }), { ok: false, error: 'BAD_CURRENT' });
    assert.deepEqual(await platform.auth.updatePassword(req(), { current: '', next: 'password-456' }), { ok: false, error: 'BAD_CURRENT' });
    assert.deepEqual(await platform.auth.updatePassword(req(), { current: 'password-123', next: 'short' }), { ok: false, error: 'WEAK_PASSWORD' });
    const ok = await platform.auth.updatePassword(req(), { current: 'password-123', next: 'password-456' });
    assert.equal(ok.ok, true);
    assert.equal(u.password, 'password-456');
    assert.deepEqual(await platform.auth.updatePassword(reqWith(''), { current: 'x', next: 'password-789' }), { ok: false, error: 'BAD_CURRENT' });
  });
});

describe('workspaces, memberships, invites', () => {
  test('createWorkspace → owner membership; memberships cached 30s and invalidated', async () => {
    let t = Date.parse('2026-10-30T00:00:00Z');
    const { platform, mock } = await setup({ now: () => new Date(t) });
    const { client, user } = await userClient(platform, mock, 's@example.com');
    const { workspaceId } = await platform.createWorkspace(client, { name: '가나조경', memberName: '김대표' });
    assert.match(workspaceId, /^[0-9a-f-]{36}$/);
    const list = await platform.memberships(user.id, client);
    assert.deepEqual(list, [{ workspaceId, workspaceName: '가나조경', role: 'owner', memberId: 1, memberName: '김대표' }]);
    mock.resetCalls();
    await platform.memberships(user.id, client);
    assert.equal(mock.calls.length, 0, 'served from cache');
    t += 31 * 1000;
    await platform.memberships(user.id, client);
    assert.ok(mock.calls.length > 0, 'refetched after 30s');
    mock.resetCalls();
    platform.memberships.invalidate(user.id);
    await platform.memberships(user.id, client);
    assert.ok(mock.calls.length > 0, 'refetched after invalidate');
  });

  test('createWorkspace over APP_MAX_WORKSPACES → WORKSPACE_LIMIT', async () => {
    const { platform, mock } = await setup({ env: { APP_MAX_WORKSPACES: '1' } });
    const { client } = await userClient(platform, mock, 't@example.com');
    await platform.createWorkspace(client, { name: '첫 회사', memberName: '가' });
    await assert.rejects(platform.createWorkspace(client, { name: '둘째 회사', memberName: '가' }), (e) => e.code === 'WORKSPACE_LIMIT');
  });

  test('registerInvite (owner) → acceptInvite joins as staff; reused token → null', async () => {
    const { platform, mock } = await setup();
    const owner = await userClient(platform, mock, 'u@example.com');
    const { workspaceId } = await platform.createWorkspace(owner.client, { name: '다라건설', memberName: '대표' });
    const tokenHash = platform.hashToken('invite-token-1');
    const reg = await platform.registerInvite(owner.client, { workspaceId, memberId: 2, memberName: '박직원', role: 'staff', tokenHash });
    assert.ok(reg.inviteId);
    const staff = await userClient(platform, mock, 'v@example.com');
    assert.deepEqual(await platform.memberships(staff.user.id, staff.client), []);
    const got = await platform.acceptInvite(staff.client, { tokenHash });
    assert.deepEqual(got, { workspaceId, memberId: 2, role: 'staff', memberName: '박직원' });
    const list = await platform.memberships(staff.user.id, staff.client);
    assert.equal(list.length, 1, 'membership cache invalidated after accept');
    assert.equal(await platform.acceptInvite(staff.client, { tokenHash }), null);
    assert.equal(await platform.acceptInvite(staff.client, { tokenHash: hashInvite('never-issued') }), null);
  });

  test('registerInvite by staff → FORBIDDEN error code', async () => {
    const { platform, mock } = await setup();
    const owner = await userClient(platform, mock, 'w@example.com');
    const { workspaceId } = await platform.createWorkspace(owner.client, { name: '마바', memberName: '대표' });
    const tokenHash = platform.hashToken('t2');
    await platform.registerInvite(owner.client, { workspaceId, memberId: 2, memberName: '직원', role: 'staff', tokenHash });
    const staff = await userClient(platform, mock, 'x@example.com');
    await platform.acceptInvite(staff.client, { tokenHash });
    await assert.rejects(
      platform.registerInvite(staff.client, { workspaceId, memberId: 3, memberName: '셋', role: 'staff', tokenHash: platform.hashToken('t3') }),
      (e) => e.code === 'FORBIDDEN' && !e.message.includes('t3'),
    );
  });

  test('listWorkspaces uses the service role', async () => {
    const { platform, mock } = await setup();
    const a = await userClient(platform, mock, 'y1@example.com');
    const b = await userClient(platform, mock, 'y2@example.com');
    const w1 = await platform.createWorkspace(a.client, { name: '하나', memberName: 'A' });
    const w2 = await platform.createWorkspace(b.client, { name: '둘', memberName: 'B' });
    mock.resetCalls();
    const list = await platform.listWorkspaces();
    assert.deepEqual(list, [
      { id: w1.workspaceId, name: '하나' },
      { id: w2.workspaceId, name: '둘' },
    ]);
    assert.equal(mock.calls[0].auth, 'service');
  });
});

describe('removeMember (remove_member RPC)', () => {
  test('owner removes staff and pending invite; self, owner and non-owner are refused', async () => {
    const { platform, mock } = await setup();
    const owner = await userClient(platform, mock, 'rm-owner@example.com');
    const { workspaceId } = await platform.createWorkspace(owner.client, { name: '마바건설', memberName: '대표' });
    const tokenHash = platform.hashToken('invite-token-rm-1');
    await platform.registerInvite(owner.client, { workspaceId, memberId: 2, memberName: '박직원', role: 'staff', tokenHash });
    const staff = await userClient(platform, mock, 'rm-staff@example.com');
    await platform.acceptInvite(staff.client, { tokenHash });
    await platform.registerInvite(owner.client, { workspaceId, memberId: 3, memberName: '최대기', role: 'staff', tokenHash: platform.hashToken('invite-token-rm-2') });

    await assert.rejects(platform.removeMember(staff.client, workspaceId, 3), (e) => e.code === 'FORBIDDEN');
    await assert.rejects(platform.removeMember(owner.client, workspaceId, 1), (e) => e.code === 'CANNOT_REMOVE_SELF');
    mock.state.memberships.push({ workspace_id: workspaceId, user_id: 'other-owner', role: 'owner', member_id: 4, member_name: '공동대표' });
    await assert.rejects(platform.removeMember(owner.client, workspaceId, 4), (e) => e.code === 'CANNOT_REMOVE_OWNER');

    assert.equal((await platform.memberships(staff.user.id, staff.client)).length, 1);
    await platform.removeMember(owner.client, workspaceId, 2);
    await platform.removeMember(owner.client, workspaceId, 3);
    assert.deepEqual(await platform.memberships(staff.user.id, staff.client), [], 'membership cache invalidated');
    assert.equal(mock.state.invites.filter((i) => i.member_id === 3).length, 0, 'pending invite removed');
    const rpcCall = mock.calls.find((c) => c.path === '/rest/v1/rpc/remove_member');
    assert.equal(rpcCall.auth, 'user', "owner's client, not the service role");
  });
});

describe('keys (KeyStore)', () => {
  test('set → load/get value, status masked, remove → gone', async () => {
    const { platform, mock } = await setup();
    const owner = await userClient(platform, mock, 'z@example.com');
    const { workspaceId } = await platform.createWorkspace(owner.client, { name: '키회사', memberName: '대표' });
    const keys = platform.keys(workspaceId);
    assert.equal(keys.enabled, true);
    assert.equal(platform.keys(workspaceId), keys, 'same store per workspace');
    assert.equal(keys.get('NARA_API_KEY'), null);
    await keys.set('NARA_API_KEY', 'abcdefghijklmnop', { byUserId: owner.user.id, client: owner.client });
    await keys.set('LLM_API_BASE', 'https://llm.example.com/v1', { byUserId: owner.user.id, client: owner.client });
    assert.equal(keys.get('NARA_API_KEY'), 'abcdefghijklmnop');
    const status = await keys.status();
    assert.deepEqual(
      status.map((s) => [s.name, s.masked]),
      [
        ['NARA_API_KEY', 'abc…op'],
        ['LLM_API_BASE', 'https://llm.example.com/v1'],
      ],
    );
    assert.ok(status.every((s) => s.updatedAt));
    await keys.set('LLM_API_KEY', 'short', { byUserId: owner.user.id, client: owner.client });
    assert.equal((await keys.status()).find((s) => s.name === 'LLM_API_KEY').masked, '••••');
    await keys.remove('NARA_API_KEY', { byUserId: owner.user.id, client: owner.client });
    assert.equal(keys.get('NARA_API_KEY'), null);
    assert.equal((await keys.status()).some((s) => s.name === 'NARA_API_KEY'), false);
    assert.throws(() => keys.get('APP_SECRET'), (e) => e.code === 'KEY_NAME');
  });

  test('get is cached 60s; invalidate forces a reload', async () => {
    let t = Date.parse('2026-10-30T00:00:00Z');
    const { platform, mock } = await setup({ now: () => new Date(t) });
    const owner = await userClient(platform, mock, 'k1@example.com');
    const { workspaceId } = await platform.createWorkspace(owner.client, { name: '캐시', memberName: '대표' });
    const keys = platform.keys(workspaceId);
    await keys.set('NARA_API_KEY', 'first-value-123', { client: owner.client });
    // 다른 경로로 값이 바뀜 (다른 서버 인스턴스)
    const row = mock.state.workspace_keys.find((k) => k.workspace_id === workspaceId);
    mock.state.vault.set(row.secret_id, 'second-value-456');
    mock.resetCalls();
    await keys.load();
    assert.equal(mock.calls.length, 0, 'fresh cache, no reload');
    assert.equal(keys.get('NARA_API_KEY'), 'first-value-123');
    t += 61 * 1000;
    await keys.load();
    assert.ok(mock.calls.length > 0);
    assert.equal(keys.get('NARA_API_KEY'), 'second-value-456');
    mock.state.vault.set(row.secret_id, 'third-value-789');
    keys.invalidate();
    await keys.load();
    assert.equal(keys.get('NARA_API_KEY'), 'third-value-789');
    assert.ok(mock.calls.every((c) => c.auth === 'service'), 'key reads use the service role');
  });

  test('staff cannot set keys (FORBIDDEN); other workspace store is separate', async () => {
    const { platform, mock } = await setup();
    const owner = await userClient(platform, mock, 'k2@example.com');
    const other = await userClient(platform, mock, 'k3@example.com');
    const w1 = await platform.createWorkspace(owner.client, { name: '일', memberName: '대표' });
    const w2 = await platform.createWorkspace(other.client, { name: '이', memberName: '대표' });
    await platform.keys(w1.workspaceId).set('NARA_API_KEY', 'only-for-one-123', { client: owner.client });
    await assert.rejects(platform.keys(w1.workspaceId).set('NARA_API_KEY', 'hijack-123456', { client: other.client }), (e) => e.code === 'FORBIDDEN' && !e.message.includes('hijack'));
    const k2 = platform.keys(w2.workspaceId);
    await k2.load();
    assert.equal(k2.get('NARA_API_KEY'), null);
    assert.deepEqual(await k2.status(), []);
  });
});

describe('account deletion and audit', () => {
  test('deleteAccount removes owned workspaces and the user', async () => {
    const { platform, mock } = await setup();
    const owner = await userClient(platform, mock, 'del@example.com');
    const { workspaceId } = await platform.createWorkspace(owner.client, { name: '지울회사', memberName: '대표' });
    await platform.keys(workspaceId).set('NARA_API_KEY', 'to-be-deleted-1', { client: owner.client });
    const r = await platform.deleteAccount(owner.client);
    assert.deepEqual(r, { ok: true });
    assert.equal(mock.userByEmail('del@example.com'), null);
    assert.equal(mock.state.workspaces.length, 0);
    assert.equal(mock.state.vault.size, 0);
    assert.ok(mock.state.audit_log.some((a) => a.event === 'account.delete'));
  });

  test('audit stores event without secret values', async () => {
    const { platform, mock } = await setup();
    const r = await platform.audit('key.check', {
      userId: 'u1',
      workspaceId: 'w1',
      detail: { name: 'NARA_API_KEY', value: 'secret-value-xyz', password: 'pw-xyz', token: 'tok-xyz', apiKey: 'k-xyz', result: 'ok' },
    });
    assert.deepEqual(r, { ok: true });
    const row = mock.state.audit_log.at(-1);
    assert.equal(row.event, 'key.check');
    assert.deepEqual(row.detail, { name: 'NARA_API_KEY', result: 'ok' });
    const dump = JSON.stringify(mock.state.audit_log);
    for (const secret of ['secret-value-xyz', 'pw-xyz', 'tok-xyz', 'k-xyz']) assert.equal(dump.includes(secret), false, secret);
  });

  test('key set through the platform never writes the value to the audit log', async () => {
    const { platform, mock } = await setup();
    const owner = await userClient(platform, mock, 'aud@example.com');
    const { workspaceId } = await platform.createWorkspace(owner.client, { name: '감사', memberName: '대표' });
    await platform.keys(workspaceId).set('LLM_API_KEY', 'sk-very-secret-000', { client: owner.client });
    assert.equal(JSON.stringify(mock.state.audit_log).includes('sk-very-secret-000'), false);
    assert.ok(mock.state.audit_log.some((a) => a.event === 'key.set'));
  });
});

describe('preflight and error causes', () => {
  const URL_ = 'http://localhost:55398';
  const KEY_SENTINEL = 'zz-key-sentinel-zz';

  async function jwtWith(claims) {
    const { SignJWT } = await import('jose');
    return new SignJWT({ ...claims, sentinel: KEY_SENTINEL })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(new TextEncoder().encode('test-only-signing-secret-0123456789'));
  }

  function pgError(status, code, message) {
    return () => new Response(JSON.stringify({ code, message, details: null, hint: null }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function fakeFetch({ rest, health = () => new Response('{}', { status: 200 }) }) {
    const calls = [];
    const fn = async (input) => {
      const u = String(input instanceof Request ? input.url : input);
      calls.push(u);
      if (u.includes('/rest/v1/')) return rest();
      if (u.includes('/auth/v1/health')) return health();
      return new Response('{}', { status: 404 });
    };
    fn.calls = calls;
    return fn;
  }

  async function platformWith(fetchImpl, { role = 'service_role' } = {}) {
    const serviceKey = await jwtWith({ role });
    const anonKey = await jwtWith({ role: 'anon' });
    const env = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: anonKey, SUPABASE_SERVICE_ROLE_KEY: serviceKey };
    return { platform: createPlatform({ env, fetchImpl }), serviceKey, anonKey };
  }

  function assertNoSecrets(text, ...keys) {
    for (const k of keys) assert.equal(text.includes(k), false, 'key value leaked');
    assert.equal(text.includes(KEY_SENTINEL), false, 'claim other than role leaked');
  }

  test('ok: service select and auth health pass', async () => {
    const f = fakeFetch({ rest: () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }) });
    const { platform } = await platformWith(f);
    const r = await platform.preflight();
    assert.deepEqual(r, { ok: true });
    assert.ok(f.calls.some((u) => u.includes('/rest/v1/workspace_keys') && u.includes('limit=1')));
    assert.ok(f.calls.some((u) => u.endsWith('/auth/v1/health')));
  });

  test('queue: preflight checks pgmq.q_jobs on the given db', async () => {
    const okRest = () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    const sqls = [];
    const dbWith = (rowOk) => ({
      async admin(text) {
        sqls.push(text);
        if (rowOk instanceof Error) throw rowOk;
        return { rows: [{ ok: rowOk }], rowCount: 1 };
      },
    });
    const { platform } = await platformWith(fakeFetch({ rest: okRest }));
    assert.deepEqual(await platform.preflight({ db: dbWith(true) }), { ok: true });
    assert.match(sqls[0], /pgmq\.q_jobs/);
    const missing = await platform.preflight({ db: dbWith(false) });
    assert.equal(missing.ok, false);
    assert.equal(missing.kind, 'queue');
    assert.equal(missing.retryable, false);
    assert.match(missing.message, /pgmq\.q_jobs/);
    const down = await platform.preflight({ db: dbWith(Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })) });
    assert.equal(down.kind, 'db');
    assert.equal(down.retryable, true);
    assert.match(down.message, /APP_DB_URL/);
  });

  test('connection refused → connect message, retryable, no retry storm', async () => {
    let n = 0;
    const f = async () => {
      n += 1;
      throw new TypeError('fetch failed');
    };
    const { platform, serviceKey, anonKey } = await platformWith(f);
    const r = await platform.preflight();
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'connect');
    assert.equal(r.retryable, true);
    assert.match(r.message, /SUPABASE_URL 에 연결하지 못했습니다/);
    assert.equal(n, 1);
    assertNoSecrets(r.message, serviceKey, anonKey);
  });

  test('bad signature (401 PGRST301) → service key message with role hint', async () => {
    const f = fakeFetch({ rest: pgError(401, 'PGRST301', 'JWSError JWSInvalidSignature') });
    const { platform, serviceKey, anonKey } = await platformWith(f);
    const r = await platform.preflight();
    assert.equal(r.ok, false);
    assert.equal(r.kind, 'key');
    assert.equal(r.retryable, false);
    assert.match(r.message, /SUPABASE_SERVICE_ROLE_KEY 가 맞지 않습니다/);
    assert.match(r.message, /지금 들어 있는 키의 종류: service_role/);
    assertNoSecrets(r.message, serviceKey, anonKey);
  });

  test('anon key in the service slot (42501) → service key message, hint anon', async () => {
    const f = fakeFetch({ rest: pgError(403, '42501', 'permission denied for table workspace_keys') });
    const { platform, serviceKey, anonKey } = await platformWith(f, { role: 'anon' });
    const r = await platform.preflight();
    assert.equal(r.kind, 'key');
    assert.match(r.message, /SUPABASE_SERVICE_ROLE_KEY 가 맞지 않습니다/);
    assert.match(r.message, /지금 들어 있는 키의 종류: anon$/);
    assertNoSecrets(r.message, serviceKey, anonKey);
  });

  test('non-JWT service key → key message without role hint', async () => {
    const f = fakeFetch({ rest: pgError(401, 'PGRST301', 'JWSError JWSInvalidSignature') });
    const env = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: 'anon-x', SUPABASE_SERVICE_ROLE_KEY: 'not-a-jwt-value' };
    const r = await createPlatform({ env, fetchImpl: f }).preflight();
    assert.equal(r.kind, 'key');
    assert.equal(r.message.includes('키의 종류'), false);
    assert.equal(r.message.includes('not-a-jwt-value'), false);
  });

  test('missing table (42P01 / PGRST205) → schema message', async () => {
    for (const [status, code] of [[404, '42P01'], [404, 'PGRST205']]) {
      const f = fakeFetch({ rest: pgError(status, code, 'relation "public.workspace_keys" does not exist') });
      const { platform } = await platformWith(f);
      const r = await platform.preflight();
      assert.equal(r.kind, 'schema', code);
      assert.match(r.message, /플랫폼 스키마가 적용되지 않았습니다/);
    }
  });

  test('platformError log carries the db cause; err.code unchanged', async () => {
    const f = fakeFetch({ rest: pgError(403, '42501', 'permission denied for table workspace_keys') });
    const { platform, serviceKey, anonKey } = await platformWith(f);
    await assert.rejects(platform.keys('w1').status(), (err) => {
      assert.equal(err.code, 'UNKNOWN');
      assert.match(err.message, /^platform keys\.status failed: UNKNOWN \(db=42501 permission denied for table workspace_keys/);
      assert.match(err.message, /http=403/);
      assertNoSecrets(err.message, serviceKey, anonKey);
      return true;
    });
  });

  test('platformError keeps mapped codes without a cause suffix', async () => {
    const f = fakeFetch({ rest: pgError(400, 'P0001', 'FORBIDDEN') });
    const { platform } = await platformWith(f);
    await assert.rejects(platform.keys('w1').status(), (err) => {
      assert.equal(err.code, 'FORBIDDEN');
      assert.equal(err.message, 'platform keys.status failed: FORBIDDEN');
      return true;
    });
  });
});

describe('fromRequest memberName from verified claims', () => {
  test('member_name in token claims → user.memberName; absent → no field', async () => {
    const { platform, mock } = await setup();
    const named = mock.addUser({ email: 'named@example.com', password: 'password-123', metadata: { member_name: '홍길동' } });
    const { cookie } = await mock.sessionCookie(named);
    const r = await platform.auth.fromRequest(reqWith(cookie));
    assert.equal(r.user.memberName, '홍길동');
    const plain = await userClient(platform, mock, 'plain@example.com');
    assert.equal('memberName' in plain.user, false);
  });
});
