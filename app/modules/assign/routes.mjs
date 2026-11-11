// 업무 분배: 상태별 목록, 공고별 담당자·상태 폼, 구성원과 초대 링크
import { MENU, TEXT, boardBody, boardActions, formBody, notFoundBody, membersBody } from './view.mjs';
import { isStatus, getItem, listItems, groupByStatus, saveItem, inviteUrl } from './service.mjs';

const NOTE_MAX = 1000;

async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

function page(ctx, member, status, body, title = MENU.title, help = MENU.help, extra = {}) {
  return ctx.html.page(status, { title, help, body, member, active: 'assign', wide: true, ...extra });
}

async function membersPage(ctx, member, status, data = {}) {
  const body = membersBody(ctx.html, { members: await ctx.members.list(), canInvite: member.role === 'owner', selfId: member.id, ...data });
  return page(ctx, member, status, body, TEXT.membersTitle, TEXT.membersHelp);
}

async function formPage(ctx, member, status, bid, values, error = null) {
  const members = await ctx.members.list();
  const item = await getItem(ctx.db, bid.bidId, ctx.members);
  const body = formBody(ctx.html, { bid, members, values, item, error, today: ctx.today() });
  return page(ctx, member, status, body);
}

export function registerRoutes(router, ctx) {
  router.get(
    '/assign',
    ctx.auth.required(async (req, params, c, member) => {
      const members = await ctx.members.list();
      const body = boardBody(ctx.html, { groups: groupByStatus(await listItems(ctx.db, ctx.members)), members, today: ctx.today(), example: Boolean(ctx.demo) });
      return page(ctx, member, 200, body, MENU.title, MENU.help, { actions: boardActions(ctx.html, members) });
    }),
  );

  // '/assign/members' 는 '/assign/:bidId' 보다 먼저 등록한다 (먼저 등록한 것이 이긴다)
  router.get(
    '/assign/members',
    ctx.auth.required((req, params, c, member) => membersPage(ctx, member, 200)),
  );

  router.post(
    '/assign/members',
    ctx.auth.required(async (req, params, c, member) => {
      if (member.role !== 'owner') {
        return membersPage(ctx, member, 403, { error: { message: TEXT.ownerOnly, next: TEXT.ownerOnlyNext } });
      }
      const form = await readForm(req);
      const name = String(form.get('name') ?? '').trim();
      if (!name) return membersPage(ctx, member, 400, { error: { message: TEXT.noName, next: TEXT.noNameNext } });
      let created;
      try {
        created = await ctx.members.create({ name, role: 'staff' });
      } catch (err) {
        if (err && err.code === 'MEMBER_LIMIT') {
          return membersPage(ctx, member, 400, { name, error: { message: TEXT.limit, next: TEXT.limitNext } });
        }
        if (err && err.code === 'PLAN_LIMIT') {
          return membersPage(ctx, member, 400, { name, error: { message: err.message, next: '' } });
        }
        if (err && err.code === 'MEMBER_NAME') {
          return membersPage(ctx, member, 400, { error: { message: TEXT.noName, next: TEXT.noNameNext } });
        }
        ctx.log('assign', `member create failed: ${err && err.message ? err.message : String(err)}`);
        return membersPage(ctx, member, 500, { name, error: { message: TEXT.inviteFailed, next: TEXT.inviteFailedNext } });
      }
      const link = inviteUrl(ctx.env && ctx.env.APP_BASE_URL, new URL(req.url).origin, created.inviteToken);
      ctx.log('assign', `member ${created.member.id} invited`);
      return membersPage(ctx, member, 200, { created: { name: created.member.name, link } });
    }),
  );

  router.post(
    '/assign/members/:id/remove',
    ctx.auth.required(async (req, params, c, member) => {
      if (member.role !== 'owner') {
        return membersPage(ctx, member, 403, { error: { message: TEXT.removeOwnerOnly, next: TEXT.removeOwnerOnlyNext } });
      }
      const target = /^\d+$/.test(String(params.id)) ? await ctx.members.get(Number(params.id)) : null;
      if (!target) return membersPage(ctx, member, 404, { error: { message: TEXT.removeNotFound, next: TEXT.removeNotFoundNext } });
      if (target.id === Number(member.id)) {
        return membersPage(ctx, member, 400, { error: { message: TEXT.removeSelf, next: TEXT.removeSelfNext } });
      }
      if (target.role === 'owner') {
        return membersPage(ctx, member, 400, { error: { message: TEXT.removeOwner, next: TEXT.removeOwnerNext } });
      }
      try {
        await ctx.members.remove(target.id);
      } catch (err) {
        const code = err && err.code;
        if (code === 'FORBIDDEN') {
          return membersPage(ctx, member, 403, { error: { message: TEXT.removeOwnerOnly, next: TEXT.removeOwnerOnlyNext } });
        }
        if (code === 'CANNOT_REMOVE_SELF') {
          return membersPage(ctx, member, 400, { error: { message: TEXT.removeSelf, next: TEXT.removeSelfNext } });
        }
        if (code === 'CANNOT_REMOVE_OWNER') {
          return membersPage(ctx, member, 400, { error: { message: TEXT.removeOwner, next: TEXT.removeOwnerNext } });
        }
        ctx.log('assign', `member remove failed: ${err && err.message ? err.message : String(err)}`);
        return membersPage(ctx, member, 500, { error: { message: TEXT.removeFailed, next: TEXT.removeFailedNext } });
      }
      ctx.log('assign', `member ${target.id} removed`);
      return membersPage(ctx, member, 200, { removed: { name: target.name } });
    }),
  );

  router.get(
    '/assign/:bidId',
    ctx.auth.required(async (req, params, c, member) => {
      const bid = await ctx.bids.get(params.bidId);
      if (!bid) return page(ctx, member, 404, notFoundBody(ctx.html));
      const item = await getItem(ctx.db, bid.bidId, ctx.members);
      const values = item
        ? { assignee: item.assigneeId === null ? '' : String(item.assigneeId), status: item.status, note: item.note }
        : { assignee: String(member.id), status: 'review', note: '' };
      return formPage(ctx, member, 200, bid, values);
    }),
  );

  router.post(
    '/assign/:bidId',
    ctx.auth.required(async (req, params, c, member) => {
      const bid = await ctx.bids.get(params.bidId);
      if (!bid) return page(ctx, member, 404, notFoundBody(ctx.html));
      const form = await readForm(req);
      const values = {
        assignee: String(form.get('assignee') ?? '').trim(),
        status: String(form.get('status') ?? '').trim(),
        note: String(form.get('note') ?? '').trim().slice(0, NOTE_MAX),
      };
      if (!isStatus(values.status)) {
        return formPage(ctx, member, 400, bid, values, { message: TEXT.badStatus, next: TEXT.badStatusNext });
      }
      const assignee = /^\d+$/.test(values.assignee) ? await ctx.members.get(Number(values.assignee)) : null;
      if (!assignee) {
        return formPage(ctx, member, 400, bid, values, { message: TEXT.badAssignee, next: TEXT.badAssigneeNext });
      }
      await saveItem(ctx.db, {
        bidId: bid.bidId,
        assigneeId: assignee.id,
        status: values.status,
        note: values.note,
        updatedAt: ctx.now().toISOString(),
        updatedBy: member.id,
      });
      return ctx.html.redirect('/assign');
    }),
  );
}
