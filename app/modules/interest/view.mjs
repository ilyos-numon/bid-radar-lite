// 관심 공고 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).

export const MENU = {
  title: '관심 공고',
  help: '관심 표시한 공고의 마감 D-day 와 입찰 전 확인 항목입니다.',
};

/** 입찰 전 확인 항목 (고정 5개, 순서가 곧 번호 1..5) */
export const CHECKLIST = [
  '입찰참가자격 등록 확인',
  '입찰보증금·보증서 준비',
  '제출 서류 목록 확인 (공고 요약 참조)',
  '마감 시각 재확인',
  '공동수급·지역제한 확인',
];

export const TEXT = {
  badgeAdd: '관심',
  badgeOn: '관심 중',
  emptyMessage: '관심 표시한 공고가 없습니다.',
  emptyLink: '오늘의 공고에서 고르기',
  addTitle: '관심 공고에 담기',
  addButton: '관심 공고에 담기',
  addAsk: '이 공고를 관심 공고에 담으면 마감 7일·3일·1일 전과 마감 당일(마감 시각 전)에 한 번씩 다시 알려 드립니다.',
  already: '이미 관심 공고에 담겨 있습니다.',
  goList: '관심 공고 보기',
  remove: '관심 해제',
  original: '원문 보기',
  checklistTitle: '입찰 전 확인 항목',
  checked: '확인함',
  unchecked: '확인 전',
  deadline: '마감',
  notFoundTitle: '찾는 공고가 없습니다',
  notFound: '공고를 찾지 못했습니다',
  notFoundNext: '오늘의 공고에서 다시 선택해 주세요',
  todayLink: '오늘의 공고',
  badItem: '확인 항목을 찾지 못했습니다',
  badItemNext: '관심 공고 화면에서 다시 눌러 주세요',
  soon: '마감 임박',
  progressUnit: '확인',
  remindNote: '마감 7일 · 3일 · 1일 전에 다시 알려 드립니다 (마감 당일에도 마감 시각 전에 한 번)',
  sortNote: '마감이 가까운 순',
};

const enc = (s) => encodeURIComponent(String(s ?? ''));

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

function deadlineText(h, deadline) {
  const when = h.dateTime(deadline);
  return when ? `${TEXT.deadline} ${h.esc(when)}` : '';
}

/** 'D-3 10:00'·'D-3' → 3, 그 밖('마감 지남'·'마감 미확인') → null */
function ddayDays(label) {
  const m = /^D-(\d+)/.exec(String(label ?? ''));
  return m ? Number(m[1]) : null;
}

/** 마감까지 3일 이하 */
function isSoon(label) {
  const n = ddayDays(label);
  return n !== null && n <= 3;
}

function originalLink(h, bid) {
  const url = safeUrl(bid.url);
  if (!url) return '';
  return `<a href="${h.esc(url)}" target="_blank" rel="noopener" style="font-weight:500;text-decoration:none">${TEXT.original}<span class="skip"> (${h.esc(bid.title)})</span> <span aria-hidden="true">↗</span></a>`;
}

function factsLine(h, bid) {
  const parts = [];
  const dl = deadlineText(h, bid.deadline);
  if (dl) parts.push(`<span>${dl}</span>`);
  const opening = h.openingText(bid.openingAt);
  if (opening) parts.push(`<span>${h.esc(opening)}</span>`);
  const link = originalLink(h, bid);
  if (link) parts.push(link);
  if (parts.length === 0) return '';
  return `<p class="facts" style="margin:4px 0 0;display:flex;flex-wrap:wrap;gap:4px 8px">${parts.join('<span aria-hidden="true" style="color:var(--line-input)">·</span>')}</p>`;
}

/** 'D-3 10:00' → 큰 'D-3' + 작은 ' 10:00' */
function bigLabel(h, dday) {
  const m = /^(D-\d+) (\d{2}:\d{2})$/.exec(String(dday ?? ''));
  if (!m) return h.esc(dday);
  return `${h.esc(m[1])}<span style="font-size:17px;font-weight:500"> ${h.esc(m[2])}</span>`;
}

