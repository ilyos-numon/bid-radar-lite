// 지난 개찰 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).
// 공개된 개찰 결과만 그대로 보여 준다. 가능성·확률·적정 금액은 계산하지 않는다.

export const MENU = {
  title: '지난 개찰',
  help: '수요기관이나 공고명으로 지난 개찰 결과와 낙찰자를 찾아봅니다.',
};

export const BADGE_LABEL = '지난 개찰 보기';

export const DISCLAIMER = '공개된 개찰 결과만 보여 줍니다. 낙찰 가능성은 계산하지 않습니다.';

export const LEGEND = '낙찰자는 낙찰이 확정된 업체이고, 개찰 1순위는 개찰 당시 1순위 투찰 업체입니다. 1순위는 적격심사 뒤 바뀔 수 있습니다.';

export const DAY_CHOICES = [7, 30, 90];

export const TEXT = {
  queryLabel: '수요기관 또는 공고명',
  queryHint: '예: 수원시, 도로 포장',
  daysLabel: '기간',
  dayOption: (n) => `최근 ${n}일`,
  searchButton: '찾기',
  needQuery: '수요기관이나 공고명을 적고 찾기를 눌러 주세요.',
  noKey: '나라장터 인증키가 없어 개찰 결과를 가져오지 않았습니다. 운영자에게 인증키를 넣어 달라고 알려 주세요.',
  noRows: (q) => `'${q}' 와 맞는 개찰 결과가 없습니다. 다른 이름으로 찾거나 기간을 늘려 보세요.`,
  cached: '24시간 안에 가져온 결과를 다시 보여 줍니다.',
  truncated: (n) => `개찰 결과가 많아 일부만 가져왔습니다 (${n}페이지). 검색어를 좁혀 보세요.`,
  caption: (n) => `개찰 결과 ${n}건`,
  awardsMissing: '낙찰 확정 정보를 가져오지 못해 개찰 1순위만 보여 줍니다. 잠시 뒤 다시 찾아 주세요.',
  awarded: '낙찰자',
  top: '개찰 1순위',
  col: {
    title: '공고명',
    openingAt: '개찰일시',
    participants: '참가수',
    result: '낙찰자 / 개찰 1순위',
    amount: '금액',
    rate: '낙찰률 · 투찰률',
  },
  none: '-',
};

/** 오류 문구 (어떤 일이 안 됐는지 + 다음 행동) */
export const ERROR = {
  quota: '개찰 결과를 가져오지 못했습니다 (오늘 조회 한도를 넘었습니다). 내일 다시 시도하거나 운영자에게 알려 주세요.',
  notRegistered: '개찰 결과를 가져오지 못했습니다 (인증키가 개찰 결과 조회에 등록되지 않았습니다). 운영자에게 알려 주세요.',
  code: (code) => `개찰 결과를 가져오지 못했습니다 (나라장터 응답 오류 ${code}). 잠시 뒤 다시 찾아 주세요.`,
  connect: '나라장터에 연결하지 못했습니다. 잠시 뒤 다시 찾아 주세요.',
  format: '개찰 결과를 가져오지 못했습니다 (나라장터 응답 형식이 다름). 잠시 뒤 다시 찾아 주세요.',
};

function won(n) {
  return n === null || n === undefined ? TEXT.none : `${Number(n).toLocaleString('ko-KR')}원`;
}

function rate(n) {
  return n === null || n === undefined ? TEXT.none : `${n}%`;
}

function people(n) {
  return n === null || n === undefined ? TEXT.none : `${Number(n).toLocaleString('ko-KR')}곳`;
}

function searchForm(h, { q, days }) {
  const options = DAY_CHOICES.map(
    (n) => `<option value="${n}"${n === days ? ' selected' : ''}>${h.esc(TEXT.dayOption(n))}</option>`,
  ).join('');
  return `<form class="stack" method="get" action="/history" role="search">
<label for="q">${h.esc(TEXT.queryLabel)}<input id="q" name="q" value="${h.esc(q)}" placeholder="${h.esc(TEXT.queryHint)}"></label>
<label for="days">${h.esc(TEXT.daysLabel)}<select id="days" name="days">${options}</select></label>
<p><button type="submit">${h.esc(TEXT.searchButton)}</button></p>
</form>`;
}

/** 낙찰 확정이면 낙찰자, 아니면 개찰 1순위. 고른 쪽 이름이 없으면 '-' */
function pick(r) {
  if (r.award) return { chip: 'awarded', label: TEXT.awarded, who: r.award };
  return { chip: 'top', label: TEXT.top, who: r.top || {} };
}

function resultCell(h, p) {
  if (!p.who.name) return h.esc(TEXT.none);
  return `<span class="kind-chip kind-${p.chip}">${h.esc(p.label)}</span> ${h.esc(p.who.name)}`;
}

/** 예시 데이터 칩 (헬퍼에 없으면 빈 글자) */
function exampleTag(h, example) {
  if (!example || typeof h.exampleChip !== 'function') return '';
  return ` ${h.exampleChip()}`;
}

function table(h, rows, example = false) {
  const c = TEXT.col;
  const head = [c.title, c.openingAt, c.participants, c.result, c.amount, c.rate]
    .map((t) => `<th scope="col">${h.esc(t)}</th>`)
    .join('');
  const body = rows
    .map((r) => {
      const p = pick(r);
      return `<tr data-bid="${h.esc(r.bidId)}"><td>${h.esc(r.title)}${exampleTag(h, example)}<br><small>${h.esc(r.org)}</small></td><td>${h.dateTime(r.openingAt) || h.esc(TEXT.none)}</td><td>${h.esc(people(r.participants))}</td><td>${resultCell(h, p)}</td><td>${h.esc(won(p.who.amount))}</td><td>${h.esc(rate(p.who.rate))}</td></tr>`;
    })
    .join('');
  return `<div class="card" style="overflow-x:auto"><table><caption>${h.esc(TEXT.caption(rows.length))}</caption><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/**
 * @param {object} h ctx.html
 * @param {{ q: string, days: number, result: null | { status: 'ok'|'noKey'|'error', rows?: object[], message?: string, cached?: boolean, truncated?: number, awardsMissing?: boolean }, example?: boolean }} data
 */
export function historyBody(h, { q, days, result, example = false }) {
  const parts = [h.notice(DISCLAIMER, { kind: 'info' }), `<p class="help">${h.esc(LEGEND)}</p>`, searchForm(h, { q, days })];
  if (!result) {
    parts.push(h.empty(TEXT.needQuery));
  } else if (result.status === 'noKey') {
    parts.push(h.notice(TEXT.noKey, { kind: 'warn', role: 'status' }));
  } else if (result.status === 'error') {
    parts.push(`<div class="error" role="alert"><p>${h.icon('alert-circle', { size: 18 })}${h.esc(result.message)}</p></div>`);
  } else {
    if (result.truncated) parts.push(h.notice(TEXT.truncated(result.truncated), { kind: 'warn' }));
    if (result.awardsMissing) parts.push(h.notice(TEXT.awardsMissing, { kind: 'warn', role: 'status' }));
    if (result.cached) parts.push(`<p class="help">${h.esc(TEXT.cached)}</p>`);
    parts.push(result.rows.length === 0 ? h.empty(TEXT.noRows(q)) : table(h, result.rows, example));
  }
  return parts.join('\n');
}
