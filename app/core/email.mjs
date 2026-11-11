// 이메일 발송(Resend HTTP API, fetch 만 사용)·수신거부 서명·알림 메일 본문
import { createHmac, timingSafeEqual } from 'node:crypto';
import { create as createNotify } from './notify.mjs';

export const NOTIFY_EMAILS_KEY = 'notify_emails';
export const EMAIL_KIND_SUFFIX = ':email';
const DEFAULT_API_BASE = 'https://api.resend.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {{ env?: Record<string,string|undefined>, fetch: (url: string, init?: object) => Promise<Response> }} opts
 */
export function createEmailSender({ env = {}, fetch }) {
  const key = String(env.EMAIL_API_KEY ?? '').trim();
  const from = String(env.EMAIL_FROM ?? '').trim();
  const base = String(env.EMAIL_API_BASE ?? '').trim().replace(/\/+$/, '') || DEFAULT_API_BASE;
  const enabled = Boolean(key && from);
  return {
    enabled,
    /**
     * @param {{ to: string[], subject: string, text: string, html: string, headers?: Record<string,string> }} m
     * @returns {Promise<{ ok: true, id: string } | { ok: false, status?: number, code: string }>}
     */
    async send({ to, subject, text, html, headers }) {
      if (!enabled) return { ok: false, code: 'EMAIL_DISABLED' };
      const body = { from, to, subject, text, html };
      if (headers && Object.keys(headers).length > 0) body.headers = headers;
      let res;
      try {
        res = await fetch(`${base}/emails`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs: 10000,
        });
      } catch (err) {
        const code = err && typeof err.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(err.code) ? err.code : 'error';
        return { ok: false, code };
      }
      if (!res.ok) return { ok: false, status: res.status, code: `http_${res.status}` };
      let id = '';
      try {
        const data = await res.json();
        id = data && data.id ? String(data.id) : '';
      } catch {
        id = '';
      }
      return { ok: true, id };
    },
  };
}

/** base64url(HMAC-SHA256(secret, `${workspaceId}\n${email 소문자}`)) — 43자 */
export function unsubscribeToken(secret, workspaceId, email) {
  return createHmac('sha256', String(secret ?? ''))
    .update(`${workspaceId}\n${String(email ?? '').toLowerCase()}`)
    .digest('base64url');
}

/** @returns {boolean} */
export function verifyUnsubscribeToken(secret, workspaceId, email, token) {
  if (typeof token !== 'string' || token === '') return false;
  const want = Buffer.from(unsubscribeToken(secret, workspaceId, email));
  const got = Buffer.from(token);
  if (want.length !== got.length) return false;
  return timingSafeEqual(want, got);
}

export function unsubscribeUrl(appUrl, { workspaceId, email, token }) {
  return `${appUrl}/unsubscribe?ws=${workspaceId}&e=${encodeURIComponent(email)}&t=${token}`;
}

function mmdd(date) {
  const [, mm, dd] = String(date ?? '').split('-');
  return `${mm}/${dd}`;
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const SUBJECT = {
  bids: (d, n) => `[입찰 레이더] ${d} 맞는 공고 ${n}건`,
  reminder: (d, n) => `[입찰 레이더] ${d} 마감 임박 ${n}건`,
  support: (d, n) => `[입찰 레이더] ${d} 새 지원사업 ${n}건`,
};

/**
 * 알림 1건 → 메일 제목·본문. `text` 는 알림 payload(NotificationV2). 본문은 notify.render 와 같은 글.
 * @param {{ kind: string, date: string, text: object, appUrl?: string, unsubscribeUrl: string }} p
 * @returns {{ subject: string, text: string, html: string }}
 */
export function renderDigestEmail({ kind, date, text, appUrl, unsubscribeUrl: unsub }) {
  const payload = text && typeof text === 'object' ? text : {};
  const k = SUBJECT[kind] ? kind : 'bids';
  const items = Array.isArray(payload.items) ? payload.items : [];
  const count = payload.count ?? items.length;
  const { notify } = createNotify({ env: {} });
  const body = notify.render({ ...payload, kind: k, date: payload.date ?? date, ...(appUrl ? { appUrl } : {}) });
  const subject = SUBJECT[k](mmdd(date), count);
  return {
    subject,
    text: `${body}\n\n수신거부: ${unsub}`,
    html: `<pre style="white-space:pre-wrap;font-family:inherit">${escHtml(body)}</pre>\n<p><a href="${escHtml(unsub)}">수신거부</a></p>`,
  };
}

/** 쉼표·줄바꿈 구분 이메일 목록 → 소문자·중복 제거·형식 맞는 것만 */
export function parseEmails(value) {
  const out = [];
  for (const raw of String(value ?? '').split(/[,，;\n]/)) {
    const e = raw.trim().toLowerCase();
    if (e === '' || !EMAIL_RE.test(e) || out.includes(e)) continue;
    out.push(e);
  }
  return out;
}
