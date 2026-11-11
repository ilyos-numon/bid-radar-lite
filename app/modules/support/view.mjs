// 지원사업 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).

export const MENU = {
  title: '지원사업',
  help: '정부·지자체 지원사업과 바우처 공고를 입찰과 따로 모아 보여줍니다.',
};

export const TEXT = {
  noKey: '지원사업 인증키가 아직 없습니다. 운영자가 인증키를 넣으면 수집이 시작됩니다.',
  emptyMessage: '아직 모은 지원사업이 없습니다.',
  noMatch: '모은 지원사업 중 지금 키워드에 맞는 것이 없습니다.',
  noMatchLink: '키워드 바꾸기',
  fetchButton: '지금 가져오기',
  original: '원문 보기',
  applyEnd: '신청 마감',
  applyPrefix: '신청',
  applyUntil: (date) => `신청 ${date}까지`,
  note: '새 지원사업은 입찰 알림과 따로, 매일 아침 8시 20분쯤 알려 드립니다.',
  noteOff: '지원사업 자동 알림이 꺼져 있습니다.',
  busy: '가져오는 중…',
  filterHelp: '입찰 조건과 따로 정합니다. 처음에는 입찰 조건의 키워드로 채워 둡니다.',
  filterTitle: '지원사업 키워드',
  keywordsLabel: '키워드 (쉼표로 구분)',
  regionsLabel: '지역 (쉼표로 구분, 비우면 전국)',
  saveButton: '키워드 저장',
  saved: '키워드를 저장했습니다.',
  fetched: (n) => `지원사업 ${n}건을 가져왔습니다.`,
  fetchFailed: '지원사업을 가져오지 못했습니다',
  nextRetry: '잠시 뒤 지금 가져오기를 다시 눌러 주세요',
  nextKey: '운영자에게 인증키 확인을 요청한 뒤 지금 가져오기를 다시 눌러 주세요',
};

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

const ROW = 'display:flex;justify-content:space-between;align-items:flex-start;gap:16px';
const NUM =
  'flex:none;width:28px;height:28px;margin-top:1px;border-radius:8px;background:var(--ok-bg);color:var(--ok);font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums';

function itemCard(h, it, today, n) {
  const url = safeUrl(it.url);
  const date = h.shortDate(it.applyEnd);
  const facts = [];
  if (date) facts.push(`<span>${h.esc(TEXT.applyUntil(date))}</span>`);
  if (url)
    facts.push(
      `<a href="${h.esc(url)}" target="_blank" rel="noopener" style="font-weight:500;text-decoration:none">${TEXT.original} ↗<span class="skip"> (${h.esc(it.title)})</span></a>`,
    );
  const reasons = h.reasons(it.reasons);
  return `<li class="card" style="display:flex;flex-direction:column;gap:12px">
<div style="${ROW}">
<div style="display:flex;gap:14px;align-items:flex-start;min-width:0">
<span class="num" aria-hidden="true" style="${NUM}">${n}</span>
<div style="display:flex;flex-direction:column;gap:2px;min-width:0">
<h3 class="title" style="margin:0">${h.esc(it.title)}</h3>
${it.org ? `<p class="org" style="margin:0">${h.esc(it.org)}</p>` : ''}
</div>
</div>
${h.ddayChip(it.applyEnd, today, { prefix: `${TEXT.applyPrefix} ` })}
</div>
<div style="padding-left:42px;display:flex;flex-direction:column;gap:10px">
${facts.length > 0 ? `<p class="facts" style="margin:0">${facts.join(' · ')}</p>` : ''}
${reasons ? `<p class="reasons">${reasons}</p>` : ''}
</div>
</li>`;
}

/** 머리 오른쪽 '지금 가져오기' (인증키가 있을 때만). routes 가 layout actions 로 넘긴다 */
export function fetchActions(h, hasKey) {
  if (!hasKey) return '';
  return `<form method="post" action="/support/fetch" style="margin:0"><button type="submit" data-busy="${TEXT.busy}">${h.icon('refresh', { size: 18 })}${TEXT.fetchButton}</button></form>`;
}

function filterForm(h, { keywords, regions }) {
  return `<section class="card" aria-labelledby="support-filter" id="support-keywords" style="padding:28px;display:flex;flex-direction:column;gap:18px;margin:8px 0 0">
<div style="display:flex;flex-direction:column;gap:4px">
<h2 id="support-filter" style="margin:0;font-size:19px;font-weight:700">${TEXT.filterTitle}</h2>
<p class="hint" style="margin:0;font-size:14px">${TEXT.filterHelp}</p>
</div>
<form method="post" action="/support/keywords" style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end">
<label style="flex:1 1 260px">${TEXT.keywordsLabel}<input name="keywords" value="${h.esc(keywords.join(', '))}"></label>
<label style="flex:1 1 260px">${TEXT.regionsLabel}<input name="regions" value="${h.esc(regions.join(', '))}"></label>
<button type="submit" class="secondary">${TEXT.saveButton}</button>
</form>
</section>`;
}

/**
 * 수집 실패 코드 → 화면 오류 (영문 코드는 보여 주지 않는다)
 * @param {{code:string, httpStatus?:number}} failure
 * @returns {{message:string, next:string}}
 */
export function fetchError(failure) {
  const code = String((failure && failure.code) || '');
  const http = /^HTTP_(\d+)$/.exec(code);
  const api = /^API_(\d+)$/.exec(code);
  let detail = '';
  if (http) detail = `응답 오류 ${http[1]}`;
  else if (api) detail = `응답 오류 ${api[1]}`;
  else if (code.startsWith('API_')) detail = '응답 오류';
  else if (code === 'BAD_JSON') detail = '응답 형식 오류';
  else if (code === 'TIMEOUT') detail = '응답 시간 초과';
  else if (code === 'NETWORK') detail = '연결 안 됨';
  const keyProblem = (http && (http[1] === '401' || http[1] === '403')) || code.startsWith('API_');
  return {
    message: detail ? `${TEXT.fetchFailed} (${detail})` : TEXT.fetchFailed,
    next: keyProblem ? TEXT.nextKey : TEXT.nextRetry,
  };
}

/**
 * @param {object} h ctx.html
 * @param {{ hasKey: boolean, today: string, total: number, items: object[], keywords: string[], regions: string[], error?: {message:string,next:string}|null, notice?: string|null }} data
 */
export function supportBody(h, { hasKey, today, total, items, keywords, regions, error = null, notice = null }) {
  const parts = [];
  if (notice) parts.push(h.notice(notice, { kind: 'success', role: 'status' }));
  if (error) parts.push(h.error(error.message, error.next));
  if (!hasKey) parts.push(h.notice(TEXT.noKey, { kind: 'info', role: 'status' }));
  else parts.push(`<p class="hint" style="display:flex;align-items:center;gap:8px;font-size:14px">${h.icon('bell', { size: 18 })}${h.scheduleNote(TEXT.note, TEXT.noteOff)}</p>`);
  if (total === 0) {
    parts.push(h.empty(TEXT.emptyMessage));
  } else if (items.length === 0) {
    parts.push(h.empty(TEXT.noMatch, { href: '#support-keywords', label: TEXT.noMatchLink }));
  } else {
    parts.push(
      `<ol class="support-items" style="list-style:none;margin:0;padding:0">${items.map((it, i) => itemCard(h, it, today, i + 1)).join('')}</ol>`,
    );
  }
  parts.push(filterForm(h, { keywords, regions }));
  return parts.join('\n');
}
