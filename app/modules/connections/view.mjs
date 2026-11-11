// 연결 설정 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).
// 입력 칸에는 저장된 값을 넣지 않는다. 화면에는 가린 값만 보인다.

export const MENU = {
  title: '연결 설정',
  help: '공고와 지원사업을 가져오고 자동 요약을 만드는 데 쓰는 인증키를 등록하고 연결을 확인합니다.',
};

export const TEXT = {
  registered: (masked) => `등록됨 ${masked}`,
  notRegistered: '등록 안 됨',
  shared: '운영자가 둔 공용 인증키를 쓰는 중입니다. 우리 회사 키를 넣으면 그 키를 씁니다',
  ownerOnlyNotice: '인증키는 대표만 바꿀 수 있습니다',
  ownerOnly: '인증키는 대표만 바꿀 수 있습니다',
  ownerOnlyNext: '대표에게 요청해 주세요',
  saveButton: '저장',
  saveBusy: '저장하는 중…',
  checkButton: '연결 확인',
  checkBusy: '확인하는 중…',
  removeButton: '삭제',
  removeBusy: '삭제하는 중…',
  keepHint: '비워 두면 지금 값을 그대로 둡니다.',
  current: (masked) => `지금 값: ${masked}`,
  saved: (title) => `${title} 연결을 저장했습니다.`,
  removed: (title) => `${title} 연결을 삭제했습니다.`,
  notSaved: '저장하지 않았습니다',
  notSavedNext: '아래 내용을 고친 뒤 다시 저장해 주세요',
  badAddress: (label) => `${label}가 올바르지 않습니다. http:// 또는 https:// 로 시작하는 주소를 적어 주세요.`,
  tooLong: (label) => `${label}: 256자까지 적을 수 있습니다.`,
  nothing: '바꿀 값을 하나 이상 적어 주세요.',
  saveFailed: '저장하지 못했습니다',
  removeFailed: '삭제하지 못했습니다',
  tryLater: '잠시 뒤 다시 시도해 주세요',
  notFound: '찾는 연결이 없습니다',
  notFoundNext: '연결 설정 화면에서 다시 골라 주세요',
  check: {
    ok: '연결됨',
    badkey: '인증키가 맞지 않습니다',
    slow: '시간이 오래 걸립니다. 잠시 뒤 다시 확인해 주세요',
    fail: (code) => (code ? `연결하지 못했습니다 (응답 오류 ${code})` : '연결하지 못했습니다 (연결 안 됨)'),
  },
  checkTitle: (title) => `${title} 연결 확인 결과`,
  notifyTitle: '알림 받을 곳',
  notifyText: '알림 받을 곳은 알림 설정에서 바꿉니다',
  notifyLink: '알림 설정으로 가기',
};

export const GROUP_TEXT = {
  nara: {
    title: '나라장터',
    desc: '공공데이터포털에서 받은 나라장터 입찰공고 인증키를 넣으면 우리 회사 키로 공고를 가져옵니다.',
  },
  summary: {
    title: '자동 요약',
    desc: '공고문 자동 요약을 만드는 서비스의 주소와 인증키를 넣습니다.',
  },
  support: {
    title: '지원사업',
    desc: '지원사업 정보를 가져오는 주소와 인증키를 넣습니다.',
  },
};

// 칸 문구. 열쇠 이름은 화면용 별칭이고, 실제 칸 이름과의 짝은 service.mjs 의 TEXT_KEY 가 정한다
export const FIELD_TEXT = {
  naraKey: { label: '나라장터 인증키', kind: 'secret' },
  summaryKey: { label: '자동 요약 인증키', kind: 'secret' },
  summaryBase: { label: '자동 요약 서비스 주소', kind: 'address', placeholder: 'https://' },
  summaryName: { label: '요약 방식 이름', kind: 'text', hint: '서비스 안내에 적힌 이름을 그대로 적습니다. 처음 등록할 때 비워 두면 기본값을 씁니다.' },
  supportKey: { label: '지원사업 인증키', kind: 'secret' },
  supportBase: { label: '지원사업 정보 주소', kind: 'address', placeholder: 'https://' },
};

const groupText = (textKey, group) => GROUP_TEXT[textKey[group]] || null;
const fieldText = (textKey, name) => FIELD_TEXT[textKey[name]] || { label: '', kind: 'secret' };

/** 검증 오류 → 문구 */
export function errorText(err, textKey) {
  const label = err.name ? fieldText(textKey, err.name).label : '';
  if (err.code === 'address') return TEXT.badAddress(label);
  if (err.code === 'length') return TEXT.tooLong(label);
  return TEXT.nothing;
}

function statusBadge(h, st, firstName) {
  const f = st.fields[firstName];
  if (f) return h.badge({ label: TEXT.registered(f.masked), kind: 'ok' });
  return `<span class="badge" style="background:var(--chip-bg);color:var(--ink-2)">${h.esc(TEXT.notRegistered)}</span>`;
}

function checkNotice(h, check, title) {
  const msg = check.result === 'fail' ? TEXT.check.fail(check.code) : TEXT.check[check.result];
  const kind = check.result === 'ok' ? 'success' : 'warn';
  return `<div data-check-result="${h.esc(check.result)}" aria-label="${h.esc(TEXT.checkTitle(title))}">${h.notice(msg, { kind, role: 'status' })}</div>`;
}

