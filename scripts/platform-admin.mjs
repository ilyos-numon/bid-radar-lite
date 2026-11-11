// 운영 명령: 기존 단일 회사 DB 를 첫 회사(워크스페이스)로 등록하기, 회사 목록, 초대 링크 다시 발급.
// 업무 데이터 복사는 하지 않는다(기존 DB 는 읽기만). 복사 명령(node scripts/migrate-sqlite.mjs …)을 출력한다.
// 사용: npm run admin -- migrate-legacy --db <path> --owner-email <email> [--name <회사>] [--no-keys]
//       npm run admin -- list
//       npm run admin -- invite-links <workspaceId>
// 출력에는 인증키·서비스 키 값을 절대 쓰지 않는다(이름·개수만). 종료 코드: 0 성공, 1 실패, 2 대표 계정 없음.
import nodeFs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createClient } from '@supabase/supabase-js';
import { createPlatform } from '../app/core/supabase.mjs';
import { hashInvite } from '../app/core/auth.mjs';
import { KEY_NAMES } from '../app/core/keys.mjs';

const USAGE = [
  '사용법:',
  '  migrate-legacy --db <path> --owner-email <email> [--name <회사>] [--no-keys]',
  '  list',
  '  invite-links <workspaceId>',
  '',
].join('\n');

const NO_OWNER = '먼저 가입과 메일 인증을 마쳐 주세요';
// 출력에서 가릴 값의 이름 (주소·모델 이름은 비밀이 아니다)
const SECRET_ENV = ['NARA_API_KEY', 'LLM_API_KEY', 'SUPPORT_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_JWT_SECRET', 'APP_SECRET', 'APP_JOB_TOKEN'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class AdminError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function present(v) {
  return typeof v === 'string' && v.trim() !== '';
}

function newInviteToken() {
  return randomBytes(24).toString('base64url');
}

/** 모든 출력을 지나가게 해서 비밀 값이 섞여 들어가도 가린다 */
function redactingWriter(stream, env) {
  const secrets = SECRET_ENV.map((n) => env?.[n]).filter((v) => typeof v === 'string' && v.length >= 6);
  return (text) => {
    let s = String(text);
    for (const v of secrets) s = s.split(v).join('***');
    stream.write(s.endsWith('\n') ? s : `${s}\n`);
  };
}

function wsDirOf(env) {
  return path.resolve(String(env.APP_WS_DIR || 'data/ws'));
}

function baseUrlOf(env) {
  const base = String(env.APP_BASE_URL ?? '').trim().replace(/\/+$/, '');
  return base || `http://localhost:${env.APP_PORT || 8820}`;
}

function errorCode(e) {
  return e?.code ?? e?.error_code ?? 'UNKNOWN';
}

// --- 플랫폼 접근 -------------------------------------------------------------

/** 이메일로 인증을 마친 사용자를 찾는다 (서비스 롤 관리 API) */
async function findConfirmedUser(service, email) {
  const want = String(email).trim().toLowerCase();
  const perPage = 1000;
  for (let page = 1; page <= 100; page++) {
    const { data, error } = await service.auth.admin.listUsers({ page, perPage });
    if (error) throw new AdminError(`계정 목록을 읽지 못했습니다 (${errorCode(error)})`);
    const users = data?.users ?? [];
    const hit = users.find((u) => String(u.email ?? '').toLowerCase() === want);
    if (hit) return hit.email_confirmed_at || hit.confirmed_at ? hit : null;
    if (users.length < perPage) break;
  }
  return null;
}

/**
 * 대표 계정으로 로그인한 일회용 클라이언트. 초대 등록·인증키 저장은 데이터베이스 함수가
 * 호출자가 대표인지 확인하므로 대표 세션으로 해야 한다. 관리 API 로 일회용 로그인 링크를 만들고
 * (메일은 보내지 않는다) 바로 교환한다. 끝나면 close() 로 그 세션만 끝낸다.
 */
async function ownerSession({ env, service, fetchImpl, email }) {
  const { data, error } = await service.auth.admin.generateLink({ type: 'magiclink', email });
  const hashed = data?.properties?.hashed_token;
  if (error || !hashed) throw new AdminError(`대표 계정으로 접속하지 못했습니다 (${errorCode(error)})`);
  const client = createClient(String(env.SUPABASE_URL).replace(/\/+$/, ''), String(env.SUPABASE_ANON_KEY ?? ''), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (...args) => fetchImpl(...args) },
  });
  const verified = await client.auth.verifyOtp({ type: 'magiclink', token_hash: hashed });
  if (verified.error || !verified.data?.session) {
    throw new AdminError(`대표 계정으로 접속하지 못했습니다 (${errorCode(verified.error)})`);
  }
  return {
    client,
    async close() {
      try {
        await client.auth.signOut({ scope: 'local' });
      } catch {
        // 세션은 만료되면 사라진다
      }
    },
  };
}

