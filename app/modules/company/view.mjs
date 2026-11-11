// 내 회사 화면. 화면에 나가는 글자(판정 근거 문장 포함)는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).

export const MENU = {
  title: '내 회사',
  help: '회사 정보를 한 번 적어 두면 공고마다 참가 가능 여부를 근거와 함께 확인합니다.',
};

/** 판정 값 → 화면 문구 */
export const VERDICT_LABEL = { ok: '참가 가능', check: '확인 필요', no: '불가' };

/** 판정 근거 문장. 판정 규칙은 service.mjs, 문장은 여기 */
export const REASON = {
  regionMismatch: (limit) => `참가 지역 제한 '${limit}' · 회사 소재지 해당 없음`,
  ourRegions: (regions) => `회사 소재지: ${regions.join(', ')}`,
  regionUnknown: (limit) => `참가 지역 제한 '${limit}' · 회사 소재지를 적지 않아 확인하지 못했습니다`,
  noRequirements: '공고문에서 자격 요건을 확인하지 못했습니다',
  noLicenseFound: '공고문에서 필요 면허를 찾지 못했습니다. 원문에서 직접 확인해 주세요',
  licenseHeld: (license, quote) => (quote ? `필요 면허 '${license}' 보유 · 원문: "${quote}"` : `필요 면허 '${license}' 보유`),
  licenseMissing: (license) => `필요 면허 '${license}' 가 회사 정보에 없음`,
  licenseHeldStructured: (license) => `필요 면허 '${license}' 보유 (공고 면허제한)`,
  smeOnly: '중소기업만 참가할 수 있는 공고',
  regionUnclear: (limit) => `참가 지역 제한 '${limit}' · 회사 소재지와 맞는지 확인하지 못했습니다`,
  regionSubdivision: (raw) => `참가 가능 지역이 시군구 단위로 제한됨: ${raw}`,
  textRegion: (limit) => `공고문에 참가 지역 제한 '${limit}' 이 보입니다 · 원문에서 직접 확인해 주세요`,
  other: (item) => `그 밖의 조건: ${item}`,
};

/** 판정 기준: 저장되는 마지막 근거 줄과 화면 표기 */
export const BASIS = {
  structured: { line: '기준: 공고 면허제한', label: '공고 면허제한 기준' },
  text: { line: '기준: 공고문 해석', label: '공고문 해석 기준' },
};

/** 저장된 마지막 근거 줄 → 기준 값 (없으면 null) */
export function basisOfLine(line) {
  for (const [key, b] of Object.entries(BASIS)) if (b.line === line) return key;
  return null;
}

/** 알림 한 줄. 기준이 있으면 끝에 붙인다 */
export function notifyLine(verdict, firstReason, basis = null) {
  const label = VERDICT_LABEL[verdict] ?? VERDICT_LABEL.check;
  const line = firstReason ? `자격: ${label} — ${firstReason}` : `자격: ${label}`;
  return BASIS[basis] ? `${line} · ${BASIS[basis].label}` : line;
}

export const TEXT = {
  emptyMessage: '회사 정보를 적으면 공고마다 참가 가능 여부를 확인합니다.',
  emptyLink: '회사 정보 적기',
  formTitle: '회사 정보',
  formHelp: '회사 정보를 저장해 두면 공고마다 참가 가능 여부를 자동으로 확인합니다.',
  licensesPending: '보유 면허를 적기 전에는 판정하지 않고, 모든 공고가 확인 필요로 남습니다.',
  emptyField: '비어 있음',
  saveButton: '저장',
  saveBusy: '저장하는 중…',
  saved: '저장했습니다. 최근 공고를 새 정보로 다시 판정했습니다.',
  notSaved: '저장하지 않았습니다',
  notSavedNext: '아래 내용을 고친 뒤 다시 저장해 주세요',
  needLicense: '보유 면허를 하나 이상 적어 주세요. 예: 조경식재공사업',
  nameTooLong: (max) => `회사 이름은 ${max}자까지 적을 수 있습니다.`,
  itemTooLong: (label, max) => `${label}은 하나에 ${max}자까지 적을 수 있습니다.`,
  tooMany: (label, max) => `${label}은 ${max}개까지 적을 수 있습니다.`,
  listTitle: '공고별 판정',
  caution: '자동 판정이라 틀릴 수 있습니다. 입찰 전 공고 원문을 꼭 확인하세요.',
  listEmpty: '아직 판정한 공고가 없습니다. 오늘의 공고에서 공고를 가져오면 여기에 판정이 나옵니다.',
  goToday: '오늘의 공고 보기',
  notJudged: '아직 판정하지 않았습니다',
  original: '원문 보기',
};

