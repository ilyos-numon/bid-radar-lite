// 알림 설정 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).
import { formatBudget } from '../../../src/match.js';

export const MENU = {
  title: '알림 설정',
  help: '업종 키워드 · 지역 · 예산과 알림 받을 곳을 정하고 오늘 것을 미리 봅니다.',
};

export const TEXT = {
  firstNotice: '내일 아침부터 알림이 갑니다. 조건을 저장하면 오늘 것을 바로 미리 볼 수 있습니다.',
  stepsLabel: '시작 안내',
  steps: ['조건 저장', '오늘 것 미리보기', '오늘의 공고로'],
  previewButton: '오늘 것 미리보기',
  previewBusy: '미리보기 만드는 중…',
  saveButton: '저장',
  saveBusy: '저장하는 중…',
  saved: '저장했습니다.',
  ownerOnly: '대표만 조건을 바꿀 수 있습니다',
  ownerOnlyNext: '대표에게 요청해 주세요',
  ownerOnlyNotice: '조건은 대표만 바꿀 수 있습니다. 미리보기는 누구나 볼 수 있습니다.',
  budgetReversed: '예산 범위가 뒤바뀌었습니다. 최소 예산을 최대 예산보다 작게 적어 주세요.',
  badWebhook: '알림 받을 곳 주소가 올바르지 않습니다. http:// 또는 https:// 로 시작하는 주소를 적어 주세요.',
  notSaved: '저장하지 않았습니다',
  notSavedNext: '아래 내용을 고친 뒤 다시 저장해 주세요',
  previewFailed: '미리보기를 만들지 못했습니다',
  previewFailedNext: '잠시 뒤 오늘 것 미리보기를 다시 눌러 주세요',
  fetchFailed: '공고를 가져오지 못했습니다',
  previewTitle: '오늘 것 미리보기',
  previewCount: (n) => `오늘 알림에 들어갈 공고 ${n}건`,
  previewNone: '오늘은 알림에 들어갈 공고가 없습니다. 조건을 넓혀 보거나 내일 다시 확인해 주세요.',
  previewTextTitle: '알림으로 받을 글',
  previewNote: '미리보기는 알림을 보내지 않고 기록도 남기지 않습니다.',
  goToday: '오늘의 공고로 가기',
  maybeTitle: '관련 가능성 있음',
  fixedTime: '알림은 매일 아침 8시쯤 갑니다.',
  fixedTimeOff: '알림 예약 실행이 꺼져 있습니다.',
  emailNotReady: '이메일 발송이 준비되지 않았습니다(운영자 설정 필요)',
  emailsTooMany: (max) => `알림 이메일은 ${max}개까지입니다.`,
  mailPreviewLink: '오늘 보낼 메일 미리보기',
};

/** 오늘 보낼 메일 미리보기 화면 */
export const MAIL_PREVIEW = {
  title: '오늘 보낼 메일 미리보기',
  help: '오늘 알림 메일로 갈 내용을 보내지 않고 미리 봅니다.',
  kinds: { bids: '오늘의 공고', reminder: '마감 알림', support: '지원사업' },
  note: '미리보기는 메일을 보내지 않고 기록도 남기지 않습니다.',
  toLabel: '받는 사람',
  noRecipients: '받는 사람이 없습니다',
  subjectLabel: '제목',
  nothing: '보낼 내용 없음',
  frameTitle: (label) => `${label} 메일 본문`,
  back: '알림 설정으로',
};

