// 지난 개찰: GET /history?q=&days= — 검색 폼 + 개찰 결과 표 (사실만)
import { MENU, historyBody } from './view.mjs';
import { createService, cleanQuery, cleanDays } from './service.mjs';

export function registerRoutes(router, ctx) {
  const svc = createService(ctx);

  router.get(
    '/history',
    ctx.auth.required(async (req, params, c, member) => {
      const sp = new URL(req.url).searchParams;
      const q = cleanQuery(sp.get('q'));
      const days = cleanDays(sp.get('days'));
      const result = await svc.search({ q, days });
      const body = historyBody(ctx.html, { q, days, result, example: Boolean(ctx.demo) });
      return ctx.html.page(200, { title: MENU.title, help: MENU.help, body, member, active: 'history' });
    }),
  );
}
