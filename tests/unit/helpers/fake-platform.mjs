// 테스트용 가짜 platform (app/core/supabase.mjs 모양). 네트워크 없음, 메모리 상태만.
// 로그인 사용자: 요청 쿠키 `fake-user=<userId>`. `fake-refresh=1` 이 있으면 fromRequest 가 갱신 쿠키 1개를 돌려준다.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { hashInvite, readCookie } from '../../../app/core/auth.mjs';
import { maskValue } from '../../../app/core/keys.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// 테스트용 플랫폼 표(Supabase 의 public.memberships / public.invites 와 같은 열)
const PLATFORM_TABLES = `
CREATE TABLE IF NOT EXISTS memberships (
  workspace_id uuid NOT NULL, user_id text NOT NULL, role text NOT NULL, member_id integer NOT NULL,
  member_name text NOT NULL, created_at timestamptz DEFAULT now(), PRIMARY KEY (workspace_id, user_id));
CREATE TABLE IF NOT EXISTS invites (
  id serial PRIMARY KEY, workspace_id uuid NOT NULL, token_hash text NOT NULL, member_id integer NOT NULL,
  member_name text NOT NULL, role text NOT NULL DEFAULT 'staff', created_at timestamptz DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '14 days', used_at timestamptz, used_by text);
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, hits integer NOT NULL, reset_at timestamptz NOT NULL);
`;

/**
 * 가입 모드용 공유 Db 대역(pg 어댑터와 같은 규칙): PGlite 메모리 한 개에 코어·모듈 스키마,
 * app_worker 역할과 workspace_id RLS 를 건다. withWorkspace 밖의 query → { code: 'NO_WORKSPACE' }.
 * 연결이 하나라 쿼리마다 (워크스페이스·역할 설정 + 쿼리) 를 잠금 안에서 한 번에 돈다.
 * @returns {Promise<object>} Db (kind 'pg')
 */
export async function createTestDb() {
  const lite = await PGlite.create();
  await lite.exec(readFileSync(path.join(ROOT, 'app/core/schema.sql'), 'utf8'));
  const modules = path.join(ROOT, 'app/modules');
  for (const name of readdirSync(modules).sort()) {
    const file = path.join(modules, name, 'schema.sql');
    if (existsSync(file)) await lite.exec(readFileSync(file, 'utf8'));
  }
  await lite.exec(PLATFORM_TABLES);
  await lite.exec(readFileSync(path.join(ROOT, 'app/core/legal/schema.sql'), 'utf8'));
  const tables = (
    await lite.query(
      "SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'workspace_id' AND table_name NOT IN ('memberships', 'invites')",
    )
  ).rows.map((r) => r.t);
  const cond = "workspace_id = (current_setting('app.workspace_id', true))::uuid";
  let ddl = 'CREATE ROLE app_worker NOLOGIN NOINHERIT NOBYPASSRLS;\n';
  for (const t of tables) {
    ddl += `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY ${t}_app_worker ON ${t} FOR ALL TO app_worker USING (${cond}) WITH CHECK (${cond});
GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO app_worker;\n`;
  }
  for (const t of ['memberships', 'invites']) {
    ddl += `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
CREATE POLICY ${t}_app_worker ON ${t} FOR SELECT TO app_worker USING (${cond});
GRANT SELECT ON ${t} TO app_worker;\n`;
  }
  ddl += 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_worker;';
  await lite.exec(ddl);
  // 플랫폼 표(결제·이메일 수신거부): RLS 없이 db.admin 으로만 읽고 쓴다
  await lite.exec(readFileSync(path.join(ROOT, 'app/core/billing/schema.sql'), 'utf8'));
  await lite.exec(readFileSync(path.join(ROOT, 'app/core/email/schema.sql'), 'utf8'));

  const als = new AsyncLocalStorage();
  let lock = Promise.resolve();
  const norm = (r) => ({ rows: r.rows ?? [], rowCount: Number(r.affectedRows || (r.rows ? r.rows.length : 0)) });
  const locked = (fn) => {
    const run = lock.then(fn, fn);
    lock = run.catch(() => {});
    return run;
  };
  const as = (ws, text, params) =>
    locked(async () => {
      if (ws) await lite.query("SELECT set_config('app.workspace_id', $1, false), set_config('role', 'app_worker', false)", [ws]);
      else await lite.query("SELECT set_config('role', 'none', false), set_config('app.workspace_id', '', false)");
      return norm(await lite.query(text, params));
    });
  const query = async (text, params = []) => {
    const store = als.getStore();
    if (!store) throw Object.assign(new Error('query outside withWorkspace'), { code: 'NO_WORKSPACE' });
    return as(store.workspaceId, text, params);
  };
  return {
    kind: 'pg',
    query,
    async get(text, params) {
      return (await query(text, params)).rows[0] ?? null;
    },
    async all(text, params) {
      return (await query(text, params)).rows;
    },
    async run(text, params) {
      const r = await query(text, params);
      return { rowCount: r.rowCount, rows: r.rows };
    },
    async applySchema() {},
    async withWorkspace(workspaceId, fn) {
      const cur = als.getStore();
      if (cur && cur.workspaceId === workspaceId) return fn();
      return als.run({ workspaceId: String(workspaceId) }, fn);
    },
    admin: (text, params = []) => as(null, text, params),
    stats: () => ({ total: 1, idle: 1, waiting: 0 }),
    async close() {
      if (!lite.closed) await lite.close();
    },
  };
}

