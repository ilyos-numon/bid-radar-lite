// 공고 요약 화면. 화면과 알림에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).

export const MENU = {
  title: '공고 요약',
  help: '공고문을 읽어 무슨 사업인지, 필요한 자격, 제출 서류를 세 줄로 보여줍니다.',
};

export const TEXT = {
  badgeReady: '요약 보기',
  badgeUnverified: '요약 확인 필요',
  extraPrefix: '요약: ',
  emptyMessage: '요약할 공고가 아직 없습니다.',
  emptyLink: '오늘의 공고 보기',
  regenerate: '요약 다시 만들기',
  evidence: '근거 보기',
  original: '원문 보기',
  back: '요약 목록으로',
  notFound: '찾는 공고가 없습니다',
  notFoundNext: '요약 목록에서 다시 골라 주세요',
  unverified: '근거를 원문에서 찾지 못했습니다. 원문을 직접 확인해 주세요.',
  noText: '공고문 첨부를 읽지 못했습니다',
  noTextNext: '원문 보기에서 직접 확인해 주세요',
  noKey: '자동 요약이 아직 준비되지 않았습니다',
  noKeyNext: '원문 보기로 확인하세요',
  failed: '자동 요약을 만들지 못했습니다',
  failedNext: '잠시 뒤 요약 다시 만들기를 눌러 주세요',
  pending: '아직 요약하지 않은 공고입니다. 요약 다시 만들기를 누르면 바로 만듭니다.',
  quoteMissing: '원문에서 찾지 못함',
  maybeTag: '관련 가능성 있음',
  ready: '요약 있음 · 세 줄 모두 공고문에서 근거를 찾았습니다.',
  linesTitle: '세 줄 요약',
  evidenceCount: (n) => `원문 인용 ${n}개`,
  regenerateBusy: '요약 만드는 중…',
  regenerateHelp: '공고문을 다시 읽어 세 줄을 새로 만듭니다. 수십 초 걸릴 수 있습니다.',
};

export const FIELD_LABEL = {
  what: '무슨 사업인지',
  qualification: '필요한 자격',
  documents: '제출 서류',
};

export const STATUS_LABEL = {
  ready: '요약 있음',
  unverified: '근거 확인 필요',
  no_text: '첨부를 읽지 못함',
  failed: '요약 못 함',
  none: '아직 요약 전',
};

/** 뱃지 뜻(kind). 꺼내 읽을 수 있지만 열거되지 않게 붙여 기존 { label, href } 비교를 그대로 둔다 */
function withKind(badge, kind) {
  return Object.defineProperty(badge, 'kind', { value: kind, enumerable: false });
}

/** 허브 뱃지 → { label, href, kind: 'summary' } */
export function badgeFor(item, bidId) {
  if (!item) return null;
  const href = `/summary/${encodeURIComponent(bidId)}`;
  if (item.status === 'ready') return withKind({ label: TEXT.badgeReady, href }, 'summary');
  if (item.status === 'unverified') return withKind({ label: TEXT.badgeUnverified, href }, 'summary');
  return null;
}

/** 알림 추가 줄 (ready 만) */
export function extraLines(item) {
  if (!item || item.status !== 'ready' || !item.what) return [];
  return [TEXT.extraPrefix + item.what];
}

function safeUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : '';
}

/** 상태 필 색 (Components 상태 색: 있음 초록 · 확인 필요 노랑 · 못 함 빨강 · 전 회색) */
const STATUS_PILL_STYLE = {
  ready: 'background:var(--ok-bg);color:var(--ok)',
  unverified: 'background:var(--check-bg);color:var(--check)',
  no_text: 'background:var(--no-bg);color:var(--no)',
  failed: 'background:var(--no-bg);color:var(--no)',
  none: '',
};

function statusPill(h, status) {
  const key = Object.prototype.hasOwnProperty.call(STATUS_LABEL, status) ? status : 'none';
  const style = STATUS_PILL_STYLE[key];
  return `<span class="pill status-${key}"${style ? ` style="${style}"` : ''}>${h.esc(STATUS_LABEL[key])}</span>`;
}

