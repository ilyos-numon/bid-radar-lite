// 수신거부 링크 (플랫폼 레벨, 로그인 없이). Hono app 과 내부 router 둘 다 받는다
import { verifyUnsubscribeToken } from './email.mjs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UNSUB_TEXT = {
  title: '이메일 수신거부',
  done: '더 이상 보내지 않습니다',
  doneNext: '이 주소로는 입찰 레이더 알림 메일이 가지 않습니다. 다시 받으려면 대표에게 알림 설정을 요청하세요.',
  bad: '수신거부 링크가 올바르지 않습니다',
  badNext: '메일에 있는 링크를 그대로 눌러 주세요. 계속 안 되면 대표에게 알려 주세요.',
};

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render(html, status, message, next) {
  const body = `<p role="${status === 200 ? 'status' : 'alert'}"><strong>${escHtml(message)}</strong></p><p>${escHtml(next)}</p>`;
  if (html && typeof html.page === 'function') return html.page(status, { title: UNSUB_TEXT.title, body, member: null, chrome: 'bare' });
  const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${UNSUB_TEXT.title}</title></head><body><main><h1>${UNSUB_TEXT.title}</h1>${body}</main></body></html>`;
  return new Response(doc, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * @param {{ get(path: string, handler: Function): unknown }} app Hono 또는 내부 router
 * @param {{ env?: Record<string,string|undefined>, db: { admin(text: string, params?: unknown[]): Promise<unknown> }, html?: { page?: Function } }} deps
 */
export function registerUnsubscribeRoutes(app, { env = {}, db, html }) {
  const secret = String(env.APP_SECRET ?? '');
  /** @param {Request} req */
  async function handle(req) {
    const q = new URL(req.url).searchParams;
    const ws = String(q.get('ws') ?? '');
    const email = String(q.get('e') ?? '').trim().toLowerCase();
    const token = String(q.get('t') ?? '');
    const ok = secret !== '' && UUID_RE.test(ws) && email !== '' && verifyUnsubscribeToken(secret, ws, email, token);
    if (!ok) return render(html, 400, UNSUB_TEXT.bad, UNSUB_TEXT.badNext);
    await db.admin('INSERT INTO email_unsubscribes (workspace_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ws, email]);
    return render(html, 200, UNSUB_TEXT.done, UNSUB_TEXT.doneNext);
  }
  // Hono 는 Context(c.req.raw), 내부 router 는 Request 를 첫 인자로 준다
  app.get('/unsubscribe', (x) => handle(x instanceof Request ? x : x.req.raw));
  return app;
}
