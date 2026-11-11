// 결제 주기 규칙: 체험 종료·기간 말 자동결제·실패 재시도(retryDays)·만료·기간 말 해지
import { PERIOD_DAYS, planOf } from './plans.mjs';
import { makeOrderId } from './toss.mjs';

const DAY_MS = 86400000;
const ms = (v) => (v ? new Date(v).getTime() : null);

/**
 * @param {{ store: object, toss: object, vault: { getKey(ws: string): Promise<string|null> }, now?: () => Date, retryDays?: number[], log?: (line: string) => void }} opts
 */
export function createBillingCycle({ store, toss, vault, now = () => new Date(), retryDays = [1, 3, 7], log = () => {} } = {}) {
  const days = Array.isArray(retryDays) && retryDays.length ? retryDays.map(Number) : [1, 3, 7];

  async function charge(sub, plan, t) {
    const ws = sub.workspaceId;
    const p = planOf(plan);
    const billingKey = await vault.getKey(ws);
    // 청구 대상 = 이 구독이 결제 예정이던 시점(기간 말, 없으면 체험 종료). 재시도·재실행 동안 바뀌지 않는다.
    // orderId(=Idempotency-Key) = (회사, plan, 청구 대상, 시도 번호). 시도 번호 = 이 대상에 이미 기록된 결제 수.
    // 실패가 기록된 시도는 다음 번호(새 키), 결제됐는데 기록 못 한 시도는 같은 번호(같은 키 → 토스가 같은 결과).
    const target = new Date(ms(sub.currentPeriodEnd) ?? ms(sub.trialEndsAt) ?? t.getTime());
    const recorded = new Map((await store.listPayments(ws, { limit: 100 })).map((p) => [p.orderId, p]));
    let orderId;
    for (let n = 0; ; n += 1) {
      orderId = makeOrderId(ws, plan, target, `${target.toISOString()}:${n}`);
      const prev = recorded.get(orderId);
      if (!prev) break;
      if (prev.status === 'paid') {
        // 이미 결제·기록됐는데 구독 갱신 전에 멈춘 경우: 다시 청구하지 않고 갱신만 한다
        const end = prev.periodEnd ?? new Date(Math.max(t.getTime(), target.getTime()) + PERIOD_DAYS * DAY_MS).toISOString();
        await store.update(ws, { plan, status: 'active', currentPeriodEnd: end, nextChargeAt: end, retryCount: 0 });
        return 'paid';
      }
    }
    const start = Math.max(t.getTime(), ms(sub.currentPeriodEnd) ?? 0);
    const periodStart = new Date(start).toISOString();
    const periodEnd = new Date(start + PERIOD_DAYS * DAY_MS).toISOString();
    const res = billingKey
      ? await toss.charge({ billingKey, customerKey: sub.customerKey, amount: p.price, orderId, orderName: `입찰 레이더 ${p.name}` })
      : { ok: false, code: 'NO_BILLING_KEY' };
    if (res.ok) {
      await store.insertPayment({ workspaceId: ws, orderId, plan, amount: p.price, status: 'paid', paymentKey: res.paymentKey, approvedAt: res.approvedAt ?? t.toISOString(), periodStart, periodEnd });
      await store.update(ws, { plan, status: 'active', currentPeriodEnd: periodEnd, nextChargeAt: periodEnd, retryCount: 0 });
      return 'paid';
    }
    await store.insertPayment({ workspaceId: ws, orderId, plan, amount: p.price, status: 'failed', failCode: res.code ?? 'UNKNOWN' });
    const rc = sub.retryCount ?? 0;
    const wait = days[Math.min(rc, days.length - 1)];
    await store.update(ws, { plan, status: 'past_due', retryCount: rc + 1, nextChargeAt: new Date(t.getTime() + wait * DAY_MS).toISOString() });
    log(`[billing] ${ws} charge failed: ${res.code ?? 'UNKNOWN'}`);
    return 'failed';
  }

  async function chargeOne(sub) {
    if (!sub) return 'skipped';
    const t = new Date(now());
    const at = t.getTime();
    const ws = sub.workspaceId;
    if (sub.status === 'trialing') {
      if ((ms(sub.trialEndsAt) ?? Infinity) > at) return 'skipped';
      const key = await vault.getKey(ws);
      if (!key) {
        await store.update(ws, { status: 'expired', nextChargeAt: null });
        return 'expired';
      }
      return charge(sub, sub.plan === 'trial' ? 'starter' : sub.plan, t);
    }
    if (sub.status === 'active') {
      if ((ms(sub.currentPeriodEnd) ?? Infinity) > at) return 'skipped';
      if (sub.cancelAtPeriodEnd) {
        await store.update(ws, { status: 'canceled', nextChargeAt: null });
        return 'canceled';
      }
      return charge(sub, sub.plan === 'trial' ? 'starter' : sub.plan, t);
    }
    if (sub.status === 'past_due') {
      if ((ms(sub.nextChargeAt) ?? Infinity) > at) return 'skipped';
      if ((sub.retryCount ?? 0) >= days.length) {
        await store.update(ws, { status: 'expired', nextChargeAt: null });
        return 'expired';
      }
      return charge(sub, sub.plan === 'trial' ? 'starter' : sub.plan, t);
    }
    return 'skipped';
  }

  return {
    chargeOne,
    async run({ date } = {}) {
      const t = new Date(now());
      const runDate = date || t.toISOString().slice(0, 10);
      const job = await store.beginJob(runDate);
      if (!job.started) {
        const row = job.row ?? {};
        return { charged: Number(row.charged ?? 0), failed: Number(row.failed ?? 0), expired: Number(row.expired ?? 0), skipped: true };
      }
      const counts = { charged: 0, failed: 0, expired: 0 };
      for (const sub of await store.due(t.toISOString())) {
        let r;
        try {
          r = await chargeOne(sub);
        } catch (err) {
          log(`[billing] ${sub.workspaceId} error: ${err?.code ?? err?.message ?? 'unknown'}`);
          r = 'failed';
        }
        if (r === 'paid') counts.charged += 1;
        else if (r === 'failed') counts.failed += 1;
        else if (r === 'expired') counts.expired += 1;
      }
      await store.finishJob(runDate, counts);
      return { ...counts, skipped: false };
    },
  };
}
