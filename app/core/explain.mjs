// 왜 추천됐나: 공고 한 건이 조건 4개(키워드·제외어·지역·예산)에 각각 맞는지. 순수 함수, throw 없음
import { formatBudget, regionKeys } from '../../src/match.js';

export const EXPLAIN_TEXT = {
  summary: (met, total) => `왜 추천됐나 · ${met}/${total} 조건 맞음`,
  ok: '맞음',
  no: '안 맞음',
  unknown: '정보 없음',
};

function words(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const w = String(s ?? '').trim();
    if (w !== '' && !out.includes(w)) out.push(w);
  }
  return out;
}

function amount(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 시도 표준 키 목록. 인식 못 하면 원문 그대로 */
function keysOf(list) {
  const out = [];
  for (const r of words(list)) {
    const keys = regionKeys(r);
    for (const k of keys.length > 0 ? keys : [r]) if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** 공고의 지역: bid.region(문자열) → bid.limits.regions. 없으면 [] */
function bidRegions(bid) {
  if (typeof bid.region === 'string' && bid.region.trim() !== '') return keysOf([bid.region]);
  if (Array.isArray(bid.region)) return keysOf(bid.region);
  const limited = bid.limits && typeof bid.limits === 'object' ? bid.limits.regions : null;
  return keysOf(limited);
}

function keywordCheck(c, title, synonyms) {
  const keywords = words(c.keywords);
  const synWords = words((Array.isArray(synonyms) ? synonyms : []).map((s) => (s && typeof s === 'object' ? s.word : s)));
  const hit = [...keywords, ...synWords].find((w) => title.includes(w));
  if (hit !== undefined) return { id: 'keyword', ok: true, text: `키워드 '${hit}' 일치` };
  return { id: 'keyword', ok: false, text: keywords.length > 0 ? `키워드 없음 (${keywords.join('·')})` : '키워드 없음' };
}

function excludeCheck(c, title) {
  const hit = words(c.excludeKeywords).find((w) => title.includes(w));
  if (hit === undefined) return { id: 'exclude', ok: true, text: '제외어 없음' };
  return { id: 'exclude', ok: false, text: `제외어 '${hit}' 포함` };
}

function regionCheck(c, bid) {
  const wanted = keysOf(c.regions);
  if (wanted.length === 0) return { id: 'region', ok: true, text: '지역 제한 없음' };
  const have = bidRegions(bid);
  if (have.length === 0) return { id: 'region', ok: null, text: '지역 정보 없음' };
  const key = have.find((k) => wanted.includes(k));
  if (key !== undefined) return { id: 'region', ok: true, text: `지역 '${key}' 일치` };
  return { id: 'region', ok: false, text: `지역 '${have[0]}' 제외` };
}

function budgetCheck(c, bid) {
  const budget = amount(bid.budget);
  if (budget === null) return { id: 'budget', ok: null, text: '예산 정보 없음' };
  const min = amount(c.budgetMin);
  const max = amount(c.budgetMax);
  const inside = (min === null || budget >= min) && (max === null || budget <= max);
  return { id: 'budget', ok: inside, text: `예산 범위 ${inside ? '안' : '밖'} (${formatBudget(budget)})` };
}

/**
 * @param {object} criteria keywords·excludeKeywords·regions·budgetMin·budgetMax
 * @param {object} bid title·region 또는 limits.regions·budget
 * @param {{ synonyms?: Array<{word:string}> }} [opts]
 * @returns {{ checks: Array<{id:'keyword'|'exclude'|'region'|'budget', ok: boolean|null, text: string}>, met: number, total: 4 }}
 */
export function explainMatch(criteria, bid, { synonyms = [] } = {}) {
  const c = criteria && typeof criteria === 'object' ? criteria : {};
  const b = bid && typeof bid === 'object' ? bid : {};
  const title = String(b.title ?? '');
  const checks = [keywordCheck(c, title, synonyms), excludeCheck(c, title), regionCheck(c, b), budgetCheck(c, b)];
  return { checks, met: checks.filter((x) => x.ok === true).length, total: 4 };
}
