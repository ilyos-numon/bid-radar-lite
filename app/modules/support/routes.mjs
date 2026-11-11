// 지원사업: 목록·지금 가져오기·키워드 저장 (로그인 필수)
import { MENU, TEXT, supportBody, fetchError, fetchActions } from './view.mjs';
import { collect, getKeywords, getRegions, hasKey, matchedList, saveFilters, splitList } from './service.mjs';

async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

async function render(ctx, member, { status = 200, error = null, notice = null } = {}) {
  const keywords = await getKeywords(ctx, { persist: true });
  const { total, items } = await matchedList(ctx);
  const keyed = hasKey(ctx.env);
  const body = supportBody(ctx.html, {
    hasKey: keyed,
    today: ctx.today(),
    total,
    items,
    keywords,
    regions: await getRegions(ctx),
    error,
    notice,
  });
  return ctx.html.page(status, {
    title: MENU.title,
    help: MENU.help,
    body,
    member,
    active: 'support',
    actions: fetchActions(ctx.html, keyed),
  });
}

export function registerRoutes(router, ctx) {
  router.get(
    '/support',
    ctx.auth.required(async (req, params, c, member) => {
      const q = new URL(req.url).searchParams;
      let notice = null;
      if (q.get('saved') === '1') notice = TEXT.saved;
      const n = q.get('fetched');
      if (n !== null && /^\d+$/.test(n)) notice = TEXT.fetched(Number(n));
      return render(ctx, member, { notice });
    }),
  );

  router.post(
    '/support/fetch',
    ctx.auth.required(async (req, params, c, member) => {
      const r = await collect(ctx, { date: ctx.today() });
      if (r.status === 'nokey') return ctx.html.redirect('/support');
      if (r.status === 'failed') return render(ctx, member, { error: fetchError(r) });
      return ctx.html.redirect(`/support?fetched=${r.count}`);
    }),
  );

  router.post(
    '/support/keywords',
    ctx.auth.required(async (req, params, c, member) => {
      const form = await readForm(req);
      await saveFilters(ctx, {
        keywords: splitList(form.get('keywords')),
        regions: splitList(form.get('regions')),
      });
      return ctx.html.redirect('/support?saved=1');
    }),
  );
}