/** 카드 오른쪽 큰 D-day (+ 3일 이하면 마감 임박) */
function bigDday(h, dday) {
  const n = ddayDays(dday);
  const soon = isSoon(dday);
  const color = soon ? 'var(--soon)' : n === null ? 'var(--ink-2)' : 'var(--ink)';
  const size = n === null ? '17px' : '30px';
  return `<div style="flex:none;text-align:right">
<p class="dday${soon ? ' soon' : ''}" style="margin:0;padding:0;background:none;border:0;font-size:${size};line-height:1.1;color:${color}"><span class="skip">${TEXT.deadline} </span>${bigLabel(h, dday)}</p>
${soon ? `<p style="margin:4px 0 0;font-size:13px;font-weight:500;color:var(--soon)">${TEXT.soon}</p>` : ''}
</div>`;
}

const TICK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>';

function checkForm(h, bidId, index, label, on) {
  const item = index + 1;
  const box = on
    ? `<span aria-hidden="true" style="flex:none;width:22px;height:22px;border-radius:6px;background:var(--primary);display:flex;align-items:center;justify-content:center">${TICK}</span>`
    : '<span aria-hidden="true" style="flex:none;width:22px;height:22px;border-radius:6px;border:1.5px solid #B0B8C1;background:var(--surface)"></span>';
  const state = on ? `<span class="state" style="font-size:13px;font-weight:500;color:var(--ok)">${TEXT.checked}</span>` : '';
  return `<li><form method="post" action="/interest/${h.esc(enc(bidId))}/check" style="margin:0">
<input type="hidden" name="item" value="${item}">
<input type="hidden" name="checked" value="${on ? '0' : '1'}">
<button type="submit" class="secondary check" aria-pressed="${on ? 'true' : 'false'}" data-item="${item}" style="width:100%;min-height:48px;justify-content:flex-start;gap:12px;padding:0 14px;border-color:var(--line);background:${on ? 'var(--reasons-bg)' : 'var(--surface)'};color:var(--ink);font-size:15px;font-weight:400;text-align:left">${box}<span style="flex:1">${h.esc(label)}</span>${state}</button>
</form></li>`;
}

function checklist(h, bidId, checks) {
  const done = checks.filter(Boolean).length;
  const pct = Math.round((done / CHECKLIST.length) * 100);
  const list = CHECKLIST.map((label, i) => checkForm(h, bidId, i, label, Boolean(checks[i]))).join('');
  return `<div class="checks" style="border-top:1px solid var(--divider);padding-top:18px;display:flex;flex-direction:column;gap:12px">
<div style="display:flex;justify-content:space-between;align-items:center;gap:12px">
<h3 style="margin:0;font-size:15px;font-weight:700">${TEXT.checklistTitle}</h3>
<span class="progress" style="font-size:14px;color:var(--ink-2);font-variant-numeric:tabular-nums"><strong style="color:var(--ink)">${done}</strong> / ${CHECKLIST.length} ${TEXT.progressUnit}</span>
</div>
<div aria-hidden="true" style="height:6px;border-radius:3px;background:var(--divider);overflow:hidden"><div style="width:${pct}%;height:6px;background:var(--primary)"></div></div>
<ul class="checklist" style="list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:8px">${list}</ul>
</div>`;
}

/** 예시 데이터 칩 (헬퍼에 없으면 빈 글자) */
function exampleTag(h, example) {
  if (!example || typeof h.exampleChip !== 'function') return '';
  return ` ${h.exampleChip()}`;
}

function itemCard(h, { bid, dday, checks, badges = [], flow }, example = false) {
  const soon = isSoon(dday);
  const chips = badges.map((b) => h.badge(b)).join('');
  return `<li class="card" data-bid="${h.esc(bid.bidId)}" style="margin:0;padding:24px;display:flex;flex-direction:column;gap:18px${soon ? ';border-color:#F4CDB5' : ''}">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px">
<div style="display:flex;flex-direction:column;gap:2px;min-width:0">
<h2 class="title" style="margin:0;font-size:19px">${h.esc(bid.title)}${exampleTag(h, example)}</h2>
${bid.org ? `<p class="org" style="margin:0">${h.esc(bid.org)}</p>` : ''}
${factsLine(h, bid)}
${h.flowLine(flow)}
</div>
${bigDday(h, dday)}
</div>
${checklist(h, bid.bidId, checks)}
<div class="card-foot" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
<p class="badges" style="margin:0">${chips}</p>
<form method="post" action="/interest/${h.esc(enc(bid.bidId))}/remove" style="margin:0"><button type="submit" class="secondary small quiet">${TEXT.remove}</button></form>
</div>
</li>`;
}

