// 오늘의 공고 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).
import { formatBudget } from '../../../src/match.js';
import { EXPLAIN_TEXT } from '../../core/explain.mjs';

export const MENU = {
  title: '오늘의 공고',
  help: '오늘 새로 뜬 공고 중 조건에 맞는 것과 추천 근거를 보여줍니다.',
};

export const TEXT = {
  emptyMessage: '오늘은 조건에 맞는 새 공고가 없습니다.',
  emptyLink: '알림 설정에서 조건 보기',
  runButton: '오늘 공고 가져오기',
  runBusy: '가져오는 중…',
  maybeTitle: '관련 가능성 있음',
  maybeNote: '추천 키워드에서 채택한 말로 더 찾은 공고입니다. 조건과 다를 수 있습니다.',
  original: '원문 보기',
  fetchFailed: '공고를 가져오지 못했습니다',
  fetchFailedNext: '알림 설정에서 조건을 확인한 뒤 오늘 공고 가져오기를 다시 눌러 주세요',
  criteriaTitle: '지금 조건',
  criteriaKeywords: '키워드',
  criteriaRegions: '지역',
  criteriaBudget: '예산',
  allRegions: '전국',
  noKeywords: '비어 있음',
  noBudget: '제한 없음',
  criteriaLink: '알림 설정에서 바꾸기',
  listTitle: '조건에 맞는 공고',
  deadline: '마감',
  budget: '예산',
  deadlineChanged: '마감 변경됨',
  creditsLeft: (n) => `무료 가져오기 ${n}회 남음`,
  creditsNone: (max) => `무료 가져오기 ${max}회를 모두 썼습니다`,
  creditsNoneNext: '계속 쓰려면 요금제를 골라 주세요',
  creditsPlans: '요금제 보기',
};

/** 예산 기준 → 화면 이름과 부가세 표기 */
export const BUDGET_LABELS = {
  estimated: { name: '추정가격', vat: '부가세 제외' },
  base: { name: '기초금액', vat: '부가세 포함' },
  assigned: { name: '배정예산', vat: '부가세 포함' },
};

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function dateLabel(date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!m) return '';
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return `${m[2]}/${m[3]}(${WEEKDAYS[day]})`;
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

const SEP = '<span aria-hidden="true" style="color:var(--line-input)">·</span>';

function badgeLine(h, badges) {
  if (!badges || badges.length === 0) return '';
  return `<p class="badges" style="margin:0">${badges.map((b) => h.badge(b)).join(' ')}</p>`;
}

/** '왜 추천:' 머리말만 굵게 (콜론은 그대로 둔다) */
function reasonLine(h, list, maybe) {
  const text = h.reasons(list);
  if (!text) return '';
  const head = maybe ? '<strong style="color:var(--ink-2)">왜 추천:</strong>' : '<strong>왜 추천:</strong>';
  const style = maybe ? ' style="background:var(--chip-bg)"' : '';
  return `<p class="reasons"${style}>${text.replace(/^왜 추천:/, head)}</p>`;
}

/** '추정가격 1.2억 (부가세 제외)'. 기준을 모르면 '예산 1.2억' */
export function budgetText(bid) {
  const label = bid && Object.prototype.hasOwnProperty.call(BUDGET_LABELS, bid.budgetBasis) ? BUDGET_LABELS[bid.budgetBasis] : null;
  if (!label) return `${TEXT.budget} ${formatBudget(bid ? bid.budget : null)}`;
  const v = bid.amounts && bid.amounts[bid.budgetBasis] !== null && bid.amounts[bid.budgetBasis] !== undefined ? bid.amounts[bid.budgetBasis] : bid.budget;
  return `${label.name} ${formatBudget(v)} (${label.vat})`;
}

const EXPLAIN_STATE = (ok) => (ok === true ? EXPLAIN_TEXT.ok : ok === false ? EXPLAIN_TEXT.no : EXPLAIN_TEXT.unknown);

/** 접힌 '왜 추천됐나 · N/4 조건 맞음' 블록. 설명이 없으면 '' */
function explainBlock(h, result) {
  if (!result || !Array.isArray(result.checks)) return '';
  const rows = result.checks
    .map((c) => `<li data-ok="${c.ok === true ? 'true' : c.ok === false ? 'false' : 'null'}"><span class="state">${EXPLAIN_STATE(c.ok)}</span>${h.esc(c.text)}</li>`)
    .join('');
  return `<details class="explain"><summary>${h.esc(EXPLAIN_TEXT.summary(result.met, result.total))}</summary><ul>${rows}</ul></details>`;
}

/** 종류 칩 + 최근 마감 변경 표시 */
function kindLine(h, bid, changed) {
  const chips = [h.kindChip(bid.kind)];
  if (changed) chips.push(`<span class="kind-chip kind-changed">${TEXT.deadlineChanged}</span>`);
  const html = chips.filter(Boolean).join(' ');
  return html ? `<p class="kinds" style="margin:0;display:flex;flex-wrap:wrap;gap:6px">${html}</p>` : '';
}