/** 원문 보기 링크: 읽는 이름은 '원문 보기 (제목)', 화살표는 읽지 않는다 */
function originalLink(h, url, title) {
  return `<a href="${h.esc(url)}" target="_blank" rel="noopener" style="font-weight:500;text-decoration:none">${h.esc(TEXT.original)}<span class="skip"> (${h.esc(title)})</span> <span aria-hidden="true">↗</span></a>`;
}

/** 마감 글자: 'D-5' 면 '마감 D-5', 지남·미확인은 그대로 */
function deadlineText(h, deadline, today) {
  const d = h.dday(deadline, today);
  return d.startsWith('D-') ? `마감 ${d}` : d;
}

/**
 * 목록
 * @param {object} h ctx.html
 * @param {{ rows: Array<{bid: object, item: object|null, maybe: boolean}>, today: string }} data
 */
export function listBody(h, { rows, today }) {
  if (rows.length === 0) return h.empty(TEXT.emptyMessage, { href: '/today', label: TEXT.emptyLink });
  const cards = rows
    .map(({ bid, item, maybe }, i) => {
      const what = item && (item.status === 'ready' || item.status === 'unverified') && item.what
        ? `<p class="what" style="margin:0;font-size:15px;line-height:1.7;color:var(--ink-body)">${h.esc(item.what)}</p>`
        : '';
      const tags = [statusPill(h, item ? item.status : 'none')];
      if (maybe) tags.push(`<span class="pill">${h.esc(TEXT.maybeTag)}</span>`);
      return `<li class="card" style="display:flex;flex-direction:column;gap:10px">
<div style="display:flex;align-items:flex-start;gap:12px">
<span class="num" aria-hidden="true" style="flex:none;min-width:28px;height:28px;padding:0 6px;border-radius:8px;background:var(--chip-bg);color:var(--ink-2);font-size:14px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums">${i + 1}</span>
<div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px">
<h3 class="title" style="margin:0"><a href="/summary/${h.esc(encodeURIComponent(bid.bidId))}" style="color:var(--ink);text-decoration:none"><span class="skip">${i + 1}. </span>${h.esc(bid.title)}</a></h3>
${bid.org ? `<p class="org" style="margin:0">${h.esc(bid.org)}</p>` : ''}
</div>
${h.ddayChip(bid.deadline, today)}
</div>
<p class="facts" style="margin:0;display:flex;flex-wrap:wrap;gap:6px">${tags.join('')}</p>
${what}
</li>`;
    })
    .join('');
  return `<ol class="summaries" style="list-style:none;margin:0;padding:0">${cards}</ol>`;
}

/** 상태 이름(굵게) + 설명 (Components '공고 요약 상태' 문구 모양) */
function labelled(h, label, text) {
  return `<span><strong style="font-weight:700">${h.esc(label)}</strong> · ${h.esc(text)}</span>`;
}

/** 오류 박스 안 문장 앞에 상태 이름을 붙인다 (박스 모양·문장은 h.error 그대로) */
function errorWithLabel(h, label, message, next) {
  return h
    .error(message, next)
    .replace('</svg>', `</svg><span style="font-weight:500"><strong style="font-weight:700">${h.esc(label)}</strong> · `)
    .replace(/<\/p><\/div>$/, '</span></p></div>');
}

function statusBox(h, item) {
  if (!item) {
    return `<div class="notice status-none" role="status" style="background:var(--reasons-bg);border-color:var(--line);color:var(--ink-body)"><p>${h.icon('clock', { size: 18 })}${labelled(h, STATUS_LABEL.none, TEXT.pending)}</p></div>`;
  }
  if (item.status === 'ready') return h.notice(TEXT.ready, { kind: 'success', role: 'status' });
  if (item.status === 'unverified') {
    return h.notice(labelled(h, STATUS_LABEL.unverified, TEXT.unverified), { kind: 'warn', role: 'status', html: true });
  }
  if (item.status === 'no_text') return errorWithLabel(h, STATUS_LABEL.no_text, TEXT.noText, TEXT.noTextNext);
  if (item.status === 'failed') {
    return item.error === 'NO_KEY'
      ? errorWithLabel(h, STATUS_LABEL.failed, TEXT.noKey, TEXT.noKeyNext)
      : errorWithLabel(h, STATUS_LABEL.failed, TEXT.failed, TEXT.failedNext);
  }
  return '';
}

