// 추천 키워드: 제안 받기·채택·거절·관련 가능성 켜기/끄기. 로그인한 구성원 누구나 쓸 수 있다.
import { MENU, TEXT, keywordsBody, suggestError } from './view.mjs';
import { listSynonyms, maybeEnabled, requestSuggestions, setMaybeEnabled, setStatus } from './service.mjs';

const errText = (err) => (err && err.message ? err.message : String(err));

async function render(ctx, member, { error = null, notice = null } = {}) {
  const body = keywordsBody(ctx.html, {
    keywords: (await ctx.criteria.get()).keywords || [],
    suggested: await listSynonyms(ctx.db, 'suggested'),
    accepted: await listSynonyms(ctx.db, 'accepted'),
    rejected: await listSynonyms(ctx.db, 'rejected'),
    maybeOn: await maybeEnabled(ctx.settings),
    error,
    notice,
  });
  return ctx.html.layout({ title: MENU.title, help: MENU.help, body, member, active: 'keywords' });
}

async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

export function registerRoutes(router, ctx) {
  router.get(
    '/keywords',
    ctx.auth.required((req, params, c, member) => {
      const added = new URL(req.url).searchParams.get('added');
      let notice = null;
      if (added !== null && /^\d+$/.test(added)) notice = Number(added) > 0 ? TEXT.added(Number(added)) : TEXT.addedNone;
      return render(ctx, member, { notice });
    }),
  );

  router.post(
    '/keywords/suggest',
    ctx.auth.required(async (req, params, c, member) => {
      let res;
      try {
        res = await requestSuggestions(ctx);
      } catch (err) {
        ctx.log('keywords', `suggest failed: ${errText(err)}`);
        res = { ok: false, error: 'UNKNOWN' };
      }
      if (!res.ok) {
        ctx.log('keywords', `suggest not ok: ${res.error}`);
        return render(ctx, member, { error: suggestError(res.error) });
      }
      return ctx.html.redirect(`/keywords?added=${res.added.length}`);
    }),
  );

  router.post(
    '/keywords/maybe',
    ctx.auth.required(async (req, params, c, member) => {
      const form = await readForm(req);
      await setMaybeEnabled(ctx.settings, String(form.get('enabled') ?? '') !== 'false');
      return ctx.html.redirect('/keywords');
    }),
  );

  for (const [action, status] of [
    ['accept', 'accepted'],
    ['reject', 'rejected'],
  ]) {
    router.post(
      `/keywords/:word/${action}`,
      ctx.auth.required(async (req, params, c, member) => {
        await setStatus(ctx.db, params.word, status);
        return ctx.html.redirect('/keywords');
      }),
    );
  }
}
