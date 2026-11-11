// 공고 요약: 목록 · 상세 · 다시 만들기
import { MENU, TEXT, listBody, detailBody, notFoundBody } from './view.mjs';
import { createStore, summarize } from './service.mjs';

async function listRows(ctx) {
  const store = createStore(ctx);
  const date = await ctx.matches.latestDate();
  if (!date) return [];
  const { matched, maybe } = await ctx.matches.forDate(date);
  const rows = [];
  for (const m of matched) rows.push({ bid: m, item: await store.get(m.bidId), maybe: false });
  if (maybe && !rows.some((r) => r.bid.bidId === maybe.bidId)) rows.push({ bid: maybe, item: await store.get(maybe.bidId), maybe: true });
  return rows;
}

function notFound(ctx, member) {
  return ctx.html.page(404, { title: TEXT.notFound, body: notFoundBody(ctx.html), member, active: 'summary' });
}

export function registerRoutes(router, ctx) {
  router.get(
    '/summary',
    ctx.auth.required(async (req, params, c, member) => {
      const body = listBody(ctx.html, { rows: await listRows(ctx), today: ctx.today() });
      return ctx.html.layout({ title: MENU.title, help: MENU.help, body, member, active: 'summary' });
    }),
  );

  router.get(
    '/summary/:bidId',
    ctx.auth.required(async (req, params, c, member) => {
      const bid = await ctx.bids.get(params.bidId);
      if (!bid) return notFound(ctx, member);
      const body = detailBody(ctx.html, { bid, item: await createStore(ctx).get(bid.bidId), today: ctx.today() });
      return ctx.html.layout({ title: MENU.title, heading: bid.title, eyebrow: MENU.title, help: '', body, member, active: 'summary' });
    }),
  );

  router.post(
    '/summary/:bidId/regenerate',
    ctx.auth.required(async (req, params, c, member) => {
      const bid = await ctx.bids.get(params.bidId);
      if (!bid) return notFound(ctx, member);
      await summarize(ctx, bid.bidId);
      return ctx.html.redirect(`/summary/${encodeURIComponent(bid.bidId)}`);
    }),
  );
}
