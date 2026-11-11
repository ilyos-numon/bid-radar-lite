// 실제 나라장터 입찰공고 API 를 한 번 호출해 응답 형식을 확인한다.
// 사용: npm run smoke:live  (NARA_API_KEY 는 .env 에서 읽는다. 키 값은 출력하지 않는다)
import { pathToFileURL } from 'node:url';
import { normalizeNaraResponse } from '../src/match.js';

const DEFAULT_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
const DEFAULT_OPERATION = 'getBidPblancListInfoCnstwk';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * @param {{base:string, operation:string, key:string, from:string, to:string, rows?:number, pageNo?:number, inqryDiv?:number}} p
 *   inqryDiv: 1 = 공고게시일시, 3 = 변경일시
 * @returns {string}
 */
export function buildNaraUrl({ base, operation, key, from, to, rows = 10, pageNo = 1, inqryDiv = 1 }) {
  const params = new URLSearchParams({
    serviceKey: key,
    type: 'json',
    inqryDiv: String(inqryDiv),
    pageNo: String(pageNo),
    numOfRows: String(rows),
    inqryBgnDt: from,
    inqryEndDt: to,
  });
  return `${String(base).replace(/\/+$/, '')}/${operation}?${params.toString()}`;
}

/** Date -> yyyyMMddHHmm (Asia/Seoul) */
function formatKst(date) {
  const d = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getUTCFullYear() +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes())
  );
}

/** 수집기가 NARA_ROWS(기본 500)로 요청할 페이지 수 */
export function pagesFor(totalCount, rowsEnv) {
  const n = Number.parseInt(String(rowsEnv ?? ''), 10);
  const rows = Number.isFinite(n) && n >= 1 ? Math.min(n, 999) : 500;
  return Math.max(1, Math.ceil((Number(totalCount) || 0) / rows));
}

function redact(text, key) {
  return key ? String(text).split(key).join('***') : String(text);
}

async function main() {
  const key = process.env.NARA_API_KEY || '';
  if (!key) {
    console.log('LIVE_SKIP NARA_API_KEY missing');
    process.exit(2);
  }
  const now = new Date();
  const url = buildNaraUrl({
    base: process.env.NARA_API_BASE || DEFAULT_BASE,
    operation: process.env.NARA_BID_OPERATION || DEFAULT_OPERATION,
    key,
    from: formatKst(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
    to: formatKst(now),
  });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${text.slice(0, 100)}`);
    }
    normalizeNaraResponse(text);
    const data = JSON.parse(text);
    const totalCount = data.response.body ? data.response.body.totalCount : undefined;
    console.log(`LIVE_OK resultCode=00 totalCount=${totalCount ?? 0} pages=${pagesFor(totalCount, process.env.NARA_ROWS)}`);
    process.exit(0);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    console.log(`LIVE_FAIL ${redact(msg, key).replace(/\s+/g, ' ').trim()}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
