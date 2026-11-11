// 회사 하나의 이메일 알림: 받는 사람(수신거부 제외)·하루 한 번 발송·수신거부 기록
import { EMAIL_KIND_SUFFIX, NOTIFY_EMAILS_KEY, parseEmails, renderDigestEmail, unsubscribeToken, unsubscribeUrl } from './email.mjs';

const DEFAULT_API_BASE = 'https://api.resend.com';

/**
 * @param {{ db: { admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, settings: { get(key: string): Promise<string|null> },
 *   notify: { deliverVia: Function }, sender: { enabled: boolean, send: Function }, limits?: { max?(kind: string): Promise<number> }|null,
 *   budget?: { take(kind: string, opts?: { n?: number }): Promise<{ ok: boolean }> }|null, env?: Record<string,string|undefined>, workspaceId: string, appUrl?: string }} opts
 */
export function createEmailAlerts({ db, settings, notify, sender, limits, budget, env = {}, workspaceId, appUrl }) {
  const ws = String(workspaceId);
  const secret = String(env.APP_SECRET ?? '');
  const base = String(appUrl ?? env.APP_BASE_URL ?? '').replace(/\/+$/, '');

  async function recipients() {
    const list = parseEmails(await settings.get(NOTIFY_EMAILS_KEY));
    if (list.length === 0) return [];
    const r = await db.admin('SELECT email FROM email_unsubscribes WHERE workspace_id = $1', [ws]);
    const off = new Set(r.rows.map((row) => String(row.email).toLowerCase()));
    let out = list.filter((e) => !off.has(e));
    // 요금제를 내린 뒤에도 한도까지만 보낸다
    if (limits && typeof limits.max === 'function') {
      const max = await limits.max('emails');
      if (Number.isFinite(max) && max >= 0) out = out.slice(0, max);
    }
    return out;
  }

  return {
    recipients,
    /**
     * @param {{ payload: object, runId: string }} d
     * @returns {Promise<{ sent: boolean, reason?: string, to?: number }>}
     */
    async deliver({ payload, runId }) {
      if (!sender || !sender.enabled || secret === '') return { sent: false, reason: 'no_target' };
      const to = await recipients();
      if (to.length === 0) return { sent: false, reason: 'no_target' };
      const kind = payload && payload.kind ? String(payload.kind) : 'bids';
      const date = String(payload && payload.date ? payload.date : '');
      let overBudget = false;
      const send = async () => {
        // 하루 이메일 예산: 실제로 보낼 때만 받는 사람 수만큼 센다. 넘으면 보내지 않고 'budget' 으로 기록
        if (budget && !(await budget.take('email', { n: to.length })).ok) {
          overBudget = true;
          return { ok: false, code: 'budget' };
        }
        let failed = null;
        for (const email of to) {
          const url = unsubscribeUrl(base, { workspaceId: ws, email, token: unsubscribeToken(secret, ws, email) });
          const mail = renderDigestEmail({ kind, date, text: payload, appUrl: base || undefined, unsubscribeUrl: url });
          const r = await sender.send({ to: [email], ...mail, headers: { 'List-Unsubscribe': `<${url}>` } });
          if (!r.ok && !failed) failed = r;
        }
        return failed ? { ok: false, status: failed.status, code: failed.code } : { ok: true, status: 200 };
      };
      const r = await notify.deliverVia({
        kind: `${kind}${EMAIL_KIND_SUFFIX}`,
        date,
        runId,
        targetHost: new URL(env.EMAIL_API_BASE || DEFAULT_API_BASE).host,
        send,
      });
      if (overBudget) return { sent: false, reason: 'budget' };
      return r.sent ? { ...r, to: to.length } : r;
    },
    /** @param {string} email */
    async unsubscribe(email) {
      await db.admin('INSERT INTO email_unsubscribes (workspace_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
        ws,
        String(email).toLowerCase(),
      ]);
    },
  };
}
