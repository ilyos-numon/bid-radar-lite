// 관심 공고 라우트: 목록·담기(확인/저장)·해제·확인 항목 토글. 전부 로그인 필수
import { MENU, CHECKLIST, TEXT, listBody, listActions, addBody, notFoundBody, badItemBody } from './view.mjs';
import { addInterest, removeInterest, setCheck, isInterested, listInterest } from './service.mjs';

const errText = (err) => (err && err.message ? err.message : String(err));

/** 다른 메뉴의 decorate 훅 뱃지를 모은다 (관심 자신은 뺀다). 훅 하나가 실패하면 그 뱃지만 건너뛴다 */
async function badgesFor(ctx, bidId, member) {
  const out = [];
  for (const { id, fn } of (ctx.hooks && ctx.hooks.decorate) || []) {
    if (id === 'interest') continue;
    try {
      const b = await fn(ctx, bidId, member);
      if (b && typeof b.label === 'string' && b.label !== '' && typeof b.href === 'string') {
        out.push(typeof b.kind === 'string' ? { label: b.label, href: b.href, kind: b.kind } : { label: b.label, href: b.href });
      }
    } catch (err) {
      ctx.log(id, `decorate failed for ${bidId}: ${errText(err)}`);
    }
  }
  return out;
}

const NO_FLOW = () => ({ prestd: null, notices: [] });

/** 사전규격·본공고 연결. 저장소가 없거나 실패하면 빈 흐름 */
async function flowFor(ctx, bidId) {
  if (!ctx.bids || typeof ctx.bids.linksFor !== 'function') return NO_FLOW();
  try {
    return await ctx.bids.linksFor(bidId);
  } catch (err) {
    ctx.log('interest', `links failed for ${bidId}: ${errText(err)}`);
    return NO_FLOW();
  }
}

function notFound(ctx, member) {
  return ctx.html.page(404, { title: TEXT.notFoundTitle, body: notFoundBody(ctx.html), member, active: 'interest' });
}

async function formOf(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

export function registerRoutes(router, ctx) {
  router.get(
    '/interest',
    ctx.auth.required(async (req, params, c, member) => {
      const today = ctx.today();
      const items = await listInterest(ctx, today);
      for (const it of items) {
        it.badges = await badgesFor(ctx, it.bid.bidId, member);
        it.flow = await flowFor(ctx, it.bid.bidId);
      }
      return ctx.html.layout({
        title: MENU.title,
        help: MENU.help,
        actions: listActions(ctx.html),
        body: listBody(ctx.html, items, today, { example: Boolean(ctx.demo) }),
        member,
        active: 'interest',
      });
    }),
  );

  router.get(
    '/interest/add/:bidId',
    ctx.auth.required(async (req, params, c, member) => {
      const bid = await ctx.bids.get(params.bidId);
      if (!bid) return notFound(ctx, member);
      const body = addBody(ctx.html, { bid, dday: ctx.html.dday(bid.deadline, ctx.today()), already: await isInterested(ctx, bid.bidId) });
      return ctx.html.layout({ title: TEXT.addTitle, help: MENU.help, body, member, active: 'interest' });
    }),
  );

  router.post(
    '/interest/add/:bidId',
    ctx.auth.required(async (req, params, c, member) => {
      const bid = await ctx.bids.get(params.bidId);
      if (!bid) return notFound(ctx, member);
      await addInterest(ctx, bid.bidId, member.id);
      return ctx.html.redirect('/interest');
    }),
  );

  router.post(
    '/interest/:bidId/remove',
    ctx.auth.required(async (req, params, c, member) => {
      await removeInterest(ctx, params.bidId);
      return ctx.html.redirect('/interest');
    }),
  );

  router.post(
    '/interest/:bidId/check',
    ctx.auth.required(async (req, params, c, member) => {
      if (!(await isInterested(ctx, params.bidId))) return notFound(ctx, member);
      const form = await formOf(req);
      const item = Number(form.get('item'));
      if (!Number.isInteger(item) || item < 1 || item > CHECKLIST.length) {
        return ctx.html.page(400, { title: MENU.title, body: badItemBody(ctx.html), member, active: 'interest' });
      }
      await setCheck(ctx, params.bidId, item, String(form.get('checked') ?? '') === '1');
      return ctx.html.redirect('/interest');
    }),
  );
}
