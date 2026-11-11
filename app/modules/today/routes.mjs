// 오늘의 공고: 최신 추천 목록 + 다른 메뉴가 붙이는 뱃지 + 지금 가져오기
import { MENU, TEXT, todayBody, todayActions, fetchError } from './view.mjs';
import { explainMatch } from '../../core/explain.mjs';

const errText = (err) => (err && err.message ? err.message : String(err));

/** 모듈 decorate 훅 결과를 모은다. 훅 하나가 실패하면 그 뱃지만 건너뛴다 */
async function badgesFor(ctx, bidId, member) {
  const out = [];
  for (const { id, fn } of (ctx.hooks && ctx.hooks.decorate) || []) {
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
    ctx.log('today', `links failed for ${bidId}: ${errText(err)}`);
    return NO_FLOW();
  }
}

/** 켜진 소스가 모두 실패했으면 첫 오류 문구, 아니면 null */
async function allSourcesFailed(ctx) {
  if (!ctx.sources || typeof ctx.sources.list !== 'function') return null;
  const enabled = (await ctx.sources.list()).filter((s) => s.enabled);
  if (enabled.length === 0) return null;
  const failed = enabled.filter((s) => s.lastRun && !s.lastRun.ok);
  if (failed.length !== enabled.length) return null;
  return failed[0].lastRun.error || '';
}

/** 저장된 공고 세부 정보(종류·개찰·예산 기준·금액)를 붙인다. 추천 목록에 이미 있는 값이 우선 */
async function withDetails(ctx, item) {
  const stored = ctx.bids && typeof ctx.bids.get === 'function' ? await ctx.bids.get(item.bidId) : null;
  if (!stored) return item;
  const extra = {};
  for (const k of ['kind', 'openingAt', 'budgetBasis', 'amounts', 'limits']) if (stored[k] !== undefined) extra[k] = stored[k];
  const out = { ...extra };
  for (const [k, v] of Object.entries(item)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

/** 최근 7일 변경 기록. 저장소가 없거나 실패하면 빈 목록 */
async function recentChanges(ctx) {
  if (!ctx.bids || typeof ctx.bids.changesSince !== 'function') return [];
  const now = typeof ctx.now === 'function' ? ctx.now() : new Date();
  try {
    return await ctx.bids.changesSince(new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString());
  } catch (err) {
    ctx.log('today', `changes failed: ${errText(err)}`);
    return [];
  }
}

async function render(ctx, member, error = null) {
  const date = await ctx.matches.latestDate();
  const { matched, maybe } = date ? await ctx.matches.forDate(date) : { matched: [], maybe: null };
  const items = [];
  for (const m of matched) {
    const bid = await withDetails(ctx, m);
    items.push({ bid, badges: await badgesFor(ctx, bid.bidId, member), flow: await flowFor(ctx, bid.bidId) });
  }
  const maybeBid = maybe ? await withDetails(ctx, maybe) : null;
  const maybeItem = maybeBid ? { bid: maybeBid, badges: await badgesFor(ctx, maybeBid.bidId, member), flow: await flowFor(ctx, maybeBid.bidId) } : null;
  const today = ctx.today();
  const criteria = ctx.criteria && typeof ctx.criteria.get === 'function' ? await ctx.criteria.get() : null;
  const changes = await recentChanges(ctx);
  const explain = new Map();
  if (criteria) for (const it of maybeItem ? [...items, maybeItem] : items) explain.set(it.bid.bidId, explainMatch(criteria, it.bid));
  const example = Boolean(ctx.demo);
  const body = todayBody(ctx.html, { date, today, items, maybe: maybeItem, error, criteria, changes, example, explain });
  const credits = ctx.credits ? await ctx.credits.summary() : null;
  const actions = todayActions(ctx.html, { date, today, count: items.length, credits });
  return ctx.html.layout({ title: MENU.title, help: MENU.help, body, member, active: 'today', actions });
}

export function registerRoutes(router, ctx) {
  router.get(
    '/today',
    ctx.auth.required((req, params, c, member) => render(ctx, member)),
  );

  router.post(
    '/today/run',
    ctx.auth.required(async (req, params, c, member) => {
      let taken = false;
      if (ctx.credits) {
        const c = await ctx.credits.take();
        if (!c.ok) return render(ctx, member, { message: TEXT.creditsNone(c.max), next: TEXT.creditsNoneNext, href: '/billing' });
        taken = !c.unlimited;
      }
      try {
        await ctx.jobs.runDaily({ date: ctx.today() });
      } catch (err) {
        ctx.log('today', `run failed: ${errText(err)}`);
        if (taken) await ctx.credits.refund().catch((e) => ctx.log('today', `refund failed: ${errText(e)}`));
        return render(ctx, member, fetchError(''));
      }
      const failed = await allSourcesFailed(ctx);
      if (failed !== null) return render(ctx, member, fetchError(failed));
      return ctx.html.redirect('/today');
    }),
  );
}
