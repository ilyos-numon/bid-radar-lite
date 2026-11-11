// 공개 서비스 현황(/status, /status.json). 로그인 없이 본다. Hono 앱과 createRouter 객체 둘 다에 붙는다(.get 만 쓴다)
import { statusView } from './views.mjs';

/**
 * @param {{ get(path: string, handler: Function): unknown }} router
 * @param {{ stats: { publicStatus(): Promise<object> }, page: (status: number, opts: object) => Promise<Response> }} deps
 */
export function registerStatusRoutes(router, { stats, page }) {
  router.get('/status', async () => {
    const s = await stats.publicStatus();
    const res = await page(200, statusView(s));
    const out = new Response(res.body, { status: res.status, headers: new Headers(res.headers) });
    out.headers.set('cache-control', 'public, max-age=60');
    return out;
  });
  router.get('/status.json', async () => {
    const s = await stats.publicStatus();
    return Response.json(s, { status: 200, headers: { 'cache-control': 'public, max-age=60' } });
  });
}
