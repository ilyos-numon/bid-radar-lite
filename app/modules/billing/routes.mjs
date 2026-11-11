// 요금제: 상태·요금제 선택·카드 등록(토스 SDK)·해지/재개. 바꾸는 일은 대표만
import { accessOf } from '../../core/billing/access.mjs';
import { planOf } from '../../core/billing/plans.mjs';
import { MENU, TEXT, billingBody, cardBody, cardFailBody, ownerOnlyBody, rejectBody } from './view.mjs';
import { ymd, isPaidPlan, safeCode, originOf, chargeNow } from './service.mjs';

async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

const isOwner = (member) => Boolean(member) && member.role === 'owner';

export function registerRoutes(router, ctx) {
  const b = () => ctx.billing;
  const page = (status, member, body, title = MENU.title, help = MENU.help) => ctx.html.page(status, { title, help, body, member, active: 'billing' });
  const ownerOnly = (member) => (isOwner(member) ? null : page(403, member, ownerOnlyBody(ctx.html)));
  const deps = () => ({ store: b().store, toss: b().toss, vault: b().vault, now: ctx.now });

  async function screen(member, extra = {}, status = 200) {
    const { store, toss, workspaceId } = b();
    const sub = await store.ensure(workspaceId);
    const payments = await store.listPayments(workspaceId, { limit: 12 });
    const access = accessOf(sub, ctx.now());
    const view = { ...sub, nextDate: ymd(sub.nextChargeAt || sub.currentPeriodEnd), periodDate: ymd(sub.currentPeriodEnd) };
    const body = billingBody(ctx.html, { sub: view, access, payments, tossReady: Boolean(toss.enabled), canEdit: isOwner(member), ymd, ...extra });
    return page(status, member, body);
  }

  router.get(
    '/billing',
    ctx.auth.required(async (req, params, c, member) => {
      const sp = new URL(req.url).searchParams;
      const sub = await b().store.get(b().workspaceId);
      const planName = planOf(sub?.plan)?.name ?? '';
      let notice = '';
      let error = null;
      if (sp.get('charge') === 'failed') error = { message: TEXT.chargeFailed, next: TEXT.chargeFailedNext };
      else if (sp.get('charge') === 'paid') notice = TEXT.paid;
      else if (sp.get('card') === '1') notice = TEXT.cardSaved;
      else if (sp.get('plan') === 'nocard') notice = TEXT.savedPlanNoCard(planName);
      else if (sp.get('plan') === '1') notice = TEXT.savedPlan(planName);
      else if (sp.get('canceled') === '1') notice = TEXT.canceled;
      else if (sp.get('resumed') === '1') notice = TEXT.resumed;
      return screen(member, { locked: sp.get('locked') === '1', notice, error });
    }),
  );

  router.post(
    '/billing/plan',
    ctx.auth.required(async (req, params, c, member) => {
      const denied = ownerOnly(member);
      if (denied) return denied;
      const plan = String((await readForm(req)).get('plan') ?? '');
      if (!isPaidPlan(plan)) return screen(member, { error: { message: TEXT.badPlan, next: TEXT.badPlanNext } }, 400);
      const { store, workspaceId } = b();
      const sub = await store.update(workspaceId, { plan });
      if (!sub.cardSummary) return ctx.html.redirect('/billing?plan=nocard');
      if (sub.status === 'active') return ctx.html.redirect('/billing?plan=1');
      const r = await chargeNow(deps(), sub);
      return ctx.html.redirect(r === 'paid' ? '/billing?charge=paid' : '/billing?charge=failed');
    }),
  );

  router.get(
    '/billing/card',
    ctx.auth.required(async (req, params, c, member) => {
      const denied = ownerOnly(member);
      if (denied) return denied;
      const { store, toss, workspaceId, env } = b();
      if (!toss.enabled) return page(200, member, cardBody(ctx.html, { ready: false }), TEXT.cardPageTitle, TEXT.cardPageHelp);
      const sub = await store.ensure(workspaceId);
      const origin = originOf(env, req);
      const body = cardBody(ctx.html, {
        ready: true,
        clientKey: toss.clientKey,
        customerKey: sub.customerKey,
        successUrl: `${origin}/billing/card/success`,
        failUrl: `${origin}/billing/card/fail`,
      });
      return page(200, member, body, TEXT.cardPageTitle, TEXT.cardPageHelp);
    }),
  );

  router.get(
    '/billing/card/success',
    ctx.auth.required(async (req, params, c, member) => {
      const denied = ownerOnly(member);
      if (denied) return denied;
      const sp = new URL(req.url).searchParams;
      const customerKey = sp.get('customerKey') ?? '';
      const authKey = sp.get('authKey') ?? '';
      const { store, toss, vault, workspaceId } = b();
      const sub = await store.ensure(workspaceId);
      if (!customerKey || customerKey !== sub.customerKey) {
        return page(403, member, rejectBody(ctx.html, TEXT.mismatch, TEXT.mismatchNext), TEXT.cardPageTitle);
      }
      if (!authKey) return page(400, member, rejectBody(ctx.html, TEXT.noAuth, TEXT.noAuthNext), TEXT.cardPageTitle);
      const issued = await toss.issueBillingKey({ authKey, customerKey });
      if (!issued.ok) {
        ctx.log('billing', `issue billing key failed: ${safeCode(issued.code)}`);
        return page(400, member, cardFailBody(ctx.html, safeCode(issued.code)), TEXT.cardPageTitle);
      }
      await vault.setKey(workspaceId, issued.billingKey);
      const updated = await store.setCard(workspaceId, { cardSummary: issued.cardSummary });
      if (updated.status === 'past_due' || updated.status === 'expired') {
        const r = await chargeNow(deps(), updated);
        return ctx.html.redirect(r === 'paid' ? '/billing?card=1&charge=paid' : '/billing?card=1&charge=failed');
      }
      return ctx.html.redirect('/billing?card=1');
    }),
  );

  router.get(
    '/billing/card/fail',
    ctx.auth.required(async (req, params, c, member) => {
      const code = safeCode(new URL(req.url).searchParams.get('code'));
      return page(400, member, cardFailBody(ctx.html, code), TEXT.cardPageTitle);
    }),
  );

  for (const [path, cancel, flag] of [
    ['/billing/cancel', true, 'canceled'],
    ['/billing/resume', false, 'resumed'],
  ]) {
    router.post(
      path,
      ctx.auth.required(async (req, params, c, member) => {
        const denied = ownerOnly(member);
        if (denied) return denied;
        await b().store.update(b().workspaceId, { cancelAtPeriodEnd: cancel });
        return ctx.html.redirect(`/billing?${flag}=1`);
      }),
    );
  }
}
