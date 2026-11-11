// 운영 현황 화면(/admin, /admin.json): 로그인 + APP_PLATFORM_ADMIN_EMAILS 에 있는 사람만. 그 밖에는 없는 페이지처럼 404
import { isPlatformAdmin } from './stats.mjs';
import { adminView, notFoundView } from './views.mjs';

function withCookies(res, cookies) {
  const list = (cookies ?? []).filter(Boolean);
  if (list.length === 0) return res;
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
  for (const c of list) out.headers.append('set-cookie', c);
  return out;
}

const json = (body, status) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * @param {import('hono').Hono} app
 * @param {{ env: object, platform: { auth: { fromRequest(req: Request): Promise<{ user: { email?: string }|null, setCookies?: string[] }> } }, stats: { adminSummary(): Promise<object> }, page: (status: number, opts: object, cookies?: string[]) => Promise<Response> }} deps
 */
export function registerAdminRoutes(app, { env, platform, stats, page }) {
  function guarded(render) {
    return async (c) => {
      const req = c.req.raw;
      const s = await platform.auth.fromRequest(req);
      const cookies = s?.setCookies ?? [];
      if (!s?.user) return withCookies(new Response(null, { status: 302, headers: { location: '/welcome' } }), cookies);
      if (!isPlatformAdmin(env, s.user.email)) return render.notFound(cookies);
      return render.ok(await stats.adminSummary(), cookies);
    };
  }

  app.get(
    '/admin',
    guarded({
      ok: async (summary, cookies) => withCookies(await page(200, adminView(summary), cookies), cookies),
      notFound: async (cookies) => withCookies(await page(404, notFoundView(), cookies), cookies),
    }),
  );
  app.get(
    '/admin.json',
    guarded({
      ok: async (summary, cookies) => withCookies(json(summary, 200), cookies),
      notFound: async (cookies) => withCookies(json({ error: 'not_found' }, 404), cookies),
    }),
  );
}
