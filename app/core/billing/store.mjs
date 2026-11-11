// 구독·결제·웹훅 이벤트·결제 잡 저장소 (플랫폼 표). 모든 SQL 은 db.admin 이고 workspace_id 를 명시한다
import { randomUUID } from 'node:crypto';

const DAY_MS = 86400000;
const LIVE = ['trialing', 'active', 'past_due'];

// patch 키(camelCase 또는 snake_case) → 컬럼
const COLUMNS = {
  plan: 'plan',
  status: 'status',
  trialEndsAt: 'trial_ends_at',
  currentPeriodEnd: 'current_period_end',
  nextChargeAt: 'next_charge_at',
  cancelAtPeriodEnd: 'cancel_at_period_end',
  retryCount: 'retry_count',
  cardSummary: 'card_summary',
  billingSecretId: 'billing_secret_id',
};
const SNAKE = Object.fromEntries(Object.values(COLUMNS).map((c) => [c, c]));

const iso = (v) => (v === null || v === undefined ? null : new Date(v).toISOString());

function toSub(r) {
  if (!r) return null;
  return {
    workspaceId: r.workspace_id,
    plan: r.plan,
    status: r.status,
    customerKey: r.customer_key,
    trialEndsAt: iso(r.trial_ends_at),
    currentPeriodEnd: iso(r.current_period_end),
    nextChargeAt: iso(r.next_charge_at),
    cancelAtPeriodEnd: Boolean(r.cancel_at_period_end),
    retryCount: Number(r.retry_count ?? 0),
    cardSummary: r.card_summary ?? null,
    billingSecretId: r.billing_secret_id ?? null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function toPayment(r) {
  return {
    id: Number(r.id),
    workspaceId: r.workspace_id,
    orderId: r.order_id,
    paymentKey: r.payment_key ?? null,
    plan: r.plan,
    amount: Number(r.amount),
    status: r.status,
    failCode: r.fail_code ?? null,
    approvedAt: iso(r.approved_at),
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
    createdAt: iso(r.created_at),
  };
}

/**
 * @param {{ db: { admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, now?: () => Date, trialDays?: number }} opts
 */
export function createBillingStore({ db, now = () => new Date(), trialDays = 14 } = {}) {
  if (!db || typeof db.admin !== 'function') throw new Error('db is required');
  const days = Number(trialDays) > 0 ? Number(trialDays) : 14;
  const nowIso = () => new Date(now()).toISOString();

  async function get(workspaceId) {
    const r = await db.admin('SELECT * FROM subscriptions WHERE workspace_id = $1', [workspaceId]);
    return toSub(r.rows[0]);
  }

  return {
    async ensure(workspaceId) {
      const trialEnds = new Date(new Date(now()).getTime() + days * DAY_MS).toISOString();
      await db.admin(
        `INSERT INTO subscriptions (workspace_id, plan, status, customer_key, trial_ends_at, created_at, updated_at)
         VALUES ($1, 'trial', 'trialing', $2, $3, $4, $4) ON CONFLICT (workspace_id) DO NOTHING`,
        [workspaceId, randomUUID(), trialEnds, nowIso()],
      );
      return get(workspaceId);
    },
    get,
    async update(workspaceId, patch = {}) {
      const sets = [];
      const params = [workspaceId];
      for (const [k, v] of Object.entries(patch)) {
        const col = COLUMNS[k] ?? SNAKE[k];
        if (!col) continue;
        params.push(v === undefined ? null : v);
        sets.push(`${col} = $${params.length}`);
      }
      params.push(nowIso());
      sets.push(`updated_at = $${params.length}`);
      const r = await db.admin(`UPDATE subscriptions SET ${sets.join(', ')} WHERE workspace_id = $1 RETURNING *`, params);
      return toSub(r.rows[0]);
    },
    async setCard(workspaceId, { cardSummary, billingSecretId } = {}) {
      const r = await db.admin(
        'UPDATE subscriptions SET card_summary = $2, billing_secret_id = COALESCE($3, billing_secret_id), updated_at = $4 WHERE workspace_id = $1 RETURNING *',
        [workspaceId, cardSummary ?? null, billingSecretId ?? null, nowIso()],
      );
      return toSub(r.rows[0]);
    },
    async insertPayment({ workspaceId, orderId, plan, amount, status, paymentKey, failCode, approvedAt, periodStart, periodEnd }) {
      const r = await db.admin(
        `INSERT INTO payments (workspace_id, order_id, plan, amount, status, payment_key, fail_code, approved_at, period_start, period_end, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (order_id) DO NOTHING RETURNING *`,
        [workspaceId, orderId, plan, amount, status, paymentKey ?? null, failCode ?? null, approvedAt ?? null, periodStart ?? null, periodEnd ?? null, nowIso()],
      );
      if (r.rows[0]) return toPayment(r.rows[0]);
      // 같은 orderId 가 이미 있으면(재실행) 그 행을 돌려준다
      const old = await db.admin('SELECT * FROM payments WHERE order_id = $1 AND workspace_id = $2', [orderId, workspaceId]);
      return old.rows[0] ? toPayment(old.rows[0]) : null;
    },
    async listPayments(workspaceId, { limit = 12 } = {}) {
      const n = Math.max(1, Math.min(100, Number(limit) || 12));
      const r = await db.admin('SELECT * FROM payments WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [workspaceId, n]);
      return r.rows.map(toPayment);
    },
    async recordEvent({ eventKey, eventType, payload }) {
      const r = await db.admin(
        'INSERT INTO billing_events (event_key, event_type, payload) VALUES ($1, $2, $3::jsonb) ON CONFLICT (event_key) DO NOTHING RETURNING id',
        [eventKey, eventType, JSON.stringify(payload ?? {})],
      );
      if (r.rows[0]) return { inserted: true, id: Number(r.rows[0].id) };
      const old = await db.admin('SELECT id FROM billing_events WHERE event_key = $1', [eventKey]);
      return { inserted: false, id: old.rows[0] ? Number(old.rows[0].id) : null };
    },
    async markEvent(id, result) {
      await db.admin('UPDATE billing_events SET processed_at = $2, result = $3 WHERE id = $1', [id, nowIso(), result ?? null]);
    },
    async due(at) {
      const r = await db.admin(
        `SELECT * FROM subscriptions WHERE status = ANY($1::text[])
         AND coalesce(next_charge_at, trial_ends_at, current_period_end) <= $2 ORDER BY workspace_id`,
        [LIVE, at ?? nowIso()],
      );
      return r.rows.map(toSub);
    },
    async activeWorkspaceIds(ids) {
      const list = [...new Set((ids ?? []).map(String))];
      if (!list.length) return [];
      const r = await db.admin('SELECT workspace_id, status FROM subscriptions WHERE workspace_id = ANY($1::uuid[])', [list]);
      const status = new Map(r.rows.map((x) => [String(x.workspace_id), x.status]));
      return list.filter((id) => !status.has(id) || LIVE.includes(status.get(id)));
    },
    // 결제 잡 하루 1회: 이미 끝난 날짜면 { started: false, row }
    async beginJob(runDate) {
      const r = await db.admin(
        `INSERT INTO billing_jobs (run_date, started_at) VALUES ($1, $2)
         ON CONFLICT (run_date) DO UPDATE SET started_at = excluded.started_at WHERE billing_jobs.finished_at IS NULL RETURNING run_date`,
        [runDate, nowIso()],
      );
      if (r.rows[0]) return { started: true };
      const old = await db.admin('SELECT charged, failed, expired FROM billing_jobs WHERE run_date = $1', [runDate]);
      return { started: false, row: old.rows[0] ?? null };
    },
    async finishJob(runDate, { charged = 0, failed = 0, expired = 0 } = {}) {
      await db.admin('UPDATE billing_jobs SET finished_at = $2, charged = $3, failed = $4, expired = $5 WHERE run_date = $1', [
        runDate,
        nowIso(),
        charged,
        failed,
        expired,
      ]);
    },
  };
}