const LABEL = {
  what: '어떤 공고를 받을까요',
  where: '어디로 알려 드릴까요',
  keywords: '업종 키워드',
  keywordsHint: '쉼표로 나눠 적습니다. 예: 조경, 수목, 공원',
  regions: '지역',
  regionsHint: '쉼표로 나눠 적습니다. 전국이면 비워 두세요. 예: 경기, 서울',
  budgetMin: '최소 예산 (원)',
  budgetMax: '최대 예산 (원)',
  budgetHint: '숫자만 적습니다. 입력 칸 아래에 읽기 쉬운 금액이 바로 보입니다.',
  budgetBasis: '예산은 추정가격 기준입니다 (없으면 기초금액, 배정예산 순)',
  excludeKeywords: '제외 키워드',
  excludeKeywordsHint: '제목에 이 말이 있으면 알림에서 뺍니다. 쉼표나 줄바꿈으로 나눠 적습니다. 예: 묘지, 납골',
  webhook: '알림 받을 곳',
  webhookHint: '알림을 받을 주소를 적습니다. 비워 두면 운영자가 정한 곳으로 갑니다.',
  emails: '알림 받을 이메일',
  emailsPlaceholder: 'boss@example.com, staff@example.com',
  emailsHint: (max) =>
    Number.isFinite(max) ? `쉼표로 나눠 적습니다. 요금제에 따라 ${max}개까지 받을 수 있습니다.` : '쉼표로 나눠 적습니다.',
};

function str(v) {
  return v === null || v === undefined ? '' : String(v);
}

/** 입력 칸 아래 읽기 쉬운 금액. 숫자가 없으면 '' (화면 스크립트와 같은 규칙) */
function amountHint(v) {
  const digits = String(v ?? '').replace(/[^0-9]/g, '');
  return digits === '' ? '' : formatBudget(Number(digits));
}

/** 오류 문구 → 잘못된 입력 칸 id 목록 */
function invalidFields(errors) {
  const out = new Set();
  for (const e of errors || []) {
    const t = String(e);
    if (t === TEXT.budgetReversed || (t.includes('최소 예산이') && t.includes('최대 예산'))) {
      out.add('budgetMin');
      out.add('budgetMax');
    } else if (t.startsWith('최소 예산')) out.add('budgetMin');
    else if (t.startsWith('최대 예산')) out.add('budgetMax');
    else if (t.startsWith('업종 키워드')) out.add('keywords');
    else if (t.startsWith('지역')) out.add('regions');
    else if (t.startsWith('제외 키워드')) out.add('excludeKeywords');
    else if (t === TEXT.badWebhook || t.startsWith('알림 받을 곳')) out.add('webhookUrl');
    else if (t.startsWith('알림 이메일')) out.add('notifyEmails');
  }
  return out;
}

/** 지금 몇 번째 단계인지: 미리보기 결과 있음 → 3, 저장함 → 2, 그 밖 → 1 */
function stepOf({ step, saved, preview }) {
  if (step === 1 || step === 2 || step === 3) return step;
  if (preview) return 3;
  if (saved) return 2;
  return 1;
}

function stepsSection(h, current) {
  const circle = 'width:26px;height:26px;border-radius:50%;font-size:13px;display:flex;align-items:center;justify-content:center';
  const items = TEXT.steps.map((label, i) => {
    const n = i + 1;
    if (n === current) {
      return `<li aria-current="step" style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700;color:var(--primary)"><span aria-hidden="true" style="${circle};background:var(--primary);color:#FFFFFF">${n}</span>${label}</li>`;
    }
    if (n < current) {
      return `<li style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;color:var(--primary)"><span aria-hidden="true" style="${circle};background:var(--primary-soft);color:var(--primary)">${h.icon('check-circle', { size: 16 })}</span>${label}</li>`;
    }
    return `<li style="display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500;color:var(--ink-2)"><span aria-hidden="true" style="${circle};border:1.5px solid #B0B8C1;color:var(--ink-2)">${n}</span>${label}</li>`;
  });
  const line = '<li aria-hidden="true" style="width:32px;height:1px;background:var(--hairline)"></li>';
  return `<section class="notice steps" aria-label="${TEXT.stepsLabel}" style="background:var(--surface);border:1px solid var(--primary-line);border-radius:16px;padding:22px 24px;display:flex;flex-direction:column;gap:16px;margin:0">
<p style="margin:0;font-size:15px;font-weight:500;color:var(--ink)">${TEXT.firstNotice}</p>
<ol style="list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px">${items.join(line)}</ol>
</section>`;
}

/**
 * @param {object} h ctx.html
 * @param {{ values: {keywords:string, regions:string, excludeKeywords?:string, budgetMin:string, budgetMax:string, webhook:string, emails?:string}, canEdit: boolean, first: boolean, saved: boolean, errors?: string[], email?: {ready:boolean, max:number} }} data
 */