export const WS_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const WS_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * @param {{ workspaces?: Array<{id:string,name:string}>, memberships?: Array<{userId:string, workspaceId:string, role:string, memberId:number, memberName:string}>, keys?: Record<string, Record<string,string>> }} [seed]
 */
export function createFakePlatform(seed = {}) {
  const workspaces = (seed.workspaces ?? [
    { id: WS_A, name: '가나 조경' },
    { id: WS_B, name: '다라 전기' },
  ]).map((w) => ({ ...w }));
  const memberships = (seed.memberships ?? [
    { userId: 'user-a', workspaceId: WS_A, role: 'owner', memberId: 1, memberName: '김대표' },
    { userId: 'user-b', workspaceId: WS_B, role: 'owner', memberId: 1, memberName: '이대표' },
  ]).map((m) => ({ ...m }));
  const keyValues = new Map(Object.entries(seed.keys ?? {}).map(([ws, v]) => [ws, { ...v }]));
  const calls = { registerInvite: [], keysLoad: [], fromRequest: 0, listWorkspaces: 0, audit: [], removeMember: [] };
  const invites = [];
  let db = null;
  // 서비스 롤 클라이언트 대역: auth.admin(사용자 만들기·찾기·비밀번호 재설정)과 from(표).insert/upsert (workspaces·memberships 만 메모리에 비춘다)
  const serviceUsers = new Map(); // email -> { id, email, password }
  const serviceCalls = { createUser: 0, updateUserById: [], listUsers: 0, from: [] };
  const serviceClient = {
    kind: 'service',
    calls: serviceCalls,
    users: serviceUsers,
    auth: {
      admin: {
        async createUser({ email, password }) {
          serviceCalls.createUser += 1;
          const key = String(email ?? '').toLowerCase();
          if (serviceUsers.has(key)) return { data: { user: null }, error: { code: 'email_exists', message: 'exists' } };
          const user = { id: randomUUID(), email: key, password };
          serviceUsers.set(key, user);
          return { data: { user: { id: user.id, email: user.email } }, error: null };
        },
        async listUsers() {
          serviceCalls.listUsers += 1;
          return { data: { users: [...serviceUsers.values()].map((u) => ({ id: u.id, email: u.email })) }, error: null };
        },
        async updateUserById(id, attrs = {}) {
          serviceCalls.updateUserById.push({ id, hasPassword: typeof attrs.password === 'string' && attrs.password.length > 0 });
          const user = [...serviceUsers.values()].find((u) => u.id === id);
          if (!user) return { data: { user: null }, error: { code: 'user_not_found' } };
          if (typeof attrs.password === 'string') user.password = attrs.password;
          return { data: { user: { id } }, error: null };
        },
      },
    },
    from(table) {
      const write = async (input) => {
        const rows = Array.isArray(input) ? input : [input];
        serviceCalls.from.push({ table, rows: rows.length });
        if (table === 'workspaces') {
          for (const r of rows) if (!workspaces.some((w) => w.id === r.id)) workspaces.push({ id: r.id, name: r.name });
        }
        if (table === 'memberships') {
          for (const r of rows) {
            const m = { userId: r.user_id, workspaceId: r.workspace_id, role: r.role, memberId: r.member_id, memberName: r.member_name };
            const i = memberships.findIndex((x) => x.userId === m.userId && x.workspaceId === m.workspaceId);
            if (i >= 0) memberships[i] = m;
            else memberships.push(m);
          }
        }
        await sync();
        return { data: null, error: null };
      };
      return { insert: write, upsert: (rows) => write(rows) };
    },
  };

  // createTestDb() 를 붙이면 memberships·invites 를 그 Db 의 같은 이름 표에 그대로 비춘다(앱은 Db 로 읽는다)
  async function sync() {
    if (!db) return;
    await db.admin('DELETE FROM memberships');
    await db.admin('DELETE FROM invites');
    for (const m of memberships) {
      await db.admin('INSERT INTO memberships (workspace_id, user_id, role, member_id, member_name) VALUES ($1, $2, $3, $4, $5)', [
        m.workspaceId,
        m.userId,
        m.role,
        m.memberId,
        m.memberName,
      ]);
    }
    for (const i of invites) {
      await db.admin(
        'INSERT INTO invites (workspace_id, token_hash, member_id, member_name, role, used_at, used_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [i.workspaceId, i.tokenHash, i.memberId, i.memberName, i.role ?? 'staff', i.usedBy ? new Date().toISOString() : null, i.usedBy ?? null],
      );
    }
  }

  const clientFor = (userId) => ({ kind: 'user', userId });

  const auth = {
    async fromRequest(req) {
      calls.fromRequest += 1;
      const id = readCookie(req, 'fake-user');
      const user = id ? { id, email: `${id}@example.com`, emailConfirmed: true } : null;
      const setCookies = readCookie(req, 'fake-refresh') === '1' ? ['sb-fake-auth-token=refreshed; Path=/; HttpOnly; SameSite=Lax'] : [];
      return { client: user ? clientFor(user.id) : { kind: 'anon' }, user, setCookies };
    },
    async signUp() {
      return { ok: true, needsConfirm: true, userId: randomUUID(), setCookies: [] };
    },
    async signIn({ email, password }) {
      // 서비스 롤로 만든 사용자는 그 id·비밀번호로 확인한다
      const made = serviceUsers.get(String(email ?? '').toLowerCase());
      if (made) {
        if (made.password !== password) return { ok: false, error: 'BAD_CREDENTIALS', setCookies: [] };
        return { ok: true, setCookies: [`fake-user=${made.id}; Path=/`], user: { id: made.id, email: made.email, emailConfirmed: true } };
      }
      const id = String(email ?? '').split('@')[0];
      return { ok: true, setCookies: [`fake-user=${id}; Path=/`], user: { id, email, emailConfirmed: true } };
    },
    async signOut() {
      return { setCookies: ['fake-user=; Path=/; Max-Age=0'] };
    },
    async exchangeCode() {
      return { ok: false, setCookies: [] };
    },
    async resetPassword() {
      return { ok: true, setCookies: [] };
    },
    async updatePassword() {
      return { ok: true, setCookies: [] };
    },
  };

  async function memberList(userId) {
    return memberships
      .filter((m) => m.userId === userId)
      .map((m) => ({
        workspaceId: m.workspaceId,
        workspaceName: workspaces.find((w) => w.id === m.workspaceId)?.name ?? '',
        role: m.role,
        memberId: m.memberId,
        memberName: m.memberName,
      }));
  }
  memberList.invalidate = () => {};

  const stores = new Map();
  function keys(workspaceId) {
    if (stores.has(workspaceId)) return stores.get(workspaceId);
    let cache = {};
    const values = () => {
      if (!keyValues.has(workspaceId)) keyValues.set(workspaceId, {});
      return keyValues.get(workspaceId);
    };
    const store = {
      enabled: true,
      workspaceId,
      async load() {
        calls.keysLoad.push(workspaceId);
        cache = { ...values() };
      },
      get: (name) => (cache[name] === undefined ? null : cache[name]),
      async set(name, value, { client } = {}) {
        if (!client || client.kind !== 'user') throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' });
        values()[name] = String(value);
        cache = { ...values() };
      },
      async remove(name, { client } = {}) {
        if (!client || client.kind !== 'user') throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' });
        delete values()[name];
        cache = { ...values() };
      },
      async status() {
        return Object.entries(values()).map(([name, v]) => ({ name, masked: maskValue(v), updatedAt: null }));
      },
      invalidate() {
        cache = {};
      },
    };
    stores.set(workspaceId, store);
    return store;
  }

  return {
    enabled: true,
    auth,
    calls,
    invites,
    workspaces,
    membershipRows: memberships,
    async verifyAccessToken() {
      return null;
    },
    memberships: memberList,
    async createWorkspace(client, { name, memberName }) {
      const id = `cccccccc-cccc-4ccc-8ccc-${String(workspaces.length).padStart(12, '0')}`;
      workspaces.push({ id, name });
      memberships.push({ userId: client.userId, workspaceId: id, role: 'owner', memberId: 1, memberName });
      await sync();
      return { workspaceId: id };
    },
    async registerInvite(client, invite) {
      calls.registerInvite.push({ client, ...invite });
      if (!client || client.kind !== 'user') throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' });
      const owner = memberships.find((m) => m.userId === client.userId && m.workspaceId === invite.workspaceId && m.role === 'owner');
      if (!owner) throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' });
      invites.push({ ...invite });
      await sync();
      return { id: `invite-${invites.length}` };
    },
    async acceptInvite(client, { tokenHash }) {
      const inv = invites.find((i) => i.tokenHash === tokenHash && !i.usedBy);
      if (!inv) return null;
      inv.usedBy = client.userId;
      memberships.push({ userId: client.userId, workspaceId: inv.workspaceId, role: inv.role, memberId: inv.memberId, memberName: inv.memberName });
      await sync();
      return { workspaceId: inv.workspaceId, memberId: inv.memberId, role: inv.role, memberName: inv.memberName };
    },
    // remove_member RPC 와 같은 검사·효과(assign_items 해제 포함)
    async removeMember(client, workspaceId, memberId) {
      calls.removeMember.push({ client, workspaceId, memberId });
      const uid = client && client.kind === 'user' ? client.userId : null;
      if (!memberships.some((m) => m.userId === uid && m.workspaceId === workspaceId && m.role === 'owner')) {
        throw Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' });
      }
      const target = memberships.find((m) => m.workspaceId === workspaceId && m.memberId === memberId);
      if (target && target.userId === uid) throw Object.assign(new Error('self'), { code: 'CANNOT_REMOVE_SELF' });
      if (target && target.role === 'owner') throw Object.assign(new Error('owner'), { code: 'CANNOT_REMOVE_OWNER' });
      for (let i = memberships.length - 1; i >= 0; i -= 1) {
        if (memberships[i].workspaceId === workspaceId && memberships[i].memberId === memberId) memberships.splice(i, 1);
      }
      for (let i = invites.length - 1; i >= 0; i -= 1) {
        if (invites[i].workspaceId === workspaceId && invites[i].memberId === memberId && !invites[i].usedBy) invites.splice(i, 1);
      }
      if (db) {
        await db.admin('UPDATE assign_items SET assignee_id = NULL WHERE workspace_id = $1 AND assignee_id = $2', [workspaceId, memberId]);
      }
      await sync();
    },
    /** createTestDb() 결과를 붙이고 지금 상태를 비춘다 */
    async useDb(given) {
      db = given;
      await sync();
    },
    sync,
    async listWorkspaces() {
      calls.listWorkspaces += 1;
      return workspaces.map((w) => ({ id: w.id, name: w.name }));
    },
    keys,
    async deleteAccount() {
      return { ok: true };
    },
    async audit(event, detail) {
      calls.audit.push({ event, ...detail });
      return { ok: true };
    },
    hashToken: (token) => hashInvite(token),
    serviceClient,
  };
}
