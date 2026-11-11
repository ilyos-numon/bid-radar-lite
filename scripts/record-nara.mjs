// 나라장터 보조 오퍼레이션을 각 1회 호출해 응답 구조·필드명을 확인한다 (fixture 작성용).
// 사용: npm run record:nara [-- --out <dir>]  (NARA_API_KEY 는 .env 에서 읽는다. 키 값은 출력하지 않는다)
// --only a,b 로 일부 오퍼레이션만 다시 호출한다. --out 을 주면 업체명·사업자번호·대표자를 치환한 앞 3건 샘플을 <dir>/<name>.sample.json 으로 저장한다.
// --days N(1~90, 기본 1) 조회 창 일수, --rows N(1~100, 기본 5) numOfRows, --op <name>=<operation> 오퍼레이션명 바꿔 호출(여러 번 가능).
// 녹화 결과는 그대로 커밋하지 않는다. tests/fixtures/nara/*.json 은 구조만 따서 합성한다.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BID_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
const PRESTD_BASE = 'https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService';
const SCSBID_BASE = 'https://apis.data.go.kr/1230000/as/ScsbidInfoService';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 오퍼레이션당 1회. 합계 10회 이하. */
export const OPERATIONS = [
  { name: 'list-cnstwk', base: 'NARA_API_BASE', operation: 'getBidPblancListInfoCnstwk', inqryDiv: '1' },
  { name: 'list-cnstwk-changed', base: 'NARA_API_BASE', operation: 'getBidPblancListInfoCnstwk', inqryDiv: '3' },
  { name: 'license-limit', base: 'NARA_API_BASE', operation: 'getBidPblancListInfoLicenseLimit', inqryDiv: '1' },
  { name: 'region-limit', base: 'NARA_API_BASE', operation: 'getBidPblancListInfoPrtcptPsblRgn', inqryDiv: '1' },
  { name: 'base-amount', base: 'NARA_API_BASE', operation: 'getBidPblancListInfoCnstwkBsisAmount', inqryDiv: '1' },
  { name: 'prestd-cnstwk', base: 'NARA_PRESTD_BASE', operation: 'getPublicPrcureThngInfoCnstwk', inqryDiv: '1' },
  { name: 'openg-result-cnstwk', base: 'NARA_SCSBID_BASE', operation: 'getOpengResultListInfoCnstwk', inqryDiv: '1' },
  { name: 'scsbid-list-cnstwk', base: 'NARA_SCSBID_BASE', operation: 'getScsbidListSttusCnstwk', inqryDiv: '1' },
];

const DEFAULT_BASES = { NARA_API_BASE: BID_BASE, NARA_PRESTD_BASE: PRESTD_BASE, NARA_SCSBID_BASE: SCSBID_BASE };

/** 문자열에서 키(원문·URL 인코딩)를 *** 로 바꾼다. */
export function maskKey(text, key) {
  let out = String(text);
  if (!key) return out;
  for (const k of [key, encodeURIComponent(key)]) out = out.split(k).join('***');
  return out;
}

const NAME_FIELDS = ['bidwinnrNm', 'prcbdrNm', 'corpNm', 'sucsfbidCorpNm', 'opengCorpNm', 'fnlSucsfCorpNm'];
const BIZNO_FIELDS = ['bidwinnrBizno', 'prcbdrBizno', 'bizno', 'corpBizno', 'fnlSucsfCorpBizno'];
const CEO_FIELDS = ['bidwinnrCeoNm', 'prcbdrCeoNm', 'ceoNm', 'rprsntvNm', 'fnlSucsfCorpCeoNm'];
const FREE_TEXT_FIELDS = ['opengRsltNtcCntnts'];
const PERSON_FIELDS = ['ntceInsttOfclNm', 'exctvNm', 'dminsttOfclNm', 'ofclNm', 'fnlSucsfCorpOfcl'];
const CONTACT_FIELDS = ['ntceInsttOfclTelNo', 'ntceInsttOfclEmailAdrs', 'dminsttOfclEmailAdrs', 'dminsttOfclTelNo', 'ofclTelNo', 'bidwinnrTelNo', 'bidwinnrAdrs'];
const ALIASES = ['업체A', '업체B', '업체C', '업체D', '업체E'];