function settingsForm(h, { values, canEdit, first, errors, email }) {
  const action = first ? '/settings?first=1' : '/settings';
  const bad = invalidFields(errors);
  const invalid = (id) => (bad.has(id) ? ' aria-invalid="true"' : '');
  const hintStyle = 'font-size:13px;font-weight:400;color:var(--ink-2)';
  const amountStyle = 'font-size:13px;font-weight:500;color:var(--primary);min-height:1.6em;font-variant-numeric:tabular-nums';
  const field = (id, label, input, hint) =>
    `<label for="${id}">${h.esc(label)}${input}${hint ? `<span id="${id}-hint" style="${hintStyle}">${h.esc(hint)}</span>` : ''}</label>`;
  const describe = (id, hint) => (hint ? ` aria-describedby="${id}-hint"` : '');
  const amountField = (id, label) =>
    `<label for="${id}" style="flex:1 1 200px">${h.esc(label)}<input id="${id}" name="${id}" inputmode="numeric" value="${h.esc(values[id])}" required data-amount-hint="${id}-hint" aria-describedby="${id}-hint budget-note"${invalid(id)} style="font-variant-numeric:tabular-nums"><span id="${id}-hint" style="${amountStyle}">${h.esc(amountHint(values[id]))}</span></label>`;
  const disabled = canEdit ? '' : ' disabled';
  return `<form class="stack card" method="post" action="${h.esc(action)}" style="max-width:none;padding:clamp(16px,4vw,28px);gap:28px;margin:0">
${first ? '<input type="hidden" name="first" value="1">' : ''}
<fieldset${disabled} style="display:grid;gap:18px">
<legend style="margin-bottom:18px">${LABEL.what}</legend>
${field('keywords', LABEL.keywords, `<input id="keywords" name="keywords" value="${h.esc(values.keywords)}" required${describe('keywords', LABEL.keywordsHint)}${invalid('keywords')}>`, LABEL.keywordsHint)}
${field('regions', LABEL.regions, `<input id="regions" name="regions" value="${h.esc(values.regions)}"${describe('regions', LABEL.regionsHint)}${invalid('regions')}>`, LABEL.regionsHint)}
<div style="display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px 16px">
${amountField('budgetMin', LABEL.budgetMin)}
<span aria-hidden="true" style="padding-top:38px;color:var(--muted-dot)">~</span>
${amountField('budgetMax', LABEL.budgetMax)}
</div>
<p id="budget-note" style="margin:-8px 0 0;font-size:13px;color:var(--ink-2)">${LABEL.budgetHint}</p>
<p id="budget-basis" style="margin:-8px 0 0;font-size:13px;color:var(--ink-2)">${LABEL.budgetBasis}</p>
${field('excludeKeywords', LABEL.excludeKeywords, `<textarea id="excludeKeywords" name="excludeKeywords" rows="3"${describe('excludeKeywords', LABEL.excludeKeywordsHint)}${invalid('excludeKeywords')}>${h.esc(values.excludeKeywords ?? '')}</textarea>`, LABEL.excludeKeywordsHint)}
</fieldset>
<div aria-hidden="true" style="height:1px;background:var(--divider)"></div>
<fieldset${disabled} style="display:grid;gap:18px">
<legend style="margin-bottom:18px">${LABEL.where}</legend>
${field('webhookUrl', LABEL.webhook, `<input id="webhookUrl" name="webhookUrl" type="url" inputmode="url" value="${h.esc(values.webhook)}" placeholder="https://"${describe('webhookUrl', LABEL.webhookHint)}${invalid('webhookUrl')}>`, LABEL.webhookHint)}
${emailField(h, values, email, invalid('notifyEmails'), hintStyle)}
<p style="margin:0;display:flex;align-items:center;gap:8px;padding:12px 16px;border-radius:10px;background:var(--reasons-bg);font-size:14px;color:var(--ink-body)">${h.icon('clock', { size: 18 })}${h.scheduleNote(TEXT.fixedTime, TEXT.fixedTimeOff)}</p>
</fieldset>
<div class="form-actions" style="display:flex;flex-wrap:wrap;align-items:center;gap:12px">
<button type="submit"${disabled} data-busy="${TEXT.saveBusy}">${TEXT.saveButton}</button>
<button type="submit" class="secondary" formaction="/settings/preview" formmethod="post" formnovalidate data-busy="${TEXT.previewBusy}">${TEXT.previewButton}</button>
<span style="font-size:13px;color:var(--ink-2)">${TEXT.previewNote}</span>
<a href="/settings/mail-preview" style="font-size:14px;font-weight:500">${TEXT.mailPreviewLink}</a>
</div>
</form>`;
}

