// 회사별 무료 '공고 가져오기' 횟수. 유료(active·past_due) 회사와 APP_FREE_COLLECTS=0 은 무제한
export const PAID_STATUSES = ['active', 'past_due'];
export const CREDITS_TEXT = {
  left: (n) => `무료 가져오기 ${n}회 남음`,
  none: (max) => `무료 가져오기 ${max}회를 모두 썼습니다`,
  noneNext: '계속 쓰려면 요금제를 골라 주세요',
  plans: '요금제 보기',
};

const DEFAULT_FREE = 5;
const USED_SQL = 'SELECT used FROM collect_credits WHERE workspace_id = $1';
// 한도 안일 때만 +1 (원자적). 행이 안 돌아오면 이미 다 썼다
const TAKE_SQL = `INSERT INTO collect_credits (workspace_id, used, updated_at) VALUES ($1, 1, now())
  ON CONFLICT (workspace_id) DO UPDATE SET used = collect_credits.used + 1, updated_at = now()
  WHERE collect_credits.used < $2 RETURNING used`;
// 실패한 가져오기의 1회를 되돌린다 (원자적, 0 아래로 안 내려감)
const REFUND_SQL = 'UPDATE collect_credits SET used = used - 1, updated_at = now() WHERE workspace_id = $1 AND used > 0';

/** APP_FREE_COLLECTS: 비거나 잘못되면 5, 0 은 무제한 */
export function freeCollects(env) {
  const raw = String(env?.APP_FREE_COLLECTS ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_FREE;
}

/**
 * @param {{ db: { admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, workspaceId: string,
 *   store: { ensure(workspaceId: string): Promise<{ status: string }> }, env?: Record<string,string|undefined> }} deps
 */
export function createCredits({ db, workspaceId, store, env = {} } = {}) {
  if (!db || typeof db.admin !== 'function') throw new Error('db is required');
  const max = freeCollects(env);
  const isUnlimited = async () => max === 0 || PAID_STATUSES.includes((await store.ensure(workspaceId))?.status);
  const usedNow = async () => {
    const r = await db.admin(USED_SQL, [workspaceId]);
    return r.rows[0] ? Number(r.rows[0].used) : 0;
  };

  return {
    async summary() {
      const unlimited = await isUnlimited();
      const used = await usedNow();
      return { used, max, left: unlimited ? max : Math.max(0, max - used), unlimited };
    },
    async take() {
      if (await isUnlimited()) return { ok: true, used: await usedNow(), max, left: max, unlimited: true };
      const r = await db.admin(TAKE_SQL, [workspaceId, max]);
      if (!r.rows[0]) return { ok: false, used: max, max, left: 0, unlimited: false };
      const used = Number(r.rows[0].used);
      return { ok: true, used, max, left: Math.max(0, max - used), unlimited: false };
    },
    async refund() {
      if (await isUnlimited()) return;
      await db.admin(REFUND_SQL, [workspaceId]);
    },
  };
}