/** 제목 오른쪽 안내 (layout actions) */
export function listActions(h) {
  return `<p class="note" style="margin:0;display:inline-flex;align-items:center;gap:8px;font-size:14px;color:var(--ink-2)">${h.icon('bell', { size: 18 })}${TEXT.remindNote}</p>`;
}

/**
 * @param {object} h ctx.html
 * @param {Array<{bid:object, dday:string, checks:boolean[], badges?:Array<{label:string,href:string,kind?:string}>}>} items 마감이 가까운 순
 * @param {string} [_today] 'YYYY-MM-DD' (D-day 는 items[i].dday 에 이미 계산돼 있다)
 * @param {{ example?: boolean }} [opts] example: 제목 옆에 예시 데이터 칩
 */
export function listBody(h, items, _today, { example = false } = {}) {
  if (items.length === 0) return h.empty(TEXT.emptyMessage, { href: '/today', label: TEXT.emptyLink });
  return `<p class="list-meta" style="margin:4px 0 0;font-size:14px;color:var(--ink-2)">${TEXT.sortNote} · ${items.length}건</p>
<ol class="interest" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px">${items.map((it) => itemCard(h, it, example)).join('')}</ol>`;
}

/** listBody 의 옵션 객체 모양 */
export function interestBody(h, { items = [], today, example = false } = {}) {
  return listBody(h, items, today, { example });
}

/** D-day 글자로 작은 칩을 만든다 (h.ddayChip 과 같은 모양) */
function chip(h, dday) {
  const cls = `dday${isSoon(dday) ? ' soon' : ''}${dday === '마감 지남' ? ' past' : ''}${dday === '마감 미확인' ? ' unknown' : ''}`;
  return `<span class="${cls}">${ddayDays(dday) === null ? '' : `<span class="skip">${TEXT.deadline} </span>`}${h.esc(dday)}</span>`;
}

/** 담기 확인 화면 @param {{bid: object, dday: string, already: boolean}} data */
export function addBody(h, { bid, dday, already }) {
  const head = `<div class="card" style="margin:0;display:flex;flex-direction:column;gap:6px">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
<div style="min-width:0"><h2 class="title" style="margin:0">${h.esc(bid.title)}</h2>
${bid.org ? `<p class="org" style="margin:0">${h.esc(bid.org)}</p>` : ''}</div>
${chip(h, dday)}
</div>
${factsLine(h, bid)}
</div>`;
  if (already) {
    return `${head}
${h.notice(TEXT.already, { kind: 'success' })}
<p><a class="button secondary" href="/interest">${TEXT.goList}</a></p>`;
  }
  return `${head}
${h.notice(TEXT.addAsk)}
<form method="post" action="/interest/add/${h.esc(enc(bid.bidId))}"><button type="submit">${TEXT.addButton}</button></form>`;
}

export function notFoundBody(h) {
  return `${h.error(TEXT.notFound, TEXT.notFoundNext)}<p><a class="button secondary" href="/today">${TEXT.todayLink}</a></p>`;
}

export function badItemBody(h) {
  return `${h.error(TEXT.badItem, TEXT.badItemNext)}<p><a class="button secondary" href="/interest">${TEXT.goList}</a></p>`;
}

/** 뱃지 뜻(kind)을 덧붙인다. 목록 비교(label·href)에는 나타나지 않게 열거하지 않는 속성으로 둔다 */
function withKind(b, kind) {
  return Object.defineProperty(b, 'kind', { value: kind, enumerable: false });
}

/** decorate 뱃지: 담기 전 'interest', 관심 중 'interest-on' */
export function badge(bidId, on) {
  return on
    ? withKind({ label: TEXT.badgeOn, href: '/interest' }, 'interest-on')
    : withKind({ label: TEXT.badgeAdd, href: `/interest/add/${enc(bidId)}` }, 'interest');
}
