// Smoke test for supabase/migrations/20261030000000_platform.sql and 20261103000001_saas_platform.sql against a running local Supabase stack.
// Not part of `npm test` (no .test.mjs suffix). Requires Docker + `supabase start`.
// Run: node tests/unit/helpers/sql-smoke.mjs   (prints SQL_SMOKE_OK on success)
// Connection values come from `supabase status -o env` in the project root
// (or in SQL_SMOKE_WORKDIR when set). Only the local API and local database are called.
// The app_worker connection reuses DB_URL with the user/password swapped (seed.sql, local only).
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function readStatus() {
  const cwd = process.env.SQL_SMOKE_WORKDIR || ROOT;
  const out = execFileSync('supabase', ['status', '-o', 'env'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const env = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
    if (m) env[m[1]] = m[2];
  }
  if (!env.API_URL || !env.ANON_KEY || !env.SERVICE_ROLE_KEY || !env.DB_URL) throw new Error('supabase status did not return API_URL/ANON_KEY/SERVICE_ROLE_KEY/DB_URL');
  const worker = new URL(env.DB_URL);
  worker.username = 'app_worker';
  worker.password = 'app_worker';
  return { url: env.API_URL, anonKey: env.ANON_KEY, serviceKey: env.SERVICE_ROLE_KEY, dbUrl: env.DB_URL, workerUrl: worker.toString() };
}

// Same rule the server uses: length >= 8 -> first 3 + '…' + last 2, else '••••'.
function mask(value) {
  return value.length >= 8 ? `${value.slice(0, 3)}…${value.slice(-2)}` : '••••';
}

function check(cond, label) {
  if (!cond) throw new Error(`FAIL: ${label}`);
  console.log(`ok - ${label}`);
}

const { url, anonKey, serviceKey, dbUrl, workerUrl } = readStatus();

async function call(method, pathname, { key = anonKey, token, body } = {}) {
  const res = await fetch(`${url}${pathname}`, {
    method,
    headers: {
      apikey: key,
      authorization: `Bearer ${token || key}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

const rpc = (fn, body, opts) => call('POST', `/rest/v1/rpc/${fn}`, { ...opts, body });
const asService = { key: serviceKey };

async function createUser(tag) {
  const email = `sql-smoke-${Date.now()}-${tag}@example.test`;
  const pass = `Smoke-${randomUUID()}`;
  const made = await call('POST', '/auth/v1/admin/users', { key: serviceKey, body: { email, password: pass, email_confirm: true } });
  if (!made.ok) throw new Error(`admin create user ${tag} failed: ${made.status}`);
  const tok = await call('POST', '/auth/v1/token?grant_type=password', { body: { email, password: pass } });
  if (!tok.ok || !tok.data?.access_token) throw new Error(`login ${tag} failed: ${tok.status}`);
  return { id: made.data.id, token: tok.data.access_token };
}

const created = [];
try {
  const a = await createUser('a');
  created.push(a);
  const b = await createUser('b');
  created.push(b);
  const asA = { token: a.token };
  const asB = { token: b.token };

  const ws = await rpc('create_workspace', { p_name: '스모크 회사', p_member_name: '대표', p_max: 1000 }, asA);
  check(ws.ok && typeof ws.data === 'string', 'create_workspace returns uuid');
  const wsId = ws.data;

  const v1 = `smoke-${randomUUID()}`;
  const set1 = await rpc('set_workspace_key', { p_ws: wsId, p_name: 'NARA_API_KEY', p_value: v1, p_masked: mask(v1) }, asA);
  check(set1.ok, 'owner set_workspace_key');
  const got1 = await rpc('get_workspace_key', { p_ws: wsId, p_name: 'NARA_API_KEY' }, asService);
  check(got1.ok && got1.data === v1, 'service get_workspace_key round trip');

  const v2 = `smoke-${randomUUID()}`;
  const set2 = await rpc('set_workspace_key', { p_ws: wsId, p_name: 'NARA_API_KEY', p_value: v2, p_masked: mask(v2) }, asA);
  const got2 = await rpc('get_workspace_key', { p_ws: wsId, p_name: 'NARA_API_KEY' }, asService);
  check(set2.ok && got2.data === v2, 'set_workspace_key update replaces vault value');

  const short = await rpc('set_workspace_key', { p_ws: wsId, p_name: 'LLM_MODEL', p_value: 'abc', p_masked: mask('abc') }, asA);
  check(short.ok, 'owner set short key');

  const rows = await call('GET', `/rest/v1/workspace_keys?select=name,masked&order=name`, asA);
  check(rows.ok && rows.data.length === 2, 'owner sees own key rows');
  check(rows.data.find((r) => r.name === 'NARA_API_KEY')?.masked === mask(v2), 'masked value matches rule (long)');
  check(rows.data.find((r) => r.name === 'LLM_MODEL')?.masked === '••••', 'masked value matches rule (short)');
  check(!JSON.stringify(rows.data).includes(v2), 'key value not exposed in rows');

  const secretCol = await call('GET', '/rest/v1/workspace_keys?select=secret_id', asA);
  check(!secretCol.ok, 'authenticated cannot select secret_id');

  const bWs = await call('GET', `/rest/v1/workspaces?id=eq.${wsId}`, asB);
  check(bWs.ok && bWs.data.length === 0, 'user B sees 0 rows of A workspaces');
  const bKeys = await call('GET', '/rest/v1/workspace_keys?select=name,masked', asB);
  check(bKeys.ok && bKeys.data.length === 0, 'user B sees 0 rows of A workspace_keys');
  const bMembers = await call('GET', `/rest/v1/memberships?workspace_id=eq.${wsId}`, asB);
  check(bMembers.ok && bMembers.data.length === 0, 'user B sees 0 rows of A memberships');
  const bSet = await rpc('set_workspace_key', { p_ws: wsId, p_name: 'NARA_API_KEY', p_value: 'x', p_masked: '••••' }, asB);
  check(!bSet.ok, 'user B cannot set A key');

  const aGet = await rpc('get_workspace_key', { p_ws: wsId, p_name: 'NARA_API_KEY' }, asA);
  check(!aGet.ok && aGet.data !== v2, 'authenticated get_workspace_key rejected');
  const aList = await rpc('list_workspaces_all', {}, asA);
  check(!aList.ok, 'authenticated list_workspaces_all rejected');
  const anonCreate = await rpc('create_workspace', { p_name: 'x', p_member_name: 'x', p_max: 1000 });
  check(!anonCreate.ok, 'anon create_workspace rejected');
  const directInsert = await call('POST', '/rest/v1/workspaces', { ...asA, body: { name: 'direct', created_by: a.id } });
  check(!directInsert.ok, 'authenticated direct insert into workspaces rejected');

  const limit = await rpc('create_workspace', { p_name: 'limit', p_member_name: '대표', p_max: 0 }, asA);
  check(!limit.ok && JSON.stringify(limit.data).includes('WORKSPACE_LIMIT'), 'create_workspace raises WORKSPACE_LIMIT');

  const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
  const inv = await rpc('register_invite', { p_ws: wsId, p_token_hash: tokenHash, p_member_id: 2, p_member_name: '직원', p_role: 'staff' }, asA);
  check(inv.ok, 'owner register_invite');
  const bInv = await rpc('register_invite', { p_ws: wsId, p_token_hash: `${tokenHash}x`, p_member_id: 3, p_member_name: 'x', p_role: 'staff' }, asB);
  check(!bInv.ok, 'non-owner register_invite rejected');
  const acc = await rpc('accept_invite', { p_token_hash: tokenHash }, asB);
  const accRow = Array.isArray(acc.data) ? acc.data[0] : null;
  check(acc.ok && accRow?.workspace_id === wsId && accRow.member_id === 2 && accRow.role === 'staff', 'accept_invite adds staff membership');
  const again = await rpc('accept_invite', { p_token_hash: tokenHash }, asB);
  check(!again.ok && JSON.stringify(again.data).includes('INVITE_INVALID'), 'used invite raises INVITE_INVALID');
  const bKeys2 = await call('GET', '/rest/v1/workspace_keys?select=name,masked', asB);
  check(bKeys2.ok && bKeys2.data.length === 2, 'staff sees masked key rows after joining');
  const bInvites = await call('GET', '/rest/v1/invites', asB);
  check(bInvites.ok && bInvites.data.length === 0, 'staff cannot see invites');
  const bStaffSet = await rpc('set_workspace_key', { p_ws: wsId, p_name: 'NARA_API_KEY', p_value: 'x', p_masked: '••••' }, asB);
  check(!bStaffSet.ok, 'staff cannot set key');

  const del = await rpc('delete_workspace_key', { p_ws: wsId, p_name: 'LLM_MODEL' }, asA);
  const gotDel = await rpc('get_workspace_key', { p_ws: wsId, p_name: 'LLM_MODEL' }, asService);
  check(del.ok && gotDel.ok && gotDel.data === null, 'delete_workspace_key removes key');

  const listed = await rpc('list_workspaces_all', {}, asService);
  check(listed.ok && listed.data.some((w) => w.id === wsId), 'service list_workspaces_all includes workspace');

  // --- 20261103000001_saas_platform.sql ---
  const selfRemove = await rpc('remove_member', { p_ws: wsId, p_member_id: 1 }, asA);
  check(!selfRemove.ok && JSON.stringify(selfRemove.data).includes('CANNOT_REMOVE_SELF'), 'remove_member self -> CANNOT_REMOVE_SELF');
  const staffRemove = await rpc('remove_member', { p_ws: wsId, p_member_id: 1 }, asB);
  check(!staffRemove.ok && JSON.stringify(staffRemove.data).includes('FORBIDDEN'), 'remove_member by staff -> FORBIDDEN');

  const wsB = await rpc('create_workspace', { p_name: '스모크 회사 B', p_member_name: '대표B', p_max: 1000 }, asB);
  check(wsB.ok && typeof wsB.data === 'string', 'second workspace created');
  const wsBId = wsB.data;

  const worker = new pg.Client({ connectionString: workerUrl });
  await worker.connect();
  try {
    const inWs = async (id, fn) => {
      await worker.query('begin');
      try {
        await worker.query("select set_config('app.workspace_id', $1, true)", [id]);
        return await fn();
      } finally {
        await worker.query('commit');
      }
    };
    await inWs(wsId, () => worker.query(
      "insert into bids (bid_id, source_id, title, raw, first_seen) values ('SMOKE-1', 'nara', '스모크 공고', '{}', '2026-11-03')"));
    await inWs(wsId, () => worker.query(
      "insert into assign_items (bid_id, assignee_id, status, updated_at) values ('SMOKE-1', 2, 'review', '2026-11-03')"));
    const aRows = await inWs(wsId, () => worker.query('select bid_id from bids'));
    const bRows = await inWs(wsBId, () => worker.query('select bid_id from bids'));
    check(aRows.rowCount === 1 && bRows.rowCount === 0, 'rls two workspaces');
    // Without app.workspace_id the policy sees no rows (unset) or rejects the cast (reset to '').
    const noWs = await worker.query('select bid_id from bids').then((r) => r.rowCount, () => 0);
    check(noWs === 0, 'app_worker without workspace sees no rows');
    let crossBlocked = false;
    try {
      await inWs(wsBId, () => worker.query(
        `insert into bids (workspace_id, bid_id, source_id, title, raw, first_seen) values ('${wsId}', 'SMOKE-X', 'nara', 'x', '{}', '2026-11-03')`));
    } catch { crossBlocked = true; }
    check(crossBlocked, 'app_worker cannot write another workspace (with check)');
    const memRows = await inWs(wsBId, () => worker.query('select member_id from memberships'));
    check(memRows.rowCount === 1, 'app_worker sees only current workspace memberships');
    const q = await worker.query("select pgmq.send('jobs', '{\"v\":1,\"smoke\":true}'::jsonb, 0) as id");
    const msgId = q.rows[0].id;
    const read = await worker.query("select msg_id from pgmq.read('jobs', 30, 10, '{}'::jsonb)");
    const del = await worker.query('select pgmq.delete($1::text, $2::bigint) as ok', ['jobs', msgId]);
    check(read.rows.some((r) => String(r.msg_id) === String(msgId)) && del.rows[0].ok === true, 'app_worker pgmq send/read/delete');
    const rl = await worker.query("insert into rate_limits (key, hits, reset_at) values ('smoke', 1, now()) on conflict (key) do update set hits = rate_limits.hits + 1 returning hits");
    await worker.query("delete from rate_limits where key = 'smoke'");
    check(rl.rowCount === 1, 'app_worker uses rate_limits');

    const removeStaff = await rpc('remove_member', { p_ws: wsId, p_member_id: 2 }, asA);
    check(removeStaff.ok, 'owner remove_member staff');
    const assigned = await inWs(wsId, () => worker.query("select assignee_id from assign_items where bid_id = 'SMOKE-1'"));
    check(assigned.rows[0]?.assignee_id === null, 'remove_member releases assignments');
    const bMemberships = await call('GET', `/rest/v1/memberships?workspace_id=eq.${wsId}`, asB);
    check(bMemberships.ok && bMemberships.data.length === 0, 'removed member loses access');
  } finally {
    await worker.end();
  }

  const delB = await rpc('delete_my_account', {}, asB);
  check(delB.ok, 'staff delete_my_account');
  const delA = await rpc('delete_my_account', {}, asA);
  check(delA.ok, 'owner delete_my_account');
  created.length = 0;
  const listed2 = await rpc('list_workspaces_all', {}, asService);
  check(listed2.ok && !listed2.data.some((w) => w.id === wsId), 'owner account deletion removes workspace');
  const gotGone = await rpc('get_workspace_key', { p_ws: wsId, p_name: 'NARA_API_KEY' }, asService);
  check(gotGone.ok && gotGone.data === null, 'workspace keys gone after account deletion');
  const admin = new pg.Client({ connectionString: dbUrl });
  await admin.connect();
  try {
    const left = await admin.query('select (select count(*) from public.bids where workspace_id = $1)::int + (select count(*) from public.assign_items where workspace_id = $1)::int as n', [wsId]);
    check(left.rows[0].n === 0, 'business rows cascade with workspace deletion');
  } finally {
    await admin.end();
  }

  console.log('SQL_SMOKE_OK');
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  for (const u of created) {
    await call('DELETE', `/auth/v1/admin/users/${u.id}`, { key: serviceKey }).catch(() => {});
  }
}