export const LABEL = {
  name: '회사 이름',
  licenses: '보유 면허',
  licensesHint: '쉼표로 나눠 적습니다. 예: 조경식재공사업, 조경시설물설치공사업',
  regions: '지역',
  regionsHint: '회사가 있는 곳을 쉼표로 나눠 적습니다. 예: 경기, 수원',
  smallBusiness: '중소기업입니다',
};

/** 판정 값 → 뱃지 뜻(kind). 모르는 값은 확인 필요로 본다 */
export function verdictKind(verdict) {
  return Object.prototype.hasOwnProperty.call(VERDICT_LABEL, verdict) ? verdict : 'check';
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

function errorBox(h, errors) {
  if (!errors || errors.length === 0) return '';
  return h
    .error(TEXT.notSaved, TEXT.notSavedNext)
    .replace(/<\/div>$/, `<ul>${errors.map((e) => `<li>${h.esc(e)}</li>`).join('')}</ul></div>`);
}

/** 저장된 회사 정보 요약: 타일 4칸 (빈 칸은 비어 있음 표시) */
function profileSummary(h, profile) {
  const none = `<em style="font-style:normal;color:var(--ink-3)">${TEXT.emptyField}</em>`;
  const show = (list) => (list.length > 0 ? h.esc(list.join(', ')) : none);
  const tile = (dt, dd) =>
    `<div style="background:#F9FAFB;padding:14px 16px;display:flex;flex-direction:column;gap:2px"><dt style="font-size:13px;color:var(--ink-2)">${dt}</dt><dd style="margin:0;font-size:15px;font-weight:500">${dd}</dd></div>`;
  return `<dl class="tiles" style="margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1px;background:var(--divider);border:1px solid var(--divider);border-radius:12px;overflow:hidden">
${tile(LABEL.name, profile.name ? h.esc(profile.name) : none)}
${tile(LABEL.licenses, show(profile.licenses))}
${tile(LABEL.regions, show(profile.regions))}
${tile('중소기업', profile.smallBusiness ? '예' : '아니오')}
</dl>`;
}

/**
 * @param {object} h ctx.html
 * @param {{name:string, licenses:string, regions:string, smallBusiness:boolean}} values
 */
function profileForm(h, values) {
  const hint = (id, text) => `<span id="${id}-hint">${h.esc(text)}</span>`;
  return `<form class="stack" method="post" action="/company">
<label for="name">${LABEL.name}<input id="name" name="name" value="${h.esc(values.name)}"></label>
<label for="licenses">${LABEL.licenses}<input id="licenses" name="licenses" value="${h.esc(values.licenses)}" required aria-describedby="licenses-hint">${hint('licenses', LABEL.licensesHint)}</label>
<label for="regions">${LABEL.regions}<input id="regions" name="regions" value="${h.esc(values.regions)}" aria-describedby="regions-hint">${hint('regions', LABEL.regionsHint)}</label>
<label for="smallBusiness" style="display:flex;gap:10px;align-items:center;min-height:44px;font-size:15px;font-weight:500;cursor:pointer"><input id="smallBusiness" name="smallBusiness" type="checkbox" value="1" style="margin:0"${values.smallBusiness ? ' checked' : ''}>${LABEL.smallBusiness}</label>
<div><button type="submit" data-busy="${h.esc(TEXT.saveBusy)}">${TEXT.saveButton}</button></div>
</form>`;
}

function verdictCard(h, { bid, verdict }) {
  const url = safeUrl(bid.url);
  const chip = verdict
    ? h.badge({ label: VERDICT_LABEL[verdict.verdict] ?? VERDICT_LABEL.check, kind: verdictKind(verdict.verdict) })
    : h.badge({ label: TEXT.notJudged });
  const basis = verdict && BASIS[verdict.basis]
    ? `<p class="basis" style="margin:0;font-size:13px;color:var(--ink-2)">${BASIS[verdict.basis].label}</p>`
    : '';
  const reasons = verdict && verdict.reasons.length > 0
    ? `<ul class="reasons" style="margin:0;padding:0 0 0 1.2em;list-style:disc;background:none;border-radius:0;line-height:1.7;display:flex;flex-direction:column;gap:4px">${verdict.reasons.map((r) => `<li>${h.esc(r)}</li>`).join('')}</ul>`
    : '';
  const link = url
    ? `<a href="${h.esc(url)}" target="_blank" rel="noopener" style="font-weight:500;text-decoration:none">${TEXT.original}<span class="skip"> (${h.esc(bid.title)})</span> <span aria-hidden="true">↗</span></a>`
    : '';
  const facts = [bid.org ? h.esc(bid.org) : '', link].filter(Boolean).join(' · ');
  return `<li class="card" id="${h.esc(bid.bidId)}" style="padding:20px 24px;display:flex;flex-direction:column;gap:10px">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap">
<div style="display:flex;flex-direction:column;gap:2px;min-width:0">
<h3 class="title" style="margin:0;font-size:17px">${h.esc(bid.title)}</h3>
${facts ? `<p class="facts" style="margin:0">${facts}</p>` : ''}
</div>
${chip}
</div>
${basis}
${reasons}
</li>`;
}

function verdictList(h, items) {
  const head = `<section aria-labelledby="verdicts-title" style="display:flex;flex-direction:column;gap:14px">
<div style="display:flex;flex-direction:column;gap:10px">
<h2 id="verdicts-title" style="font-size:19px;margin:0">${TEXT.listTitle}</h2>
${h.notice(TEXT.caution, { kind: 'info' }).replace('class="notice info"', 'class="notice info" style="margin:0;font-weight:400"')}
</div>`;
  if (items.length === 0) {
    return `${head}${h.empty(TEXT.listEmpty, { href: '/today', label: TEXT.goToday })}</section>`;
  }
  return `${head}<ol style="list-style:none;margin:0;padding:0">${items.map((it) => verdictCard(h, it)).join('')}</ol></section>`;
}

/**
 * @param {object} h ctx.html
 * @param {{ profile: {name:string, licenses:string[], regions:string[], smallBusiness:boolean}|null, values: object, errors?: string[], saved?: boolean, items: Array<{bid:object, verdict:{verdict:string, reasons:string[]}|null}> }} data
 * @returns {string}
 */
export function companyBody(h, { profile, values, errors, saved, items }) {
  const parts = [];
  const empty = !profile || profile.licenses.length === 0;
  if (saved && !(errors && errors.length)) parts.push(h.notice(TEXT.saved, { kind: 'success', role: 'status' }));
  parts.push(errorBox(h, errors));
  if (empty) parts.push(h.empty(TEXT.emptyMessage, { href: '#profile', label: TEXT.emptyLink }));
  parts.push(`<section id="profile" class="card" aria-labelledby="profile-title" style="padding:28px;margin:0;display:flex;flex-direction:column;gap:20px">
<div style="display:flex;flex-direction:column;gap:4px">
<h2 id="profile-title" style="font-size:19px;margin:0">${TEXT.formTitle}</h2>
<p style="margin:0;font-size:14px;color:var(--ink-2)">${TEXT.formHelp}${empty ? ` ${TEXT.licensesPending}` : ''}</p>
</div>
${profile ? profileSummary(h, profile) : ''}
${profileForm(h, values)}
</section>`);
  if (!empty) parts.push(verdictList(h, items));
  return parts.filter(Boolean).join('\n');
}