/**
 * 업체명 → 업체A~E(등장 순서, 같은 이름은 같은 별칭), 사업자번호 → 0000000000, 대표자 → 대표자,
 * 공고 담당자 → 담당자, 담당자 연락처 → ''.
 * opengCorpInfo('상호^사업자번호^대표자^금액^율') 도 같은 규칙으로 바꾼다. 입력은 바꾸지 않는다.
 * @param {object[]} items
 * @returns {object[]}
 */
export function anonymizeItems(items) {
  const map = new Map();
  const alias = (name) => {
    const n = String(name).trim();
    if (!n) return n;
    if (!map.has(n)) map.set(n, ALIASES[map.size % ALIASES.length]);
    return map.get(n);
  };
  return (Array.isArray(items) ? items : []).map((item) => {
    const o = { ...item };
    for (const f of NAME_FIELDS) if (typeof o[f] === 'string' && o[f]) o[f] = alias(o[f]);
    for (const f of BIZNO_FIELDS) if (typeof o[f] === 'string' && o[f]) o[f] = '0000000000';
    for (const f of CEO_FIELDS) if (typeof o[f] === 'string' && o[f]) o[f] = '대표자';
    for (const f of PERSON_FIELDS) if (typeof o[f] === 'string' && o[f]) o[f] = '담당자';
    for (const f of CONTACT_FIELDS) if (typeof o[f] === 'string' && o[f]) o[f] = '';
    for (const f of FREE_TEXT_FIELDS) if (typeof o[f] === 'string' && o[f]) o[f] = '';
    if (typeof o.opengCorpInfo === 'string' && o.opengCorpInfo) {
      const parts = o.opengCorpInfo.split('^');
      if (parts[0]) parts[0] = alias(parts[0]);
      if (parts.length > 1 && parts[1]) parts[1] = '0000000000';
      if (parts.length > 2 && parts[2]) parts[2] = '대표자';
      o.opengCorpInfo = parts.join('^');
    }
    return o;
  });
}

/**
 * 응답 본문 → {resultCode, resultMsg, totalCount, fields, items}. JSON·XML(게이트웨이 오류) 둘 다.
 * @param {string} text
 */
export function fieldSummary(text) {
  const s = String(text);
  try {
    const j = JSON.parse(s);
    const gw = j.OpenAPI_ServiceResponse && j.OpenAPI_ServiceResponse.cmmMsgHeader;
    if (gw) {
      return { resultCode: String(gw.returnReasonCode ?? ''), resultMsg: String(gw.returnAuthMsg || gw.errMsg || ''), totalCount: null, fields: [], items: [] };
    }
    const r = j.response || j['nkoneps.com.response.ResponseError'] || {};
    const h = r.header || {};
    const b = r.body || {};
    let items = b.items;
    if (items && !Array.isArray(items)) items = Array.isArray(items.item) ? items.item : items.item ? [items.item] : [];
    items = Array.isArray(items) ? items : [];
    const fields = [];
    for (const it of items) for (const k of Object.keys(it || {})) if (!fields.includes(k)) fields.push(k);
    return {
      resultCode: String(h.resultCode ?? ''),
      resultMsg: String(h.resultMsg ?? ''),
      totalCount: b.totalCount ?? null,
      fields,
      items,
    };
  } catch {
    const tag = (t) => {
      const m = s.match(new RegExp(`<${t}>([^<]*)</${t}>`));
      return m ? m[1].trim() : '';
    };
    return {
      resultCode: tag('returnReasonCode') || tag('resultCode'),
      resultMsg: tag('returnAuthMsg') || tag('errMsg') || tag('resultMsg'),
      totalCount: null,
      fields: [],
      items: [],
    };
  }
}

/** Date -> yyyyMMddHHmm (Asia/Seoul) */
function formatKst(date) {
  const d = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes());
}

/**
 * 명령줄 옵션 → {only, out, days, rows, ops}. 범위를 벗어나거나 형식이 틀리면 Error.
 * @param {string[]} argv process.argv.slice(2)
 */
