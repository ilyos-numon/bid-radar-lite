// 내 회사: 회사 정보 폼(누구나 저장)과 공고별 판정 목록
import { MENU, TEXT, LABEL, companyBody } from './view.mjs';
import { createService, readProfileForm, LIMITS } from './service.mjs';

const ERROR_TEXT = {
  needLicense: TEXT.needLicense,
  nameTooLong: TEXT.nameTooLong(LIMITS.name),
  licenseTooLong: TEXT.itemTooLong(LABEL.licenses, LIMITS.item),
  regionTooLong: TEXT.itemTooLong(LABEL.regions, LIMITS.item),
  licensesTooMany: TEXT.tooMany(LABEL.licenses, LIMITS.items),
  regionsTooMany: TEXT.tooMany(LABEL.regions, LIMITS.items),
};

function valuesOf(profile, fallbackName) {
  return {
    name: profile ? profile.name : fallbackName || '',
    licenses: profile ? profile.licenses.join(', ') : '',
    regions: profile ? profile.regions.join(', ') : '',
    smallBusiness: profile ? profile.smallBusiness : false,
  };
}

async function readForm(req) {
  try {
    return await req.formData();
  } catch {
    return new FormData();
  }
}

export function registerRoutes(router, ctx) {
  const svc = createService(ctx);

  async function page(member, { values, errors = [], saved = false }, status = 200) {
    const profile = await svc.getProfile();
    const items = [];
    if (!svc.isEmpty(profile)) {
      for (const bid of await svc.latestBids()) items.push({ bid, verdict: await svc.getVerdict(bid.bidId) });
    }
    const body = companyBody(ctx.html, { profile, values, errors, saved, items });
    return ctx.html.page(status, { title: MENU.title, help: MENU.help, body, member, active: 'company' });
  }

  router.get(
    '/company',
    ctx.auth.required(async (req, params, c, member) => {
      const saved = new URL(req.url).searchParams.get('saved') === '1';
      return page(member, { values: valuesOf(await svc.getProfile(), await ctx.settings.get('company_name')), saved });
    }),
  );

  router.post(
    '/company',
    ctx.auth.required(async (req, params, c, member) => {
      const form = await readForm(req);
      const values = {
        name: String(form.get('name') ?? ''),
        licenses: String(form.get('licenses') ?? ''),
        regions: String(form.get('regions') ?? ''),
        smallBusiness: form.get('smallBusiness') !== null && String(form.get('smallBusiness')) !== '',
      };
      const { profile, errors } = readProfileForm(values);
      if (errors.length > 0) return page(member, { values, errors: errors.map((e) => ERROR_TEXT[e] ?? e) }, 400);
      await svc.saveProfile(profile);
      // 바뀐 회사 정보로 최근 공고를 다시 판정한다 (실패한 공고는 건너뜀)
      await svc.judgeMany(await svc.latestBids());
      return ctx.html.redirect('/company?saved=1');
    }),
  );
}
