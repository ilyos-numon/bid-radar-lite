// 플랫폼 레벨 결제 라우트: 토스 웹훅(조회로 재확인, 멱등)·하루 1회 결제 잡
import { timingSafeEqual } from 'node:crypto';

// 토스 결제 상태 → payments.status. 목록에 없는 상태는 바꾸지 않는다
const STATUS_MAP = { DONE: 'paid', CANCELED: 'canceled', ABORTED: 'failed', EXPIRED: 'failed' };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 상수 시간 비교(길이가 다르면 false) */
function sameToken(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 기록용 오류 코드(메시지·값 없이) */
function codeOf(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'error';
}

/**
 * @param {import('hono').Hono} app
 * @param {{ env: Record<string, string|undefined>, billing: { store: object, toss: object, cycle: object, vault: object }, db: { admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> } }} deps
 */
export function registerBillingRoutes(app, { env = {}, billing, db }) {
  const { store, toss, cycle } = billing;

  // 웹훅: 본문의 status 는 믿지 않고 GET /v1/payments/{paymentKey} 결과로 확정한다. 토스 재전송을 막으려고 항상 200
  app.post('/webhooks/toss', async (c) => {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: 'bad_body' });
    }
    const data = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data : {};
    const paymentKey = typeof data.paymentKey === 'string' ? data.paymentKey : '';
    if (!paymentKey) return c.json({ ok: false, error: 'no_payment_key' });
    const eventKey = `${paymentKey}:${data.status ?? ''}:${body.createdAt ?? ''}`;
    const eventType = typeof body.eventType === 'string' && body.eventType ? body.eventType : 'unknown';
    let ev;
    try {
      ev = await store.recordEvent({ eventKey, eventType, payload: body });
    } catch (err) {
      return c.json({ ok: false, error: codeOf(err) });
    }
    if (!ev.inserted) return c.json({ ok: true, duplicate: true });
    let result;
    try {
      const p = await toss.getPayment(paymentKey);
      if (!p.ok) {
        result = `lookup_failed:${p.code ?? 'UNKNOWN'}`;
      } else {
        const next = STATUS_MAP[p.status];
        if (!next) {
          result = `ignored:${p.status}`;
        } else {
          const r = await db.admin(
            `UPDATE payments SET status = $1, payment_key = COALESCE(payment_key, $2),
               approved_at = CASE WHEN $1 = 'paid' THEN COALESCE(approved_at, $3::timestamptz) ELSE approved_at END
             WHERE payment_key = $2 OR order_id = $4 RETURNING id`,
            [next, paymentKey, p.approvedAt ?? null, p.orderId ?? ''],
          );
          result = r.rows.length ? `synced:${next}` : 'no_payment';
        }
      }
    } catch (err) {
      result = `error:${codeOf(err)}`;
    }
    try {
      await store.markEvent(ev.id, result);
    } catch {
      // 기록 실패도 200 으로 돌려준다
    }
    return c.json({ ok: !result.startsWith('error') && !result.startsWith('lookup_failed'), result });
  });

  // 결제 잡: 잡 토큰(x-job-token)으로 부른다 (운영 데모는 예약 실행을 꺼 두었다)
  app.get('/api/jobs/billing', async (c) => {
    if (!env.APP_JOB_TOKEN || !sameToken(c.req.header('x-job-token'), env.APP_JOB_TOKEN)) return c.json({ error: 'forbidden' }, 403);
    const date = c.req.query('date');
    if (date !== undefined && date !== '' && !DATE_RE.test(date)) return c.json({ error: 'bad_date' }, 400);
    try {
      const r = await cycle.run(date ? { date } : {});
      return c.json({ charged: r.charged, failed: r.failed, expired: r.expired, skipped: r.skipped });
    } catch (err) {
      return c.json({ error: codeOf(err) }, 500);
    }
  });
}
