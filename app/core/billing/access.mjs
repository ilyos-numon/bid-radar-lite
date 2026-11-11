// 구독 상태 → 접근 허용 판정. 잠긴 회사도 열어 두는 경로 목록
export const LOCKED_ALLOW = ['/billing', '/api/billing', '/account', '/logout', '/me', '/workspaces', '/terms', '/privacy', '/consent', '/unsubscribe', '/healthz', '/readyz'];

const ACTIVE = new Set(['trialing', 'active', 'past_due']);
const DAY_MS = 86400000;

/**
 * @param {object|null} sub Subscription (store.mjs) — 없으면 아직 ensure 전이라 활성
 * @param {Date} [now]
 * @returns {{ active: boolean, reason: null|'trial_expired'|'past_due_expired'|'canceled', plan: string, trialDaysLeft: number|null }}
 */
export function accessOf(sub, now = new Date()) {
  if (!sub) return { active: true, reason: null, plan: 'trial', trialDaysLeft: null };
  const active = ACTIVE.has(sub.status);
  let reason = null;
  if (sub.status === 'canceled') reason = 'canceled';
  else if (sub.status === 'expired') reason = sub.retryCount > 0 ? 'past_due_expired' : 'trial_expired';
  let trialDaysLeft = null;
  if (sub.status === 'trialing' && sub.trialEndsAt) {
    trialDaysLeft = Math.max(0, Math.ceil((new Date(sub.trialEndsAt).getTime() - new Date(now).getTime()) / DAY_MS));
  }
  return { active, reason, plan: sub.plan, trialDaysLeft };
}

/** LOCKED_ALLOW 중 하나와 같거나 그 아래 경로 */
export function isAllowedWhenLocked(pathname) {
  const p = String(pathname || '');
  return LOCKED_ALLOW.some((a) => p === a || p.startsWith(`${a}/`));
}