function lines(h, item) {
  if (!item || (item.status !== 'ready' && item.status !== 'unverified')) return '';
  const keys = Object.keys(FIELD_LABEL);
  const rows = keys
    .map((f, i) => `<div style="display:flex;flex-wrap:wrap;gap:6px 28px;padding:20px 0${i < keys.length - 1 ? ';border-bottom:1px solid var(--divider)' : ''}">
<dt style="flex:0 0 120px;font-size:14px;font-weight:700;color:var(--ink-2);padding-top:2px">${h.esc(FIELD_LABEL[f])}</dt>
<dd style="margin:0;flex:1 1 420px;min-width:0;font-size:16px;line-height:1.75">${h.esc(item[f] ?? '')}</dd>
</div>`)
    .join('');
  const evidence = item.evidence || [];
  const quotes = evidence
    .map((e) => {
      const miss = e.found === false ? `<span>${h.badge({ label: TEXT.quoteMissing, kind: 'check' })}</span>` : '';
      return `<li style="display:flex;flex-direction:column;gap:6px">
<span style="font-size:13px;font-weight:700;color:var(--ink-2)">${h.esc(FIELD_LABEL[e.field] ?? e.field)}</span>
<blockquote style="margin:0;padding:12px 16px;border-radius:10px;background:var(--reasons-bg);font-size:14px;line-height:1.7;color:var(--ink-body)">“${h.esc(e.quote)}”</blockquote>
${miss}
</li>`;
    })
    .join('');
  return `<section aria-label="${h.esc(TEXT.linesTitle)}" class="card" style="padding:8px 28px;margin:0">
<dl class="summary-lines" style="margin:0">${rows}</dl>
</section>
<details class="card evidence" style="padding:4px 28px 20px;margin:0"><summary style="min-height:52px;display:flex;align-items:center;gap:8px;font-size:15px;font-weight:700">${h.esc(TEXT.evidence)} <span style="font-weight:500;color:var(--ink-2)">· ${h.esc(TEXT.evidenceCount(evidence.length))}</span></summary><ul style="list-style:none;margin:4px 0 0;padding:0;display:flex;flex-direction:column;gap:12px">${quotes}</ul></details>`;
}

/**
 * 상세 (본문만. 공고 제목·눈썹 글은 routes 가 layout 의 heading·eyebrow 로 넘긴다)
 * @param {object} h ctx.html
 * @param {{ bid: object, item: object|null, today: string }} data
 */
export function detailBody(h, { bid, item, today }) {
  const url = safeUrl(bid.url);
  const sep = '<span aria-hidden="true" style="color:var(--line-input)">·</span>';
  const facts = [];
  if (bid.org) facts.push(`<span class="org">${h.esc(bid.org)}</span>`);
  facts.push(`<span style="font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums">${h.esc(deadlineText(h, bid.deadline, today))}</span>`);
  if (url) facts.push(originalLink(h, url, bid.title));
  return [
    // 위치 링크는 본문 앞에 두되 화면에서는 제목 위로 올린다 (order:-1)
    `<p class="breadcrumb" style="order:-1;font-size:14px"><a href="/summary" style="text-decoration:none;font-weight:500;min-height:36px;display:inline-flex;align-items:center">← ${h.esc(TEXT.back)}</a></p>`,
    `<p class="facts" style="margin-top:-8px;font-size:15px;display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px">${facts.join(sep)}</p>`,
    statusBox(h, item),
    lines(h, item),
    `<form method="post" action="/summary/${h.esc(encodeURIComponent(bid.bidId))}/regenerate" style="display:flex;flex-wrap:wrap;align-items:center;gap:12px 16px;padding-top:4px"><button type="submit" data-busy="${h.esc(TEXT.regenerateBusy)}">${h.icon('refresh', { size: 18 })}${h.esc(TEXT.regenerate)}</button><p style="margin:0;font-size:13px;color:var(--ink-2)">${h.esc(TEXT.regenerateHelp)}</p></form>`,
  ]
    .filter(Boolean)
    .join('\n');
}

export function notFoundBody(h) {
  return `${h.error(TEXT.notFound, TEXT.notFoundNext)}<p><a href="/summary">← ${h.esc(TEXT.back)}</a></p>`;
}
