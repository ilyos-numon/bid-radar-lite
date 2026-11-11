// 공고 소스: 목록·실행 기록·지금 가져오기·켜기/끄기·삭제·추가 폼
import { MENU, TEXT, sourcesBody, actionErrorText } from './view.mjs';
import { pickAdapter, rowsFrom, sourceFromForm } from './service.mjs';

const RUNS_SHOWN = 5;

async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

const isOwner = (member) => Boolean(member) && member.role === 'owner';

/** 대표가 아니면 403 화면 */
function ownerOnly(ctx, member) {
  return isOwner(member) ? null : render(ctx, member, { status: 403, actionError: TEXT.ownerOnly });
}

/** 설정의 주소 칸(url)이 내부 네트워크를 가리키면 오류 문구 */
async function urlErrors(ctx, config) {
  const url = config && typeof config.url === 'string' ? config.url : '';
  if (!url || typeof ctx.checkUrl !== 'function') return [];
  const r = await ctx.checkUrl(url);
  return r.ok || r.code !== 'SSRF_BLOCKED' ? [] : [r.message];
}

async function render(ctx, member, { status = 200, type, values, errors, notice, actionError } = {}) {
  const adapters = ctx.sources.adapters();
  const sources = await ctx.sources.list();
  const rows = rowsFrom(sources, adapters, ctx.now());
  const runsById = {};
  for (const s of sources) runsById[s.id] = await ctx.sources.runs(s.id, RUNS_SHOWN);
  const adapter = pickAdapter(adapters, type);
  const body = sourcesBody(ctx.html, { rows, runsById, adapters, adapter, values, errors, notice, actionError, canEdit: isOwner(member) });
  return ctx.html.page(status, { title: MENU.title, help: MENU.help, body, member, active: 'sources' });
}

export function registerRoutes(router, ctx) {
  router.get(
    '/sources',
    ctx.auth.required(async (req, params, c, member) => {
      const url = new URL(req.url);
      const notice = url.searchParams.get('added') === '1' ? TEXT.added : '';
      return render(ctx, member, { type: url.searchParams.get('type') || '', notice });
    }),
  );

  router.post(
    '/sources',
    ctx.auth.required(async (req, params, c, member) => {
      const denied = ownerOnly(ctx, member);
      if (denied) return denied;
      const form = await readForm(req);
      const type = String(form.get('type') ?? '');
      const adapter = ctx.sources.adapters().find((a) => a.type === type);
      if (!adapter) return render(ctx, member, { status: 400, actionError: actionErrorText('') });
      const input = sourceFromForm(form, adapter);
      const blocked = await urlErrors(ctx, input.config);
      const result = blocked.length > 0 ? { ok: false, errors: blocked } : await ctx.sources.add({ type: input.type, name: input.name, config: input.config });
      if (!result.ok) {
        return render(ctx, member, {
          status: 400,
          type: adapter.type,
          values: { name: input.typedName, config: input.config },
          errors: result.errors,
        });
      }
      return ctx.html.redirect(`/sources?added=1&type=${encodeURIComponent(adapter.type)}`);
    }),
  );

  router.post(
    '/sources/:id/fetch',
    ctx.auth.required(async (req, params, c, member) => {
      const source = await ctx.sources.get(params.id);
      if (!source) return render(ctx, member, { status: 404, actionError: actionErrorText('') });
      const r = await ctx.sources.fetchNow(source.id);
      if (!r.ok) ctx.log('sources', `fetch now ${source.id} failed`);
      return ctx.html.redirect('/sources');
    }),
  );

  router.post(
    '/sources/:id/toggle',
    ctx.auth.required(async (req, params, c, member) => {
      const denied = ownerOnly(ctx, member);
      if (denied) return denied;
      const source = await ctx.sources.get(params.id);
      if (!source) return render(ctx, member, { status: 404, actionError: actionErrorText('') });
      const r = await ctx.sources.update(source.id, { enabled: !source.enabled });
      if (!r.ok) return render(ctx, member, { status: 400, actionError: actionErrorText(r.errors[0]) });
      return ctx.html.redirect('/sources');
    }),
  );

  router.post(
    '/sources/:id/delete',
    ctx.auth.required(async (req, params, c, member) => {
      const denied = ownerOnly(ctx, member);
      if (denied) return denied;
      const r = await ctx.sources.remove(params.id);
      if (!r.ok) return render(ctx, member, { status: 400, actionError: actionErrorText(r.errors[0]) });
      return ctx.html.redirect('/sources');
    }),
  );
}
