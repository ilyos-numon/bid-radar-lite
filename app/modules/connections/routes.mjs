// 연결 설정: 인증키 저장·삭제(대표만), 연결 확인(누구나)
import { KEY_GROUPS } from '../../core/keys.mjs';
import { getRequestContext } from '../../core/tenant.mjs';
import { MENU, TEXT, connectionsBody, ownerOnlyBody, notFoundBody, errorText } from './view.mjs';
import { groupStatus, validateGroup, saveGroup, removeGroup, checkGroup, isGroup, readCheck, TEXT_KEY } from './service.mjs';

async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

/** 요청 문맥의 로그인 사용자 클라이언트 (키 저장·삭제는 이 클라이언트로만) */
function userAuth() {
  const rc = getRequestContext();
  if (!rc || !rc.client) return null;
  return { client: rc.client, byUserId: rc.userId };
}

function codeOf(err) {
  return err && err.code ? String(err.code) : 'error';
}

export function registerRoutes(router, ctx) {
  const page = (status, member, body) => ctx.html.page(status, { title: MENU.title, help: MENU.help, body, member, active: 'connections' });

  async function screen(member, data = {}, status = 200) {
    const body = connectionsBody(ctx.html, {
      groups: KEY_GROUPS,
      textKey: TEXT_KEY,
      status: await groupStatus(ctx),
      canEdit: member.role === 'owner',
      ...data,
    });
    return page(status, member, body);
  }

  router.get(
    '/connections',
    ctx.auth.required(async (req, params, c, member) => {
      const sp = new URL(req.url).searchParams;
      const saved = sp.get('saved');
      const removed = sp.get('removed');
      return screen(member, {
        saved: isGroup(saved) ? saved : null,
        removed: isGroup(removed) ? removed : null,
        check: readCheck(sp),
      });
    }),
  );

  router.post(
    '/connections/:group',
    ctx.auth.required(async (req, params, c, member) => {
      const group = params.group;
      if (!isGroup(group)) return page(404, member, notFoundBody(ctx.html));
      if (member.role !== 'owner') return page(403, member, ownerOnlyBody(ctx.html));
      const form = await readForm(req);
      const raw = {};
      for (const name of KEY_GROUPS[group]) raw[name] = form.get(name);
      const { values, errors } = validateGroup(group, raw);
      if (errors.length > 0) return screen(member, { errors: errors.map((e) => errorText(e, TEXT_KEY)) }, 400);
      const auth = userAuth();
      if (!auth) return screen(member, { failure: { message: TEXT.saveFailed, next: TEXT.tryLater } }, 500);
      try {
        await saveGroup(ctx, group, values, auth);
      } catch (err) {
        ctx.log('connections', `save ${group} failed: ${codeOf(err)}`);
        return screen(member, { failure: { message: TEXT.saveFailed, next: TEXT.tryLater } }, 500);
      }
      return ctx.html.redirect(`/connections?saved=${group}`);
    }),
  );

  router.post(
    '/connections/:group/remove',
    ctx.auth.required(async (req, params, c, member) => {
      const group = params.group;
      if (!isGroup(group)) return page(404, member, notFoundBody(ctx.html));
      if (member.role !== 'owner') return page(403, member, ownerOnlyBody(ctx.html));
      const auth = userAuth();
      if (!auth) return screen(member, { failure: { message: TEXT.removeFailed, next: TEXT.tryLater } }, 500);
      try {
        await removeGroup(ctx, group, auth);
      } catch (err) {
        ctx.log('connections', `remove ${group} failed: ${codeOf(err)}`);
        return screen(member, { failure: { message: TEXT.removeFailed, next: TEXT.tryLater } }, 500);
      }
      return ctx.html.redirect(`/connections?removed=${group}`);
    }),
  );

  router.post(
    '/connections/:group/check',
    ctx.auth.required(async (req, params, c, member) => {
      const group = params.group;
      if (!isGroup(group)) return page(404, member, notFoundBody(ctx.html));
      const { result, code } = await checkGroup(ctx, group);
      const q = new URLSearchParams({ check: group, result, code });
      return ctx.html.redirect(`/connections?${q.toString()}`);
    }),
  );
}