function fieldHtml(h, group, name, st, canEdit, textKey) {
  const t = fieldText(textKey, name);
  const id = `${group}-${name}`;
  const cur = st.fields[name];
  const hints = [];
  if (cur) hints.push(TEXT.current(cur.masked));
  if (t.hint) hints.push(t.hint);
  hints.push(TEXT.keepHint);
  let attrs;
  if (t.kind === 'secret') attrs = 'type="password" autocomplete="off"';
  else if (t.kind === 'address') attrs = `type="url" inputmode="url" autocomplete="off" placeholder="${h.esc(t.placeholder || '')}"`;
  else attrs = 'type="text" autocomplete="off"';
  const hintStyle = 'font-size:13px;font-weight:400;color:var(--ink-2)';
  return `<label for="${id}">${h.esc(t.label)}<input id="${id}" name="${name}" ${attrs} maxlength="256" aria-describedby="${id}-hint"${canEdit ? '' : ' disabled'}><span id="${id}-hint" style="${hintStyle}">${h.esc(hints.join(' '))}</span></label>`;
}

/**
 * @param {object} h ctx.html
 * @param {{ group: string, names: string[], st: object, canEdit: boolean, check?: object|null, textKey: Record<string,string> }} p
 */
function groupCard(h, { group, names, st, canEdit, check, textKey }) {
  const g = groupText(textKey, group);
  const canCheck = st.registered || st.shared;
  const off = canEdit ? '' : ' disabled';
  const parts = [];
  parts.push(`<section class="card" id="conn-${group}" data-group="${group}" aria-labelledby="conn-${group}-title" style="display:flex;flex-direction:column;gap:14px;margin:0 0 16px">`);
  parts.push(`<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:10px"><h2 id="conn-${group}-title" style="margin:0;font-size:18px;font-weight:700">${h.esc(g.title)}</h2><span data-status>${statusBadge(h, st, names[0])}</span></div>`);
  parts.push(`<p style="margin:0;font-size:14px;color:var(--ink-body)">${h.esc(g.desc)}</p>`);
  if (st.shared) parts.push(`<div data-shared>${h.notice(TEXT.shared, { kind: 'info' })}</div>`);
  if (check) parts.push(checkNotice(h, check, g.title));
  parts.push(`<form class="stack" method="post" action="/connections/${group}" style="max-width:none;margin:0">
<fieldset${off} style="display:grid;gap:14px">
<legend class="skip">${h.esc(g.title)}</legend>
${names.map((n) => fieldHtml(h, group, n, st, canEdit, textKey)).join('\n')}
</fieldset>
<div class="form-actions" style="display:flex;flex-wrap:wrap;align-items:center;gap:12px">
<button type="submit" class="secondary"${off} data-busy="${TEXT.saveBusy}">${TEXT.saveButton}</button>
<button type="submit" class="secondary" formaction="/connections/${group}/check" formmethod="post" formnovalidate${canCheck ? '' : ' disabled'} data-busy="${TEXT.checkBusy}">${TEXT.checkButton}</button>
<button type="submit" class="secondary quiet" formaction="/connections/${group}/remove" formmethod="post" formnovalidate${canEdit && st.registered ? '' : ' disabled'} data-busy="${TEXT.removeBusy}">${TEXT.removeButton}</button>
</div>
</form>`);
  parts.push('</section>');
  return parts.join('\n');
}

/**
 * @param {object} h ctx.html
 * @param {{ groups: Record<string,string[]>, textKey: Record<string,string>, status: object, canEdit: boolean, saved?: string|null, removed?: string|null, check?: object|null, errors?: string[], errorGroup?: string|null, failure?: {message:string,next:string}|null }} data
 */
export function connectionsBody(h, data) {
  const parts = [];
  if (data.failure) parts.push(h.error(data.failure.message, data.failure.next));
  if (data.errors && data.errors.length) {
    parts.push(h.error(TEXT.notSaved, TEXT.notSavedNext).replace(/<\/div>$/, `<ul>${data.errors.map((e) => `<li>${h.esc(e)}</li>`).join('')}</ul></div>`));
  }
  const tk = data.textKey;
  const savedText = data.saved ? groupText(tk, data.saved) : null;
  const removedText = data.removed ? groupText(tk, data.removed) : null;
  if (savedText) parts.push(h.notice(TEXT.saved(savedText.title), { kind: 'success', role: 'status' }));
  if (removedText) parts.push(h.notice(TEXT.removed(removedText.title), { kind: 'success', role: 'status' }));
  if (!data.canEdit) parts.push(`<div data-owner-only>${h.notice(TEXT.ownerOnlyNotice, { kind: 'info' })}</div>`);
  for (const [group, names] of Object.entries(data.groups)) {
    const check = data.check && data.check.group === group ? data.check : null;
    parts.push(groupCard(h, { group, names, st: data.status[group], canEdit: data.canEdit, check, textKey: tk }));
  }
  parts.push(`<section class="card" id="conn-notify" style="display:flex;flex-direction:column;gap:8px;margin:0">
<h2 style="margin:0;font-size:18px;font-weight:700">${TEXT.notifyTitle}</h2>
<p style="margin:0;font-size:14px;color:var(--ink-body)">${TEXT.notifyText}</p>
<p style="margin:0"><a href="/settings">${TEXT.notifyLink}</a></p>
</section>`);
  return parts.join('\n');
}

/** 대표가 아닌 구성원이 저장·삭제하려 할 때 */
export function ownerOnlyBody(h) {
  return `${h.error(TEXT.ownerOnly, TEXT.ownerOnlyNext)}<p><a href="/connections">${h.esc(MENU.title)}</a></p>`;
}

/** 없는 묶음 */
export function notFoundBody(h) {
  return `${h.error(TEXT.notFound, TEXT.notFoundNext)}<p><a href="/connections">${h.esc(MENU.title)}</a></p>`;
}