export function parseArgs(argv) {
  const opts = { only: [], out: '', days: 1, rows: 5, ops: {} };
  const names = OPERATIONS.map((o) => o.name);
  const int = (flag, v, min, max) => {
    const n = Number(v);
    if (!/^\d+$/.test(String(v)) || n < min || n > max) throw new Error(`${flag} must be ${min}~${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === '--only') opts.only = String(v || '').split(',').filter(Boolean);
    else if (a === '--out') opts.out = v || '';
    else if (a === '--days') opts.days = int('--days', v, 1, 90);
    else if (a === '--rows') opts.rows = int('--rows', v, 1, 100);
    else if (a === '--op') {
      const m = String(v || '').match(/^([^=]+)=(\w+)$/);
      if (!m) throw new Error('--op must be <name>=<operation>');
      if (!names.includes(m[1])) throw new Error(`--op unknown name ${m[1]}`);
      opts.ops[m[1]] = m[2];
    } else continue;
    i += 1;
  }
  return opts;
}

/**
 * 호출 URL. 조회 창 = now - days ~ now (KST yyyyMMddHHmm), numOfRows = rows.
 * @param {{base:string, operation:string, inqryDiv:string}} op
 */
export function buildUrl(op, key, env, now, { days = 1, rows = 5 } = {}) {
  const base = String(env[op.base] || DEFAULT_BASES[op.base]).replace(/\/+$/, '');
  const params = new URLSearchParams({
    serviceKey: key,
    type: 'json',
    inqryDiv: op.inqryDiv,
    pageNo: '1',
    numOfRows: String(rows),
    inqryBgnDt: formatKst(new Date(now.getTime() - days * DAY_MS)),
    inqryEndDt: formatKst(now),
  });
  return `${base}/${op.operation}?${params.toString()}`;
}

async function main() {
  const key = process.env.NARA_API_KEY || '';
  if (!key) {
    console.log('RECORD_SKIP NARA_API_KEY missing');
    process.exit(2);
  }
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.log(`RECORD_ARG_ERROR ${e.message}`);
    process.exit(2);
  }
  const { out, only, days, rows } = opts;
  if (out) mkdirSync(out, { recursive: true });
  const now = new Date();
  let failed = 0;
  for (const base of OPERATIONS) {
    if (only.length && !only.includes(base.name)) continue;
    const op = opts.ops[base.name] ? { ...base, operation: opts.ops[base.name] } : base;
    try {
      const res = await fetch(buildUrl(op, key, process.env, now, { days, rows }), { signal: AbortSignal.timeout(20000) });
      const text = await res.text();
      const s = fieldSummary(text);
      const ok = res.ok && s.resultCode === '00';
      if (!ok) failed += 1;
      console.log(
        maskKey(
          `RECORD ${op.name} op=${op.operation} inqryDiv=${op.inqryDiv} http=${res.status} code=${s.resultCode || '?'} ` +
            `msg=${s.resultMsg.replace(/\s+/g, ' ')} total=${s.totalCount ?? '?'} fields=${s.fields.join(',')}`,
          key,
        ),
      );
      if (!ok && !s.resultCode) console.log(maskKey(`  body=${text.slice(0, 200).replace(/\s+/g, ' ')}`, key));
      if (out) {
        const sample = { op: op.operation, inqryDiv: op.inqryDiv, resultCode: s.resultCode, totalCount: s.totalCount, fields: s.fields, items: anonymizeItems(s.items.slice(0, 3)) };
        const linked = s.items.filter((i) => i && typeof i.bidNtceNoList === 'string' && i.bidNtceNoList.trim());
        if ('bidNtceNoList' in (s.items[0] || {})) Object.assign(sample, { bidNtceNoListFilled: linked.length, bidNtceNoListItems: anonymizeItems(linked.slice(0, 3)) });
        writeFileSync(path.join(out, `${op.name}.sample.json`), maskKey(JSON.stringify(sample, null, 2), key) + '\n');
      }
    } catch (e) {
      failed += 1;
      const msg = e && e.message ? e.message : String(e);
      console.log(`RECORD_FAIL ${op.name} ${maskKey(msg, key).replace(/\s+/g, ' ').trim()}`);
    }
  }
  console.log(`RECORD_DONE failed=${failed}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
