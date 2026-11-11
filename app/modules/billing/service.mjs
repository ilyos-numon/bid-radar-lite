// 요금제 화면의 순수 로직과 즉시 결제. 결제 규칙 자체는 core/billing/cycle.mjs 가 정한다
import { createBillingCycle } from '../../core/billing/cycle.mjs';
import { PAID_PLANS } from '../../core/billing/plans.mjs';

const KST_MS = 9 * 3600000;

/** ISO → 'YYYY-MM-DD' (한국 시각). 없으면 '' */
export function ymd(value) {
  if (!value) return '';
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? '' : new Date(t + KST_MS).toISOString().slice(0, 10);
}

export const isPaidPlan = (plan) => PAID_PLANS.includes(plan);

/** 토스 fail 콜백 코드: 영숫자·_ 만, 64자까지 */
export function safeCode(code) {
  return String(code ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 64);
}

/** successUrl·failUrl 의 앞부분 (APP_BASE_URL 이 있으면 그것, 아니면 요청 주소) */
export function originOf(env, req) {
  const base = String(env?.APP_BASE_URL ?? '').trim();
  if (base) {
    try {
      return new URL(base).origin;
    } catch {
      // 잘못된 값이면 요청 주소로
    }
  }
  return new URL(req.url).origin;
}

/**
 * 지금 바로 결제한다 (요금제 선택·카드 등록 직후). cycle.chargeOne 이 결제 시점이 된 구독만 처리하므로
 * 시점을 지금으로 맞춘 사본을 넘긴다. 실패하면 원래 상태가 미납(past_due)이 아닐 때 상태를 되돌린다
 * (체험은 남은 기간 그대로, 잠긴 회사는 잠긴 채로). 실패 결제 기록은 남는다.
 * @returns {Promise<'paid'|'failed'|'expired'|'canceled'|'skipped'>}
 */
export async function chargeNow({ store, toss, vault, now }, sub) {
  const cycle = createBillingCycle({ store, toss, vault, now });
  const at = new Date(now()).toISOString();
  let due;
  if (sub.status === 'trialing') due = { ...sub, trialEndsAt: at };
  else if (sub.status === 'past_due') due = { ...sub, nextChargeAt: at };
  else due = { ...sub, status: 'past_due', retryCount: 0, nextChargeAt: at, currentPeriodEnd: null };
  const r = await cycle.chargeOne(due);
  if (r !== 'paid' && sub.status !== 'past_due') {
    await store.update(sub.workspaceId, { status: sub.status, retryCount: sub.retryCount ?? 0, nextChargeAt: sub.nextChargeAt ?? null });
  }
  return r;
}
