// 알림 설정: 조건·알림 받을 곳 저장, 오늘 것 미리보기 (기록 없이 일일 잡 실행)
import { MENU, TEXT, MAIL_PREVIEW, settingsBody, ownerOnlyBody, valuesFrom, mailPreviewBody } from './view.mjs';
import { NOTIFY_EMAILS_KEY, parseEmails, renderDigestEmail } from '../../core/email.mjs';
import { blockedResponse } from '../../core/demo/guard.mjs';

/** 요금제 한도가 없을 때(기존 모드) 알림 이메일 상한 */
const DEFAULT_MAX_EMAILS = 5;

const errText = (err) => (err && err.message ? err.message : String(err));

function splitList(s) {
  return String(s ?? '')
    .split(/[,，、\n]/)
    .map((x) => x.trim())
    .filter((x) => x !== '');
}

/** '30,000,000' → 30000000. 비었거나 숫자가 아니면 NaN */
function toAmount(s) {
  const v = String(s ?? '').replace(/[\s,원]/g, '');
  if (!/^\d+$/.test(v)) return Number.NaN;
  return Number(v);
}

function isFirst(req) {
  return new URL(req.url).searchParams.get('first') === '1';
}

async function currentValues(ctx) {
  return valuesFrom({
    criteria: await ctx.criteria.get(),
    webhook: await ctx.settings.get('notify_webhook_url'),
    emails: await ctx.settings.get(NOTIFY_EMAILS_KEY),
  });
}

/** 이메일 칸 안내: 발송 준비 여부와 요금제 상한 */
async function emailInfo(ctx) {
  const ready = Boolean(String((ctx.env && ctx.env.EMAIL_API_KEY) ?? '').trim());
  let max = DEFAULT_MAX_EMAILS;
  if (ctx.limits && typeof ctx.limits.max === 'function') max = await ctx.limits.max('emails');
  return { ready, max };
}

/** 저장할 이메일 수 검사 → null | 오류 문구 */
async function checkEmailCount(ctx, n) {
  if (n === 0) return null;
  if (ctx.limits && typeof ctx.limits.check === 'function') {
    const r = await ctx.limits.check('emails', n);
    return r && r.ok === false ? String(r.message ?? TEXT.emailsTooMany(r.max)) : null;
  }
  return n > DEFAULT_MAX_EMAILS ? TEXT.emailsTooMany(DEFAULT_MAX_EMAILS) : null;
}

