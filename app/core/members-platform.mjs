// 가입 모드 MembersStore: 역할의 단일 출처는 Supabase memberships(가입한 사람) ∪ 쓰지 않은 invites(초대 대기)
// 업무 DB 의 members 표에는 쓰지 않는다. 읽기는 app_worker 연결(RLS), 쓰기는 플랫폼 RPC 가 한다.
import { randomBytes } from 'node:crypto';
import { hashInvite, MSG, MAX_MEMBERS } from './auth.mjs';
import { getRequestContext } from './tenant.mjs';

const LIST_SQL = `SELECT member_id, member_name, role, false AS pending FROM memberships WHERE workspace_id = $1
UNION ALL
SELECT member_id, member_name, role, true AS pending FROM invites
 WHERE workspace_id = $1 AND used_at IS NULL AND expires_at > now()
   AND member_id NOT IN (SELECT member_id FROM memberships WHERE workspace_id = $1)
ORDER BY member_id`;

const NEXT_ID_SQL = `SELECT GREATEST(
  (SELECT COALESCE(MAX(member_id), 0) FROM memberships WHERE workspace_id = $1),
  (SELECT COALESCE(MAX(member_id), 0) FROM invites WHERE workspace_id = $1)
) + 1 AS next`;

function toMember(row) {
  const m = { id: Number(row.member_id), name: row.member_name, role: row.role };
  if (row.pending === true) m.pending = true;
  return m;
}

/**
 * @param {{ db: object, workspaceId: string, platform: object, onInvite(i: { memberId: number, name: string, role: string, tokenHash: string }): unknown, limits?: { check(kind: string, n: number): Promise<{ ok: boolean, message?: string }> } }} opts
 * @returns {{ list(): Promise<object[]>, get(id: number): Promise<object|null>, count(): Promise<number>, create(m: { name: string, role?: string }): Promise<{ member: object, inviteToken: string }>, remove(id: number): Promise<boolean> }}
 */
export function createPlatformMembers({ db, workspaceId, platform, onInvite, limits }) {
  const ws = String(workspaceId);
  const list = async () => (await db.all(LIST_SQL, [ws])).map(toMember);

  return {
    list,
    async get(id) {
      const n = Number(id);
      if (!Number.isInteger(n)) return null;
      return (await list()).find((m) => m.id === n) ?? null;
    },
    async count() {
      return (await list()).length;
    },
    async create({ name, role = 'staff' }) {
      const clean = String(name ?? '').trim();
      if (!clean) throw Object.assign(new Error('이름을 적지 않았습니다. 이름을 적은 뒤 다시 눌러 주세요.'), { code: 'MEMBER_NAME' });
      if (role !== 'owner' && role !== 'staff') throw Object.assign(new Error(`bad role: ${role}`), { code: 'MEMBER_ROLE' });
      const count = await this.count();
      if (limits) {
        const lim = await limits.check('members', count + 1);
        if (!lim.ok) throw Object.assign(new Error(lim.message), { code: 'PLAN_LIMIT' });
      } else if (count >= MAX_MEMBERS) {
        throw Object.assign(new Error(MSG.memberLimit), { code: 'MEMBER_LIMIT' });
      }
      const memberId = Number((await db.get(NEXT_ID_SQL, [ws])).next);
      const inviteToken = randomBytes(24).toString('base64url');
      try {
        await onInvite({ memberId, name: clean, role, tokenHash: hashInvite(inviteToken) });
      } catch (err) {
        throw Object.assign(new Error('초대를 등록하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'), { code: 'INVITE_REGISTER', cause: err });
      }
      return { member: { id: memberId, name: clean, role, pending: true }, inviteToken };
    },
    /** 플랫폼 remove_member RPC: 멤버십·대기 초대 삭제, 맡은 업무 해제. 로그인한 대표의 클라이언트로 부른다 */
    async remove(id) {
      const n = Number(id);
      if (!Number.isInteger(n)) return false;
      const rc = getRequestContext();
      if (!rc || rc.workspaceId !== ws) {
        throw Object.assign(new Error('remove needs a signed-in request'), { code: 'NO_REQUEST_CONTEXT' });
      }
      await platform.removeMember(rc.client, ws, n);
      return true;
    },
  };
}
