import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { run } from '../../scripts/platform-admin.mjs';
import { createPlatform } from '../../app/core/supabase.mjs';
import { hashInvite } from '../../app/core/auth.mjs';
import { createMockSupabase } from './helpers/mock-supabase.mjs';

const BASE = 'http://localhost:8820';
const OWNER_EMAIL = 'owner@example.com';
// 이전 전 기존 모드 DB 는 SQLite 다(현재 schema.sql 은 Postgres 방언). 이 명령이 읽는 표만 SQLite 로 만든다
const LEGACY_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
`;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function adminUser(u) {
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

/**
 * 공용 모의 서버에 없는 관리 API(사용자 조회·일회용 로그인 링크)와 초대 행 삭제만 이 테스트에서 덧붙인다.
 * 나머지 요청은 공용 모의 서버로 보낸다.
 */
function withAdmin(mock) {
  const links = new Map(); // hashed token → user id
  return async function fetchImpl(input, init) {
    const req = input instanceof Request && !init ? input : new Request(input, init);
    const url = new URL(req.url);
    const auth = req.headers.get('authorization') ?? '';
    const isService = auth === `Bearer ${mock.serviceKey}`;
    const p = url.pathname;
    if (p.startsWith('/auth/v1/admin/')) {
      mock.calls.push({ method: req.method, path: p, search: url.search, auth: isService ? 'service' : 'other' });
      if (!isService) return json(403, { code: 403, error_code: 'not_admin', msg: 'User not allowed' });
      if (req.method === 'GET' && p === '/auth/v1/admin/users') {
        return json(200, { users: [...mock.state.users.values()].map(adminUser), aud: 'authenticated' });
      }
      const m = p.match(/^\/auth\/v1\/admin\/users\/([^/]+)$/);
      if (req.method === 'GET' && m) {
        const u = mock.state.users.get(m[1]);
        return u ? json(200, adminUser(u)) : json(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
      }
      if (req.method === 'POST' && p === '/auth/v1/admin/generate_link') {
        const body = JSON.parse((await req.text()) || '{}');
        const u = mock.userByEmail(body.email);
        if (!u) return json(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' });
        const hashed = `hl-${randomUUID()}`;
        links.set(hashed, u.id);
        return json(200, {
          ...adminUser(u),
          action_link: `${mock.url}/auth/v1/verify?token=${hashed}&type=magiclink`,
          email_otp: '123456',
          hashed_token: hashed,
          redirect_to: BASE,
          verification_type: 'magiclink',
        });
      }
      return json(404, { code: 404, error_code: 'not_found', msg: 'not found' });
    }
    if (req.method === 'POST' && p === '/auth/v1/verify') {
      const body = JSON.parse((await req.text()) || '{}');
      mock.calls.push({ method: 'POST', path: p, search: url.search, auth: 'anon' });
      const uid = links.get(body.token_hash);
      if (!uid) return json(403, { code: 403, error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
      links.delete(body.token_hash);
      return json(200, await mock.session(mock.state.users.get(uid), { amr: 'otp' }));
    }
    if (req.method === 'DELETE' && p.startsWith('/rest/v1/')) {
      mock.calls.push({ method: 'DELETE', path: p, search: url.search, auth: isService ? 'service' : 'other' });
      if (!isService) return json(403, { message: 'permission denied', code: '42501' });
      const table = p.slice('/rest/v1/'.length);
      const filters = [...url.searchParams].filter(([, v]) => v.startsWith('eq.'));
      mock.state[table] = mock.state[table].filter((r) => !filters.every(([k, v]) => String(r[k]) === v.slice(3)));
      return new Response(null, { status: 204 });
    }
    return mock.fetch(req);
  };
}

function legacyDb(dir, { company = '테스트건설' } = {}) {
  const file = path.join(dir, 'bid-radar.sqlite');
  const db = new DatabaseSync(file);
  db.exec(LEGACY_SCHEMA);
  const now = '2026-10-01T00:00:00.000Z';
  if (company) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('company_name', company);
  const ins = db.prepare('INSERT INTO members (id, name, role, token_hash, created_at) VALUES (?, ?, ?, ?, ?)');
  // 대표 행 번호가 1 이 아니어도 그대로 옮겨지는지 본다
  ins.run(1, '직원하나', 'staff', hashInvite('old-1'), now);
  ins.run(2, '대표', 'owner', hashInvite('old-2'), now);
  ins.run(3, '직원둘', 'staff', hashInvite('old-3'), now);
  db.close();
  return file;
}

async function setup({ env = {}, owner = true } = {}) {
  const mock = await createMockSupabase();
  const fetchImpl = withAdmin(mock);
  const dir = mkdtempSync(path.join(tmpdir(), 'platform-admin-'));
  const fullEnv = { ...mock.env, APP_BASE_URL: BASE, APP_WS_DIR: path.join(dir, 'ws'), ...env };
  const platform = createPlatform({ env: fullEnv, fetchImpl });
  if (owner) mock.addUser({ email: OWNER_EMAIL, password: 'password-123' });
  const out = [];
  const err = [];
  const io = {
    env: fullEnv,
    platform,
    fetchImpl,
    stdout: { write: (s) => out.push(String(s)) },
    stderr: { write: (s) => err.push(String(s)) },
  };
  return { mock, dir, env: fullEnv, io, out: () => out.join(''), err: () => err.join(''), db: legacyDb(dir) };
}

function joinLinks(text) {
  return [...text.matchAll(/(\S+): (http:\/\/localhost:8820\/join\/([A-Za-z0-9_-]+))/g)].map((m) => ({ name: m[1], link: m[2], token: m[3] }));
}

test('platform-admin: migrate-legacy registers workspace, prints migrate command, invites members', async () => {
  const s = await setup();
  const code = await run(['migrate-legacy', '--db', s.db, '--owner-email', OWNER_EMAIL, '--no-keys'], s.io);
  assert.equal(code, 0, s.err());

  const owner = s.mock.userByEmail(OWNER_EMAIL);
  assert.equal(s.mock.state.workspaces.length, 1);
  const ws = s.mock.state.workspaces[0];
  assert.equal(ws.name, '테스트건설');
  assert.equal(ws.created_by, owner.id);
  const own = s.mock.state.memberships.filter((m) => m.workspace_id === ws.id);
  assert.equal(own.length, 1);
  assert.equal(own[0].user_id, owner.id);
  assert.equal(own[0].role, 'owner');
  assert.equal(own[0].member_id, 2);
  assert.equal(own[0].member_name, '대표');

  // 업무 데이터는 복사하지 않는다: 워크스페이스 파일·디렉토리 없음, 원본은 그대로, 이전 명령 출력
  assert.ok(!existsSync(path.join(s.env.APP_WS_DIR, `${ws.id}.sqlite`)));
  assert.ok(!existsSync(path.join(s.env.APP_WS_DIR, ws.id)));
  assert.ok(existsSync(s.db));
  const orig = new DatabaseSync(s.db, { readOnly: true });
  assert.deepEqual(
    orig.prepare('SELECT id, token_hash FROM members ORDER BY id').all().map((r) => r.token_hash),
    [hashInvite('old-1'), hashInvite('old-2'), hashInvite('old-3')],
  );
  orig.close();
  const cmd = `node scripts/migrate-sqlite.mjs --from ${JSON.stringify(s.db)} --workspace ${ws.id} --to-dir ${JSON.stringify(path.join(s.env.APP_WS_DIR, ws.id))}`;
  assert.ok(s.out().includes(cmd), 'prints the migrate-sqlite command');

  // 구성원 2명에게 새 초대: 링크 출력, 플랫폼에 등록(대표 이름으로, 기존 행 번호 그대로)
  const links = joinLinks(s.out());
  assert.deepEqual(links.map((l) => l.name).sort(), ['직원둘', '직원하나']);
  const ids = { 직원하나: 1, 직원둘: 3 };
  for (const l of links) {
    const inv = s.mock.state.invites.find((i) => i.token_hash === hashInvite(l.token));
    assert.ok(inv);
    assert.equal(inv.workspace_id, ws.id);
    assert.equal(inv.member_id, ids[l.name]);
    assert.equal(inv.member_name, l.name);
    assert.equal(inv.role, 'staff');
    assert.equal(inv.created_by, owner.id);
  }
  assert.equal(s.mock.state.invites.length, 2);
  assert.match(s.out(), new RegExp(ws.id));
});

test('platform-admin: migrate-legacy prints --to-url command (without the URL value) when APP_DB_URL is set', async () => {
  const dbUrl = 'postgresql://app_worker:s3cret-pw@db.example.invalid:5432/postgres';
  const s = await setup({ env: { APP_DB_URL: dbUrl } });
  const code = await run(['migrate-legacy', '--db', s.db, '--owner-email', OWNER_EMAIL, '--no-keys'], s.io);
  assert.equal(code, 0, s.err());
  const ws = s.mock.state.workspaces[0];
  const cmd = `node scripts/migrate-sqlite.mjs --from ${JSON.stringify(s.db)} --workspace ${ws.id} --to-url "$APP_DB_URL"`;
  assert.ok(s.out().includes(cmd), 'prints the --to-url migrate command');
  assert.doesNotMatch(s.out(), /--to-dir/);
  assert.ok(!s.out().includes(dbUrl) && !s.out().includes('s3cret-pw'), 'database URL not printed');
});

test('platform-admin: migrate-legacy exits 2 when owner email missing', async () => {
  const s = await setup({ owner: false });
  const code = await run(['migrate-legacy', '--db', s.db, '--owner-email', 'nobody@example.com'], s.io);
  assert.equal(code, 2);
  assert.match(s.err() + s.out(), /먼저 가입과 메일 인증을 마쳐 주세요/);
  assert.equal(s.mock.state.workspaces.length, 0);

  // 메일 인증을 안 한 계정도 같은 안내
  s.mock.addUser({ email: 'pending@example.com', password: 'password-123', confirmed: false });
  const code2 = await run(['migrate-legacy', '--db', s.db, '--owner-email', 'pending@example.com'], s.io);
  assert.equal(code2, 2);
  assert.equal(s.mock.state.workspaces.length, 0);
});

test('platform-admin: migrate-legacy copies env keys to vault unless --no-keys', async () => {
  const keys = { NARA_API_KEY: 'nara-secret-value-123', LLM_API_KEY: 'llm-secret-value-456', LLM_MODEL: 'test-model' };
  const s = await setup({ env: keys });
  assert.equal(await run(['migrate-legacy', '--db', s.db, '--owner-email', OWNER_EMAIL, '--name', '새이름'], s.io), 0, s.err());
  const ws = s.mock.state.workspaces[0];
  assert.equal(ws.name, '새이름');
  const rows = s.mock.state.workspace_keys.filter((k) => k.workspace_id === ws.id);
  assert.deepEqual(rows.map((r) => r.name).sort(), ['LLM_API_KEY', 'LLM_MODEL', 'NARA_API_KEY']);
  for (const r of rows) assert.equal(s.mock.state.vault.get(r.secret_id), keys[r.name]);
  assert.equal(rows.find((r) => r.name === 'NARA_API_KEY').masked, 'nar…23');

  // --no-keys: 두 번째 레거시 DB 를 옮길 때 키를 건드리지 않는다
  const s2 = await setup({ env: keys });
  assert.equal(await run(['migrate-legacy', '--db', s2.db, '--owner-email', OWNER_EMAIL, '--no-keys'], s2.io), 0, s2.err());
  assert.equal(s2.mock.state.workspace_keys.length, 0);
  assert.equal(s2.mock.state.vault.size, 0);
});

test('platform-admin: output never contains key values', async () => {
  const keys = {
    NARA_API_KEY: 'nara-secret-value-123',
    LLM_API_KEY: 'llm-secret-value-456',
    SUPPORT_API_KEY: 'support-secret-value-789',
    LLM_API_BASE: 'http://localhost:9999/v1',
  };
  const s = await setup({ env: keys });
  assert.equal(await run(['migrate-legacy', '--db', s.db, '--owner-email', OWNER_EMAIL], s.io), 0, s.err());
  await run(['list'], s.io);
  await run(['invite-links', s.mock.state.workspaces[0].id], s.io);
  // 실패 경로도 확인: 같은 DB 를 다시 옮기려 해도 값이 안 나간다
  await run(['migrate-legacy', '--db', path.join(s.dir, 'missing.sqlite'), '--owner-email', OWNER_EMAIL], s.io);
  const all = s.out() + s.err();
  for (const v of [keys.NARA_API_KEY, keys.LLM_API_KEY, keys.SUPPORT_API_KEY, s.mock.serviceKey, s.mock.anonKey, s.mock.jwtSecret]) {
    assert.ok(!all.includes(v), 'output must not contain a secret value');
  }
  assert.match(all, /NARA_API_KEY/);
  assert.equal(s.mock.state.workspace_keys.length, 4);
});

test('platform-admin: list', async () => {
  const s = await setup();
  assert.equal(await run(['migrate-legacy', '--db', s.db, '--owner-email', OWNER_EMAIL, '--no-keys'], s.io), 0, s.err());
  const ws = s.mock.state.workspaces[0];
  // 초대 하나를 수락한 것으로 만든다 → 구성원 2명
  const staff = s.mock.addUser({ email: 'staff@example.com', password: 'password-123' });
  s.mock.state.memberships.push({ workspace_id: ws.id, user_id: staff.id, role: 'staff', member_id: 1, member_name: '직원하나' });
  const before = s.out().length;
  assert.equal(await run(['list'], s.io), 0, s.err());
  const text = s.out().slice(before);
  assert.match(text, new RegExp(`${ws.id}\\s+테스트건설\\s+구성원 2명`));
  const listCalls = s.mock.calls.filter((c) => c.path === '/rest/v1/rpc/list_workspaces_all');
  assert.ok(listCalls.length >= 1);
  assert.ok(listCalls.every((c) => c.auth === 'service'));
});

test('platform-admin: invite-links', async () => {
  const s = await setup();
  assert.equal(await run(['migrate-legacy', '--db', s.db, '--owner-email', OWNER_EMAIL, '--no-keys'], s.io), 0, s.err());
  const ws = s.mock.state.workspaces[0];
  const first = joinLinks(s.out());
  assert.equal(first.length, 2);
  // 직원하나는 이미 수락
  const accepted = s.mock.state.invites.find((i) => i.member_name === '직원하나');
  accepted.used_at = '2026-10-30T01:00:00Z';

  const before = s.out().length;
  assert.equal(await run(['invite-links', ws.id], s.io), 0, s.err());
  const again = joinLinks(s.out().slice(before));
  assert.deepEqual(again.map((l) => l.name), ['직원둘']);
  const oldTok = first.find((l) => l.name === '직원둘').token;
  assert.notEqual(again[0].token, oldTok);
  // 옛 초대는 사라지고 새 초대만 남는다. 수락된 초대는 그대로
  assert.ok(!s.mock.state.invites.some((i) => i.token_hash === hashInvite(oldTok)));
  assert.ok(s.mock.state.invites.some((i) => i.token_hash === hashInvite(again[0].token) && i.member_id === 3 && !i.used_at));
  assert.ok(s.mock.state.invites.includes(accepted));
  // 업무 DB 에는 쓰지 않는다
  assert.ok(!existsSync(path.join(s.env.APP_WS_DIR, `${ws.id}.sqlite`)));

  // 없는 회사
  assert.equal(await run(['invite-links', randomUUID()], s.io), 1);
});