/** 서비스 롤로 회사와 대표 멤버십을 만든다 (member_id 를 레거시 대표 행 번호로 맞추기 위해 함수 대신 직접 넣는다) */
async function insertWorkspace(service, { name, ownerId, memberId, memberName }) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const ws = await service.from('workspaces').insert({ id, name, created_by: ownerId, created_at: now });
  if (ws.error) throw new AdminError(`회사를 만들지 못했습니다 (${errorCode(ws.error)})`);
  const m = await service
    .from('memberships')
    .insert({ workspace_id: id, user_id: ownerId, role: 'owner', member_id: memberId, member_name: memberName, created_at: now });
  if (m.error) {
    await service.from('workspaces').delete().eq('id', id);
    throw new AdminError(`회사 대표를 등록하지 못했습니다 (${errorCode(m.error)})`);
  }
  await service.from('audit_log').insert({ user_id: ownerId, workspace_id: id, event: 'workspace.migrate', detail: { member_id: memberId } });
  return id;
}

/** 업무 데이터를 워크스페이스로 옮기는 명령 (scripts/migrate-sqlite.mjs). 공유 Postgres 면 주소 값 대신 변수 이름을 쓴다 */
function migrateCommand(dbPath, workspaceId, env) {
  const q = (v) => JSON.stringify(String(v));
  const to = present(env.APP_DB_URL) ? '--to-url "$APP_DB_URL"' : `--to-dir ${q(path.join(wsDirOf(env), workspaceId))}`;
  return `node scripts/migrate-sqlite.mjs --from ${q(dbPath)} --workspace ${workspaceId} ${to}`;
}

/** 새 초대 토큰: 플랫폼 초대 등록. 링크를 돌려준다 (업무 DB 에는 쓰지 않는다) */
async function issueInvite({ platform, ownerClient, workspaceId, member, baseUrl }) {
  const token = newInviteToken();
  const tokenHash = hashInvite(token);
  await platform.registerInvite(ownerClient, {
    workspaceId,
    memberId: Number(member.id),
    memberName: String(member.name),
    role: member.role === 'owner' ? 'owner' : 'staff',
    tokenHash,
  });
  return `${baseUrl}/join/${token}`;
}

// --- 명령 -------------------------------------------------------------------