/** 알림 받을 이메일 칸. email: { ready: boolean, max: number } (없으면 준비됨·5개) */
function emailField(h, values, email, invalidAttr, hintStyle) {
  const ready = email ? email.ready !== false : true;
  const max = email && email.max !== undefined ? email.max : 5;
  const hint = LABEL.emailsHint(max);
  const notReady = ready ? '' : `<span id="notifyEmails-ready" role="note" style="font-size:13px;font-weight:500;color:var(--ink-body)">${h.esc(TEXT.emailNotReady)}</span>`;
  return `<label for="notifyEmails">${h.esc(LABEL.emails)}<input id="notifyEmails" name="notifyEmails" inputmode="email" autocomplete="off" value="${h.esc(values.emails ?? '')}" placeholder="${h.esc(LABEL.emailsPlaceholder)}" aria-describedby="notifyEmails-hint${ready ? '' : ' notifyEmails-ready'}"${invalidAttr}><span id="notifyEmails-hint" style="${hintStyle}">${h.esc(hint)}</span>${notReady}</label>`;
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

function previewItem(h, item, today) {
  const url = safeUrl(item.url);
  const reasons = h.reasons(item.reasons);
  const when = h.dateTime(item.deadline);
  const left = h.dday(item.deadline, today);
  const facts = [h.esc(left.startsWith('D-') ? `마감 ${left}` : left)];
  if (when) facts.push(when);
  facts.push(`예산 ${h.esc(formatBudget(item.budget))}`);
  if (url) facts.push(`<a href="${h.esc(url)}" target="_blank" rel="noopener">원문 보기<span class="skip"> (${h.esc(item.title)})</span> <span aria-hidden="true">↗</span></a>`);
  return `<li class="card" style="display:flex;flex-direction:column;gap:10px">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px">
<strong class="title" style="min-width:0">${h.esc(item.title)}</strong>
${h.ddayChip(item.deadline, today)}
</div>
<p class="facts" style="margin:0">${facts.join(' · ')}</p>
${reasons ? `<p class="reasons">${reasons.replace(/^왜 추천:/, '<strong>왜 추천:</strong>')}</p>` : ''}
</li>`;
}

/**
 * @param {object} h
 * @param {{ notification: object|null, today: string, error?: {message:string, next:string}|null }} p
 */
function previewSection(h, { notification, today, error }) {
  const parts = [`<section aria-labelledby="preview-title" style="display:flex;flex-direction:column;gap:12px"><h2 id="preview-title" style="margin:8px 0 0;font-size:18px;font-weight:700">${TEXT.previewTitle}</h2>`];
  if (error) {
    parts.push(h.error(error.message, error.next));
  } else if (notification) {
    const items = Array.isArray(notification.items) ? notification.items : [];
    parts.push(h.notice(items.length > 0 ? TEXT.previewCount(items.length) : TEXT.previewNone, { kind: 'info', role: 'status' }));
    if (items.length > 0) {
      parts.push(`<ol style="list-style:none;margin:0;padding:0">${items.map((it) => previewItem(h, it, today)).join('')}</ol>`);
    }
    if (notification.maybe) {
      parts.push(`<h3 style="margin:4px 0 0;font-size:15px;color:var(--ink-body)">${TEXT.maybeTitle}</h3><ol style="list-style:none;margin:0;padding:0">${previewItem(h, notification.maybe, today)}</ol>`);
    }
    parts.push(`<h3 style="margin:4px 0 0;font-size:15px">${TEXT.previewTextTitle}</h3>
<pre class="card" style="white-space:pre-wrap;font:inherit;font-size:14px;margin:0">${h.esc(notification.text ?? '')}</pre>`);
  }
  parts.push(`<p style="margin:0"><a class="button secondary" href="/today">${TEXT.goToday}</a></p></section>`);
  return parts.join('\n');
}

/**
 * @param {object} h ctx.html
 * @param {{ values: object, canEdit: boolean, first: boolean, saved: boolean, errors?: string[], preview?: {notification: object|null, today: string, error?: object|null}|null, step?: 1|2|3 }} data
 */
export function settingsBody(h, data) {
  const parts = [];
  const hasErrors = Boolean(data.errors && data.errors.length);
  if (hasErrors) {
    parts.push(h.error(TEXT.notSaved, TEXT.notSavedNext).replace(/<\/div>$/, `<ul>${data.errors.map((e) => `<li>${h.esc(e)}</li>`).join('')}</ul></div>`));
  }
  if (data.first) parts.push(stepsSection(h, stepOf(data)));
  if (data.saved && !hasErrors) parts.push(h.notice(TEXT.saved, { kind: 'success', role: 'status' }));
  if (!data.canEdit) parts.push(h.notice(TEXT.ownerOnlyNotice, { kind: 'info' }));
  parts.push(settingsForm(h, data));
  if (data.preview) parts.push(previewSection(h, data.preview));
  return parts.join('\n');
}

function mailSection(h, { kind, label, mail }) {
  const head = `<h2 style="margin:0;font-size:17px;font-weight:700">${h.esc(label)}</h2>`;
  const inner = mail
    ? `<p class="subject" style="margin:0;font-size:14px"><strong>${MAIL_PREVIEW.subjectLabel}:</strong> ${h.esc(mail.subject)}</p>
<iframe sandbox="" srcdoc="${h.esc(mail.html)}" title="${h.esc(MAIL_PREVIEW.frameTitle(label))}" style="width:100%;min-height:320px;border:1px solid var(--line);border-radius:12px;background:#FFFFFF"></iframe>`
    : `<p class="nothing" style="margin:0;font-size:14px;color:var(--ink-2)">${MAIL_PREVIEW.nothing}</p>`;
  return `<section class="mail-preview card" data-kind="${h.esc(kind)}" style="display:flex;flex-direction:column;gap:10px;margin:0">
${head}
${inner}
</section>`;
}

/**
 * @param {object} h ctx.html
 * @param {{ to: string[], sections: Array<{ kind: string, label: string, mail: { subject: string, html: string } | null }> }} data
 */
export function mailPreviewBody(h, { to, sections }) {
  const who = to.length > 0 ? `${MAIL_PREVIEW.toLabel}: ${to.map((e) => h.esc(e)).join(', ')}` : MAIL_PREVIEW.noRecipients;
  return [
    h.notice(MAIL_PREVIEW.note, { kind: 'info' }),
    `<p class="recipients" style="margin:0;font-size:14px;color:var(--ink-body)">${who}</p>`,
    ...sections.map((s) => mailSection(h, s)),
    `<p style="margin:0"><a class="button secondary" href="/settings">${MAIL_PREVIEW.back}</a></p>`,
  ].join('\n');
}

/** 대표가 아닌 구성원이 저장하려 할 때 */
export function ownerOnlyBody(h) {
  return `${h.error(TEXT.ownerOnly, TEXT.ownerOnlyNext)}<p><a href="/settings">${h.esc(MENU.title)}</a></p>`;
}

/** 저장된 조건을 폼 값으로 */
export function valuesFrom({ criteria, webhook, emails }) {
  return {
    keywords: (criteria.keywords || []).join(', '),
    regions: (criteria.regions || []).join(', '),
    excludeKeywords: (criteria.excludeKeywords || []).join(', '),
    budgetMin: str(criteria.budgetMin),
    budgetMax: str(criteria.budgetMax),
    webhook: str(webhook),
    emails: str(emails).split(',').filter((e) => e !== '').join(', '),
  };
}