/** 공고 한 건 카드. maybe 면 점선 테두리와 회색 번호 */
function itemCard(h, { bid, badges, flow }, number, today, maybe = false, changed = new Set(), { example = false, explain = null } = {}) {
  const url = safeUrl(bid.url);
  const when = h.dateTime(bid.deadline);
  const facts = [`<span>${when ? `${TEXT.deadline} ${when}` : h.esc(h.dday(bid.deadline, today))}</span>`];
  const opening = h.openingText(bid.openingAt);
  if (opening) facts.push(`<span>${h.esc(opening)}</span>`);
  facts.push(`<span>${h.esc(budgetText(bid))}</span>`);
  if (url) {
    facts.push(
      `<a href="${h.esc(url)}" target="_blank" rel="noopener" style="font-weight:500;text-decoration:none">${TEXT.original}<span class="skip"> (${h.esc(bid.title)})</span> <span aria-hidden="true">↗</span></a>`,
    );
  }
  const cardStyle = maybe
    ? 'display:flex;flex-direction:column;gap:14px;background:#FBFCFD;border:1px dashed var(--line-input)'
    : 'display:flex;flex-direction:column;gap:14px';
  const numStyle = `flex:none;width:28px;height:28px;margin-top:1px;border-radius:8px;font-size:14px;font-weight:700;display:flex;align-items:center;justify-content:center;${
    maybe ? 'background:var(--chip-bg);color:var(--ink-2)' : 'background:var(--primary-soft);color:var(--primary)'
  }`;
  return `<li class="card" style="${cardStyle}">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
<div style="display:flex;gap:14px;align-items:flex-start;min-width:0">
<span class="num" style="${numStyle}">${number}</span>
<div style="display:flex;flex-direction:column;gap:2px;min-width:0">
${example ? `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px"><h3 class="title" style="margin:0">${h.esc(bid.title)}</h3>${h.exampleChip()}</div>` : `<h3 class="title" style="margin:0">${h.esc(bid.title)}</h3>`}
${bid.org ? `<p class="org" style="margin:0">${h.esc(bid.org)}</p>` : ''}
</div>
</div>
${h.ddayChip(bid.deadline, today)}
</div>
<div class="card-body" style="display:flex;flex-direction:column;gap:12px;padding-left:clamp(0px,6vw,42px)">
${kindLine(h, bid, changed.has(bid.bidId))}
${h.flowLine(flow)}
<p class="facts" style="margin:0;display:flex;flex-wrap:wrap;gap:4px 8px">${facts.join(SEP)}</p>
${reasonLine(h, bid.reasons, maybe)}
${explainBlock(h, explain && typeof explain.get === 'function' ? explain.get(bid.bidId) : null)}
${badgeLine(h, badges)}
</div>
</li>`;
}

function runForm(h, primary) {
  return `<form method="post" action="/today/run" style="margin:0"><button type="submit"${primary ? '' : ' class="secondary"'} data-busy="${TEXT.runBusy}">${h.icon('refresh', { size: 18 })}${TEXT.runButton}</button></form>`;
}

/** 무료 횟수를 다 쓴 화면의 버튼. 모양과 문구는 그대로 두고 누를 수 없게 한다 */
function runDisabled(h, primary) {
  return `<button type="button" disabled${primary ? '' : ' class="secondary"'}>${h.icon('refresh', { size: 18 })}${TEXT.runButton}</button>`;
}

function joinList(list, fallback) {
  const items = (Array.isArray(list) ? list : []).filter((x) => String(x ?? '').trim() !== '');
  return items.length > 0 ? items.join(' · ') : fallback;
}

function budgetRange(min, max) {
  const has = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));
  if (!has(min) && !has(max)) return TEXT.noBudget;
  return `${has(min) ? formatBudget(Number(min)) : ''} ~ ${has(max) ? formatBudget(Number(max)) : ''}`.trim();
}

/** 지금 조건 줄 (키워드 · 지역 · 예산 + 알림 설정 링크) */
function criteriaStrip(h, criteria) {
  if (!criteria) return '';
  const item = (label, value) =>
    `<span style="display:inline-flex;gap:8px"><span style="color:var(--ink-3)">${label}</span><span style="font-weight:500">${h.esc(value)}</span></span>`;
  return `<section class="criteria" aria-label="${TEXT.criteriaTitle}" style="background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px 18px;display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;font-size:14px">
<span style="font-weight:700;color:var(--ink-body)">${TEXT.criteriaTitle}</span>
${item(TEXT.criteriaKeywords, joinList(criteria.keywords, TEXT.noKeywords))}
${item(TEXT.criteriaRegions, joinList(criteria.regions, TEXT.allRegions))}
${item(TEXT.criteriaBudget, budgetRange(criteria.budgetMin, criteria.budgetMax))}
<a href="/settings" style="margin-left:auto;font-weight:500;text-decoration:none;min-height:36px;display:inline-flex;align-items:center">${TEXT.criteriaLink}<span aria-hidden="true">&nbsp;→</span></a>
</section>`;
}

/**
 * 제목 오른쪽 영역: 기준 날짜 · 건수 + 오늘 공고 가져오기 (목록이 비면 주 버튼, 아니면 보조 버튼)
 * @param {object} h ctx.html
 * credits 가 있고 무제한이 아니면 버튼 옆에 남은 무료 횟수. 0회면 버튼을 막고 요금제 링크
 * @param {{ date: string|null, today: string, count: number, credits?: {used:number, max:number, left:number, unlimited:boolean}|null }} data
 * @returns {string}
 */
export function todayActions(h, { date, today, count, credits = null }) {
  const parts = [];
  if (date) {
    const label = dateLabel(date);
    const text = date === today ? `${label} 기준` : `${label} 에 가져온 공고입니다.`;
    parts.push(`<p class="date" style="margin:0">${h.esc(text)}${count > 0 ? ` · <strong style="color:var(--ink)">${count}건</strong>` : ''}</p>`);
  }
  if (!credits || credits.unlimited) {
    parts.push(runForm(h, count === 0));
  } else if (credits.left > 0) {
    parts.push(`<span class="chip credits">${h.esc(TEXT.creditsLeft(credits.left))}</span>`);
    parts.push(runForm(h, count === 0));
  } else {
    parts.push(`<span class="chip credits none">${h.esc(TEXT.creditsNone(credits.max))}</span>`);
    parts.push(runDisabled(h, count === 0));
    parts.push(`<a class="button secondary" href="/billing">${TEXT.creditsPlans}</a>`);
  }
  return parts.join('\n');
}

/**
 * @param {object} h ctx.html
 * bid 에 StoredBid 의 kind·openingAt·budgetBasis·amounts 가 있으면 함께 보여 준다.
 * changes 는 ctx.bids.changesSince(최근 7일) 결과. 마감(deadline) 변경이 있는 공고에 '마감 변경됨' 을 붙인다.
 * example 이면 제목 옆에 '예시 데이터' 칩. explain 은 bidId → 조건별 맞음/안 맞음 (없으면 블록 없음).
 * @param {{ date: string|null, today: string, items: Array<{bid: object, badges: Array<{label:string,href:string,kind?:string}>}>, maybe: {bid: object, badges: Array<{label:string,href:string,kind?:string}>}|null, error?: {message:string, next:string, href?:string}|null, criteria?: {keywords:string[], regions:string[], budgetMin:number|null, budgetMax:number|null}|null, changes?: Array<{bidId:string, field:string}>, example?: boolean, explain?: Map<string, {checks: Array<{id:string, ok:boolean|null, text:string}>, met:number, total:number}>|null }} data
 * @returns {string}
 */
export function todayBody(h, { date, today, items, maybe, error, criteria, changes, example = false, explain = null }) {
  const extra = { example: Boolean(example), explain };
  const parts = [];
  const changed = new Set((Array.isArray(changes) ? changes : []).filter((c) => c && c.field === 'deadline').map((c) => String(c.bidId)));
  if (error) parts.push(h.error(error.message, error.next));
  if (error && error.href) parts.push(`<p><a class="button" href="${h.esc(error.href)}">${TEXT.creditsPlans}</a></p>`);
  parts.push(criteriaStrip(h, criteria));
  if (items.length === 0) {
    parts.push(h.empty(TEXT.emptyMessage, { href: '/settings', label: TEXT.emptyLink }));
  } else {
    parts.push(`<h2 class="list-title" style="margin:8px 0 0;font-size:18px;font-weight:700">${TEXT.listTitle} ${h.count(items.length, '건')}</h2>`);
    parts.push(`<ol class="bids" style="list-style:none;margin:0;padding:0">${items.map((it, i) => itemCard(h, it, i + 1, today, false, changed, extra)).join('')}</ol>`);
  }
  if (maybe) {
    parts.push(`<section aria-labelledby="maybe-title" style="display:flex;flex-direction:column;gap:12px;margin-top:12px">
<div style="display:flex;flex-direction:column;gap:6px">
<div style="display:flex;align-items:center;gap:14px">
<span aria-hidden="true" style="height:1px;flex:1;background:var(--hairline)"></span>
<h2 id="maybe-title" style="margin:0;font-size:15px;font-weight:700;color:var(--ink-body)">${TEXT.maybeTitle}</h2>
<span aria-hidden="true" style="height:1px;flex:1;background:var(--hairline)"></span>
</div>
<p style="margin:0;text-align:center;font-size:13px;color:var(--ink-2)">${TEXT.maybeNote}</p>
</div>
<ol class="bids" style="list-style:none;margin:0;padding:0">${itemCard(h, maybe, 1, today, true, changed, extra)}</ol>
</section>`);
  }
  return parts.filter(Boolean).join('\n');
}

/** @param {string} sourceError 소스에 남은 사용자 문구 (이미 '무엇이 안 됐는지. 다음에 할 일.' 형식). 없으면 기본 안내 */
export function fetchError(sourceError) {
  return sourceError ? { message: sourceError, next: '' } : { message: TEXT.fetchFailed, next: TEXT.fetchFailedNext };
}
