// 지난 개찰: 나라장터 개찰결과(1순위) + 공사 낙찰 목록(최종 낙찰) 조인 (사실만) + 24시간 캐시(history_results)
// 서비스 주소는 NARA_SCSBID_BASE (기본 /as/ScsbidInfoService, 두 오퍼레이션 같은 주소). 필드는 fixture README '확정 사항' 기준.
import pRetry, { AbortError } from 'p-retry';
import { normalizeNaraResponse } from '../../../src/match.js';
import { ERROR } from './view.mjs';

export const DEFAULT_SCSBID_BASE = 'https://apis.data.go.kr/1230000/as/ScsbidInfoService';
export const OPERATION = 'getOpengResultListInfoCnstwk';
export const AWARD_OPERATION = 'getScsbidListSttusCnstwk';
export const DEFAULT_DAYS = 30;
export const MAX_DAYS = 90;
export const MAX_QUERY = 60;
const CACHE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TIMEOUT_MS = 20000;

function intEnv(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isInteger(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** 검색어: 앞뒤 공백 제거, 연속 공백 하나로, 길이 상한 */
export function cleanQuery(q) {
  return String(q ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY);
}

/** 기간(일): 정수 1~90, 아니면 기본 30 */
export function cleanDays(days) {
  const n = Number.parseInt(String(days ?? ''), 10);
  if (!Number.isInteger(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, n);
}

/** Date → 'YYYYMMDD' (Asia/Seoul) */
function ymdKst(date) {
  const d = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

function num(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  return String(v ?? '').trim() || null;
}

function bidIdOf(item) {
  return `${String(item.bidNtceNo ?? '').trim()}-${String(item.bidNtceOrd ?? '000').trim() || '000'}`;
}

/** 개찰결과 item → 화면 행. top = opengCorpInfo('상호^사업자번호^대표자^금액^율') 첫 항목(개찰 1순위). award 는 항상 null */
export function toRow(item) {
  const corp = String(item.opengCorpInfo ?? '').split('^');
  return {
    bidId: bidIdOf(item),
    title: String(item.bidNtceNm ?? '').trim(),
    org: String(item.dminsttNm ?? '').trim() || String(item.ntceInsttNm ?? '').trim(),
    noticeOrg: String(item.ntceInsttNm ?? '').trim(),
    openingAt: str(item.opengDt),
    participants: num(item.prtcptCnum),
    status: str(item.progrsDivCdNm),
    top: { name: str(corp[0]), bizNo: str(corp[1]), amount: num(corp[3]), rate: num(corp[4]) },
    award: null,
  };
}

/** 낙찰 목록 item → { bidId, award }. 업체·사업자번호·금액·율·일시만 읽는다 (주소·전화·담당자는 읽지 않는다) */
export function toAward(item) {
  return {
    bidId: bidIdOf(item),
    award: {
      name: str(item.bidwinnrNm),
      bizNo: str(item.bidwinnrBizno),
      amount: num(item.sucsfbidAmt),
      rate: num(item.sucsfbidRate),
      at: str(item.fnlSucsfDate) ?? str(item.opengDt) ?? str(item.rlOpengDt),
    },
  };
}

/** bidId 로 낙찰 목록을 조인한 새 행 배열 (입력 불변). 같은 bidId 가 여러 번이면 처음 것 */
export function mergeAwards(rows, awards) {
  const byId = new Map();
  for (const a of awards) if (!byId.has(a.bidId)) byId.set(a.bidId, a.award);
  return rows.map((r) => ({ ...r, award: byId.has(r.bidId) ? { ...byId.get(r.bidId) } : null }));
}

/** 수요기관·공고기관·공고명 중 하나에 검색어(공백 무시)가 들어 있으면 true */
export function matchesQuery(row, q) {
  const needle = q.replace(/\s+/g, '');
  if (!needle) return false;
  return [row.org, row.noticeOrg, row.title].some((s) => String(s ?? '').replace(/\s+/g, '').includes(needle));
}

/** 응답 오류 → 화면 문구 */
function errorText(code) {
  if (code === '22') return ERROR.quota;
  if (code === '30') return ERROR.notRegistered;
  return /^\d+$/.test(code) ? ERROR.code(code) : ERROR.format;
}

function fail(message) {
  return Object.assign(new Error(message), { userMessage: message });
}

/** 한 페이지 요청. 연결 실패·5xx 는 재시도, 응답 코드 오류·4xx 는 바로 멈춘다 */
async function fetchPage(fetchImpl, url) {
  let res;
  let text;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    text = await res.text();
  } catch {
    throw fail(ERROR.connect);
  }
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  // 게이트웨이 오류: HTTP 4xx + OpenAPI_ServiceResponse
  const gw = data && data.OpenAPI_ServiceResponse && data.OpenAPI_ServiceResponse.cmmMsgHeader;
  if (gw) throw new AbortError(fail(errorText(String(gw.returnReasonCode ?? '').trim())));
  if (!res.ok) {
    if (res.status >= 500) throw fail(ERROR.connect);
    throw new AbortError(fail(ERROR.code(String(res.status))));
  }
  let items;
  try {
    items = normalizeNaraResponse(data ?? text);
  } catch (e) {
    const msg = e && e.message ? e.message : '';
    const code = msg.startsWith('NARA_API_ERROR:') ? msg.slice('NARA_API_ERROR:'.length).trim().split(/\s+/)[0] : '';
    throw new AbortError(fail(errorText(code)));
  }
  const total = num(data && data.response && data.response.body && data.response.body.totalCount);
  return { items, total };
}

/** @param {{db:any, now():Date, env:Record<string,string>, fetch: typeof fetch, log(id:string, m:string):void, bids?: {get(id:string):Promise<object|null>}}} ctx */
export function createService(ctx) {
  const GET_SQL = 'SELECT fetched_at, rows FROM history_results WHERE query_key = $1';
  const PUT_SQL =
    'INSERT INTO history_results (query_key, fetched_at, rows) VALUES ($1, $2, $3) ON CONFLICT (workspace_id, query_key) DO UPDATE SET fetched_at = excluded.fetched_at, rows = excluded.rows';

  function hasKey() {
    return String((ctx.env && ctx.env.NARA_API_KEY) || '').trim() !== '';
  }

  async function readCache(key) {
    const row = await ctx.db.get(GET_SQL, [key]);
    if (!row) return null;
    const at = Date.parse(row.fetched_at);
    if (!Number.isFinite(at) || ctx.now().getTime() - at >= CACHE_MS) return null;
    try {
      const v = JSON.parse(row.rows);
      return v && Array.isArray(v.rows) ? v : null;
    } catch {
      return null;
    }
  }

  /** 한 오퍼레이션의 페이지를 NARA_MAX_PAGES 까지 모은다. 같은 창·inqryDiv=1·재시도 설정 */
  async function fetchPages(operation, fromYmd, until) {
    const env = ctx.env || {};
    const key = String(env.NARA_API_KEY).trim();
    const base = String(env.NARA_SCSBID_BASE || DEFAULT_SCSBID_BASE).replace(/\/+$/, '');
    const rows = intEnv(env.NARA_ROWS, 500, 1, 999);
    const maxPages = intEnv(env.NARA_MAX_PAGES, 20, 1, 1000);
    const retries = intEnv(env.NARA_RETRY, 3, 0, 10);
    const items = [];
    let truncated = 0;
    for (let page = 1; ; page++) {
      const u = new URL(`${base}/${operation}`);
      u.searchParams.set('serviceKey', key);
      u.searchParams.set('type', 'json');
      u.searchParams.set('inqryDiv', '1');
      u.searchParams.set('inqryBgnDt', `${fromYmd}0000`);
      u.searchParams.set('inqryEndDt', `${ymdKst(until)}2359`);
      u.searchParams.set('numOfRows', String(rows));
      u.searchParams.set('pageNo', String(page));
      const got = await pRetry(() => fetchPage(ctx.fetch, u.toString()), { retries, minTimeout: 300, factor: 2 });
      items.push(...got.items);
      const total = got.total ?? items.length;
      if (got.items.length === 0 || items.length >= total) break;
      if (page >= maxPages) {
        truncated = page;
        break;
      }
    }
    return { items, truncated };
  }

  async function fetchAll(q, days) {
    const env = ctx.env || {};
    const until = ctx.now();
    const since = new Date(until.getTime() - days * DAY_MS);
    const fromYmd = ymdKst(since);
    const { items, truncated } = await fetchPages(OPERATION, fromYmd, until);
    const fromDate = `${fromYmd.slice(0, 4)}-${fromYmd.slice(4, 6)}-${fromYmd.slice(6, 8)}`;
    const list = items
      .map(toRow)
      .filter((r) => matchesQuery(r, q))
      .filter((r) => !r.openingAt || r.openingAt.slice(0, 10) >= fromDate)
      .sort((a, b) => String(b.openingAt ?? '').localeCompare(String(a.openingAt ?? '')));
    // 낙찰 목록: 실패해도 개찰 1순위만으로 보여 준다 (awardsMissing)
    const awardOp = String(env.NARA_AWARD_OPERATION || '').trim() || AWARD_OPERATION;
    try {
      const got = await fetchPages(awardOp, fromYmd, until);
      return { rows: mergeAwards(list, got.items.map(toAward)), truncated, awardsMissing: false };
    } catch (err) {
      const message = err && err.userMessage ? err.userMessage : ERROR.format;
      ctx.log('history', `awards failed: ${message}`);
      return { rows: list, truncated, awardsMissing: true };
    }
  }

  return {
    hasKey,

    /**
     * @returns {Promise<null | { status: 'ok', rows: object[], cached: boolean, truncated: number, awardsMissing: boolean } | { status: 'noKey' } | { status: 'error', message: string }>}
     *   검색어가 비면 null (요청 없음). 키가 없으면 noKey (요청 없음). awardsMissing 이면 캐시에 쓰지 않는다.
     */
    async search({ q, days } = {}) {
      const query = cleanQuery(q);
      const d = cleanDays(days);
      if (!query) return null;
      if (!hasKey()) return { status: 'noKey' };
      const cacheKey = `v2|${query}|${d}`;
      const hit = await readCache(cacheKey);
      if (hit) return { status: 'ok', rows: hit.rows, truncated: hit.truncated || 0, cached: true, awardsMissing: false };
      try {
        const got = await fetchAll(query, d);
        if (!got.awardsMissing) {
          await ctx.db.run(PUT_SQL, [cacheKey, ctx.now().toISOString(), JSON.stringify({ rows: got.rows, truncated: got.truncated })]);
        }
        return { status: 'ok', rows: got.rows, truncated: got.truncated, cached: false, awardsMissing: got.awardsMissing };
      } catch (err) {
        const message = err && err.userMessage ? err.userMessage : ERROR.format;
        ctx.log('history', `search failed: ${message}`);
        return { status: 'error', message };
      }
    },

    /** 공고의 수요기관 이름 (뱃지 링크용). 모르면 '' */
    async orgOf(bidId) {
      const bid = ctx.bids && typeof ctx.bids.get === 'function' ? await ctx.bids.get(bidId) : null;
      return bid ? String(bid.org ?? '').trim() : '';
    },
  };
}