async function page(ctx, member, data, status = 200) {
  const body = settingsBody(ctx.html, { canEdit: member.role === 'owner', email: await emailInfo(ctx), ...data });
  return ctx.html.page(status, { title: MENU.title, help: MENU.help, body, member, active: 'settings' });
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

async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

export function registerRoutes(router, ctx) {
  router.get(
    '/settings',
    ctx.auth.required(async (req, params, c, member) => {
      const url = new URL(req.url);
      return page(ctx, member, {
        values: await currentValues(ctx),
        first: isFirst(req),
        saved: url.searchParams.get('saved') === '1',
      });
    }),
  );

  router.post(
    '/settings',
    ctx.auth.required(async (req, params, c, member) => {
      if (member.role !== 'owner') {
        return ctx.html.page(403, { title: MENU.title, help: MENU.help, body: ownerOnlyBody(ctx.html), member, active: 'settings' });
      }
      const first = isFirst(req);
      const form = await readForm(req);
      const values = {
        keywords: String(form.get('keywords') ?? ''),
        regions: String(form.get('regions') ?? ''),
        excludeKeywords: String(form.get('excludeKeywords') ?? ''),
        budgetMin: String(form.get('budgetMin') ?? ''),
        budgetMax: String(form.get('budgetMax') ?? ''),
        webhook: String(form.get('webhookUrl') ?? '').trim(),
        emails: String(form.get('notifyEmails') ?? ''),
      };
      const emails = parseEmails(values.emails);
      // 예시 회사: 알림 받을 주소는 바꿀 수 없다 (조건 변경은 그대로 저장)
      if (ctx.demo) {
        const savedHook = String((await ctx.settings.get('notify_webhook_url')) ?? '').trim();
        const savedEmails = parseEmails(await ctx.settings.get(NOTIFY_EMAILS_KEY)).join(',');
        if (values.webhook !== savedHook || emails.join(',') !== savedEmails) return blockedResponse(req, ctx.html);
      }
      const current = await ctx.criteria.get();
      const next = {
        keywords: splitList(values.keywords),
        regions: splitList(values.regions),
        excludeKeywords: splitList(values.excludeKeywords),
        budgetMin: toAmount(values.budgetMin),
        budgetMax: toAmount(values.budgetMax),
        maxItems: Number.isInteger(current.maxItems) ? current.maxItems : 5,
      };

      const errors = [];
      const reversed = Number.isFinite(next.budgetMin) && Number.isFinite(next.budgetMax) && next.budgetMin > next.budgetMax;
      if (reversed) errors.push(TEXT.budgetReversed);
      // 예산 순서 오류는 위 문구 하나로만 보여 준다
      const coreErrors = ctx.criteria.validate(next).filter((e) => !(reversed && e.includes('최소 예산') && e.includes('최대 예산')));
      errors.push(...coreErrors);
      if (values.webhook !== '') {
        let ok = false;
        try {
          const u = new URL(values.webhook);
          ok = u.protocol === 'http:' || u.protocol === 'https:';
        } catch {
          ok = false;
        }
        if (!ok) errors.push(TEXT.badWebhook);
        else if (typeof ctx.checkUrl === 'function') {
          // 알림 받을 곳이 내부 네트워크 주소면 저장하지 않는다
          const checked = await ctx.checkUrl(values.webhook);
          if (!checked.ok && checked.code === 'SSRF_BLOCKED') errors.push(checked.message);
        }
      }

      const emailError = await checkEmailCount(ctx, emails.length);
      if (emailError) errors.push(emailError);

      if (errors.length > 0) return page(ctx, member, { values, first, saved: false, errors }, 400);

      const saveErrors = await ctx.criteria.set(next);
      if (saveErrors.length > 0) return page(ctx, member, { values, first, saved: false, errors: saveErrors }, 400);
      await ctx.settings.set('notify_webhook_url', values.webhook);
      await ctx.settings.set(NOTIFY_EMAILS_KEY, emails.join(','));
      return ctx.html.redirect(first ? '/settings?first=1&saved=1' : '/settings?saved=1');
    }),
  );

  router.post(
    '/settings/preview',
    ctx.auth.required(async (req, params, c, member) => {
      const form = await readForm(req);
      const first = String(form.get('first') ?? '') === '1' || isFirst(req);
      const today = ctx.today();
      let preview;
      try {
        const notification = await ctx.jobs.runDaily({ date: today, dry: true });
        const failed = await allSourcesFailed(ctx);
        preview =
          failed !== null
            ? { notification: null, today, error: failed ? { message: failed, next: '' } : { message: TEXT.fetchFailed, next: TEXT.previewFailedNext } }
            : { notification: { ...notification, text: ctx.notify.render(notification) }, today, error: null };
      } catch (err) {
        ctx.log('settings', `preview failed: ${errText(err)}`);
        preview = { notification: null, today, error: { message: TEXT.previewFailed, next: TEXT.previewFailedNext } };
      }
      return page(ctx, member, { values: await currentValues(ctx), first, saved: false, preview });
    }),
  );

  // 오늘 보낼 알림 메일: 잡을 dry 로 돌려 메일 제목·본문만 만든다 (보내지 않고 기록도 남기지 않는다)
  router.get(
    '/settings/mail-preview',
    ctx.auth.required(async (req, params, c, member) => {
      const kinds = [
        ['bids', 'runDaily', MAIL_PREVIEW.kinds.bids],
        ['reminder', 'runReminders', MAIL_PREVIEW.kinds.reminder],
        ['support', 'runSupport', MAIL_PREVIEW.kinds.support],
      ];
      const date = ctx.today();
      const appUrl = ctx.env ? ctx.env.APP_BASE_URL : undefined;
      const sections = [];
      for (const [kind, fn, label] of kinds) {
        let payload = null;
        try {
          const run = ctx.jobs ? ctx.jobs[fn] : undefined;
          payload = typeof run === 'function' ? await run({ date, dry: true }) : null;
        } catch (err) {
          ctx.log('settings', `mail preview ${kind} failed: ${errText(err)}`);
          payload = null;
        }
        const empty = !payload || payload.count === 0;
        const mail = empty ? null : renderDigestEmail({ kind, date, text: payload, appUrl });
        sections.push({ kind, label, mail: mail ? { subject: mail.subject, html: mail.html } : null });
      }
      const to = parseEmails(await ctx.settings.get(NOTIFY_EMAILS_KEY));
      const body = mailPreviewBody(ctx.html, { to, sections });
      return ctx.html.page(200, { title: MAIL_PREVIEW.title, help: MAIL_PREVIEW.help, body, member, active: 'settings' });
    }),
  );
}