async function migrateLegacy(args, { env, platform, fetchImpl, fs, out }) {
  const { values } = parseArgs({
    args,
    options: {
      db: { type: 'string' },
      'owner-email': { type: 'string' },
      name: { type: 'string' },
      'no-keys': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (!present(values.db) || !present(values['owner-email'])) throw new AdminError(USAGE);
  const dbPath = path.resolve(values.db);
  if (!fs.existsSync(dbPath)) throw new AdminError('옮길 DB 파일이 없습니다');

  const service = platform.serviceClient;
  const email = values['owner-email'].trim();
  const owner = await findConfirmedUser(service, email);
  if (!owner) throw new AdminError(NO_OWNER, 2);

  // 레거시 DB 읽기
  const src = new DatabaseSync(dbPath, { readOnly: true });
  let members;
  let company;
  try {
    members = src.prepare('SELECT id, name, role FROM members ORDER BY id').all();
    company = src.prepare("SELECT value FROM settings WHERE key = 'company_name'").get()?.value ?? '';
  } catch {
    src.close();
    throw new AdminError('입찰 레이더 DB 가 아닙니다');
  }
  const ownerRow = members.find((m) => m.role === 'owner');
  if (!ownerRow) {
    src.close();
    throw new AdminError('DB 에 대표가 없습니다');
  }
  src.close();
  const name = String(present(values.name) ? values.name : company).trim();
  if (name.length < 1 || name.length > 60) throw new AdminError('회사 이름이 비었거나 60자를 넘습니다. --name 으로 알려 주세요');
  const max = Number(env.APP_MAX_WORKSPACES) > 0 ? Number(env.APP_MAX_WORKSPACES) : 50;
  const existing = await platform.listWorkspaces();
  if (existing.length >= max) throw new AdminError('회사 수 상한에 도달했습니다 (APP_MAX_WORKSPACES)');

  // 회사 만들기 (업무 데이터는 옮기지 않는다: 아래 명령으로 옮긴다)
  const workspaceId = await insertWorkspace(service, {
    name,
    ownerId: owner.id,
    memberId: Number(ownerRow.id),
    memberName: String(ownerRow.name),
  });
  out(`회사를 만들었습니다: ${name} (${workspaceId})`);
  out('업무 데이터는 아직 옮기지 않았습니다. 앱을 열기 전에 다음 명령으로 옮겨 주세요 (원본은 그대로 둡니다):');
  out(`  ${migrateCommand(dbPath, workspaceId, env)}`);

  const session = await ownerSession({ env, service, fetchImpl, email: owner.email });
  try {
    // 구성원 초대
    const invited = [];
    const baseUrl = baseUrlOf(env);
    for (const m of members.filter((x) => x.id !== ownerRow.id)) {
      const link = await issueInvite({ platform, ownerClient: session.client, workspaceId, member: m, baseUrl });
      invited.push({ name: m.name, link });
    }
    if (invited.length) {
      out('구성원 초대 링크 (각자에게 전해 주세요. 가입·로그인 후 열면 들어옵니다):');
      for (const i of invited) out(`  ${i.name}: ${i.link}`);
    }

    // 인증키 옮기기
    const moved = [];
    if (!values['no-keys']) {
      const store = platform.keys(workspaceId);
      for (const keyName of KEY_NAMES) {
        if (!present(env[keyName])) continue;
        await store.set(keyName, env[keyName], { byUserId: owner.id, client: session.client });
        moved.push(keyName);
      }
    }

    out('요약:');
    out(`  회사 ${workspaceId} · 대표 ${ownerRow.name} · 초대 ${invited.length}건`);
    if (values['no-keys']) out('  인증키는 옮기지 않았습니다 (--no-keys)');
    else if (moved.length) out(`  인증키 ${moved.length}개를 옮겼습니다: ${moved.join(', ')}`);
    else out('  옮길 인증키가 없습니다');
  } finally {
    await session.close();
  }
  return 0;
}

async function list(args, { platform, out }) {
  if (args.length) throw new AdminError(USAGE);
  const workspaces = await platform.listWorkspaces();
  const { data, error } = await platform.serviceClient.from('memberships').select('workspace_id');
  if (error) throw new AdminError(`구성원 수를 읽지 못했습니다 (${errorCode(error)})`);
  const counts = new Map();
  for (const r of data ?? []) counts.set(r.workspace_id, (counts.get(r.workspace_id) ?? 0) + 1);
  if (!workspaces.length) {
    out('회사가 없습니다');
    return 0;
  }
  for (const w of workspaces) out(`${w.id}\t${w.name}\t구성원 ${counts.get(w.id) ?? 0}명`);
  return 0;
}

async function inviteLinks(args, { env, platform, fetchImpl, out }) {
  const [workspaceId, ...rest] = args;
  if (!workspaceId || rest.length) throw new AdminError(USAGE);
  if (!UUID_RE.test(workspaceId)) throw new AdminError('회사 id 형식이 아닙니다');
  const service = platform.serviceClient;

  const { data: owners, error: oErr } = await service
    .from('memberships')
    .select('user_id,role')
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner');
  if (oErr) throw new AdminError(`회사를 읽지 못했습니다 (${errorCode(oErr)})`);
  const ownerId = (owners ?? []).find((r) => r.role === 'owner')?.user_id;
  if (!ownerId) throw new AdminError('그런 회사가 없습니다');

  const { data: invites, error: iErr } = await service
    .from('invites')
    .select('id,member_id,member_name,role,used_at')
    .eq('workspace_id', workspaceId)
    .is('used_at', null);
  if (iErr) throw new AdminError(`초대를 읽지 못했습니다 (${errorCode(iErr)})`);
  const pending = (invites ?? []).filter((i) => !i.used_at);
  if (!pending.length) {
    out('다시 보낼 초대가 없습니다');
    return 0;
  }

  const { data: u, error: uErr } = await service.auth.admin.getUserById(ownerId);
  if (uErr || !u?.user?.email) throw new AdminError(`대표 계정을 찾지 못했습니다 (${errorCode(uErr)})`);
  const session = await ownerSession({ env, service, fetchImpl, email: u.user.email });
  const issued = [];
  try {
    const baseUrl = baseUrlOf(env);
    for (const inv of pending) {
      // 옛 초대를 지워 옛 링크를 못 쓰게 한 뒤 새로 등록한다
      const del = await service.from('invites').delete().eq('id', inv.id);
      if (del.error) throw new AdminError(`옛 초대를 지우지 못했습니다 (${errorCode(del.error)})`);
      const member = { id: inv.member_id, name: inv.member_name, role: inv.role };
      const link = await issueInvite({ platform, ownerClient: session.client, workspaceId, member, baseUrl });
      issued.push({ name: inv.member_name, link });
    }
  } finally {
    await session.close();
  }
  out('새 초대 링크 (옛 링크는 더 이상 쓸 수 없습니다):');
  for (const i of issued) out(`  ${i.name}: ${i.link}`);
  return 0;
}

const COMMANDS = { 'migrate-legacy': migrateLegacy, list, 'invite-links': inviteLinks };

/**
 * @param {string[]} argv 명령과 옵션 (process.argv.slice(2))
 * @param {{ env?: object, platform?: object, fetchImpl?: typeof fetch, stdout?: {write(s:string):void}, stderr?: {write(s:string):void}, fs?: typeof nodeFs }} [deps]
 * @returns {Promise<number>} 종료 코드
 */
export async function run(argv, { env = process.env, platform, fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, fs = nodeFs } = {}) {
  const out = redactingWriter(stdout, env);
  const err = redactingWriter(stderr, env);
  const [cmd, ...args] = argv ?? [];
  const handler = COMMANDS[cmd];
  if (!handler) {
    err(USAGE);
    return 1;
  }
  const p = platform ?? createPlatform({ env, fetchImpl });
  if (!p || p.enabled !== true) {
    err('SUPABASE_URL 이 비어 있습니다 (.env 확인)');
    return 1;
  }
  if (!present(env.SUPABASE_SERVICE_ROLE_KEY)) {
    err('SUPABASE_SERVICE_ROLE_KEY 가 비어 있습니다 (.env 확인)');
    return 1;
  }
  try {
    return await handler(args, { env, platform: p, fetchImpl, fs, out, err });
  } catch (e) {
    if (e instanceof AdminError) {
      err(e.message);
      return e.exitCode;
    }
    if (e?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || e?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' || e?.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
      err(USAGE);
      return 1;
    }
    err(`실패했습니다 (${errorCode(e)})`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
