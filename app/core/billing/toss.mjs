// 토스페이먼츠 빌링 REST v1 얇은 래퍼 (fetch 주입). 키 값은 로그·오류 메시지에 넣지 않는다
import { createHash, randomBytes } from 'node:crypto';

const DEFAULT_BASE = 'https://api.tosspayments.com';
const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * `${workspaceId 앞 8자}`·plan·YYYYMMDD·6자 → `br_…` (토스 orderId: 6~64자, 영숫자·_-)
 * seed 가 있으면 6자를 (workspaceId 전체, plan, 날짜, seed) 해시로 정한다 — 같은 청구 대상·시도는 늘 같은 orderId(=Idempotency-Key).
 * seed 가 없으면 랜덤.
 */
export function makeOrderId(workspaceId, plan, at = new Date(), seed) {
  const ws = String(workspaceId).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  const ymd = new Date(at).toISOString().slice(0, 10).replace(/-/g, '');
  const bytes = seed === undefined || seed === null ? randomBytes(6) : createHash('sha256').update(`${workspaceId}|${plan}|${ymd}|${seed}`).digest().subarray(0, 6);
  const rnd = [...bytes].map((b) => ALNUM[b % ALNUM.length]).join('');
  return `br_${ws}_${plan}_${ymd}_${rnd}`;
}

/** 카드사 + 뒤 4자리. 예 '신한 ****1234' */
export function cardSummaryOf(data) {
  const company = data?.cardCompany ?? data?.card?.company ?? '카드';
  const number = String(data?.cardNumber ?? data?.card?.number ?? '').replace(/[^0-9*]/g, '');
  return number.length >= 4 ? `${company} ****${number.slice(-4)}` : String(company);
}

/**
 * @param {{ env?: Record<string, string|undefined>, fetch: typeof globalThis.fetch }} opts
 */
export function createToss({ env = {}, fetch: fetchImpl } = {}) {
  const secret = env.TOSS_SECRET_KEY || '';
  const clientKey = env.TOSS_CLIENT_KEY || '';
  const base = String(env.TOSS_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');
  const enabled = Boolean(secret && clientKey);
  const auth = `Basic ${Buffer.from(`${secret}:`).toString('base64')}`;
  const doFetch = fetchImpl ?? globalThis.fetch;

  async function call(method, path, { body, idempotencyKey } = {}) {
    if (!enabled) return { ok: false, code: 'NOT_CONFIGURED', status: 0 };
    const headers = { Authorization: auth, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      return { ok: false, code: 'NETWORK_ERROR', status: 0 };
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const code = data && typeof data.code === 'string' ? data.code : `HTTP_${res.status}`;
      return { ok: false, code, status: res.status };
    }
    return { ok: true, data: data ?? {}, status: res.status };
  }

  return {
    enabled,
    clientKey,
    async issueBillingKey({ authKey, customerKey }) {
      const idem = createHash('sha256').update(`issue:${customerKey}:${authKey}`).digest('hex');
      const r = await call('POST', '/v1/billing/authorizations/issue', { body: { authKey, customerKey }, idempotencyKey: idem });
      if (!r.ok) return r;
      if (!r.data.billingKey) return { ok: false, code: 'NO_BILLING_KEY', status: r.status };
      return { ok: true, billingKey: r.data.billingKey, cardSummary: cardSummaryOf(r.data) };
    },
    async charge({ billingKey, customerKey, amount, orderId, orderName, customerEmail }) {
      const body = { customerKey, amount, orderId, orderName };
      if (customerEmail) body.customerEmail = customerEmail;
      const r = await call('POST', `/v1/billing/${encodeURIComponent(billingKey)}`, { body, idempotencyKey: orderId });
      if (!r.ok) return r;
      if (r.data.status && r.data.status !== 'DONE') return { ok: false, code: `STATUS_${r.data.status}`, status: r.status };
      return { ok: true, paymentKey: r.data.paymentKey, approvedAt: r.data.approvedAt ?? null };
    },
    async getPayment(paymentKey) {
      const r = await call('GET', `/v1/payments/${encodeURIComponent(paymentKey)}`);
      if (!r.ok) return r;
      const d = r.data;
      return { ok: true, status: d.status, orderId: d.orderId, totalAmount: d.totalAmount, approvedAt: d.approvedAt ?? null };
    },
  };
}
