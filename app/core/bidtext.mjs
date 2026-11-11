// 공고 원문 텍스트: 첨부(pdf·txt·hwp·hwpx)를 받아 글자만 뽑고 bid_texts 에 캐시

import { hwpxText } from './hwpx.mjs';
import { hwpText } from './hwp.mjs';

const MAX_ATTACHMENTS = 5;
const TIMEOUT_MS = 20000;
const MAX_BYTES = 10 * 1024 * 1024;
// 요청 단계 상한 (safeFetch 기본 5MB 대신). 글자 뽑기는 위 MAX_BYTES 를 넘으면 건너뛴다
const FETCH_MAX_BYTES = 20 * 1024 * 1024;
const MAX_CHARS = 40000;
const SUPPORTED = new Set(['pdf', 'txt', 'hwp', 'hwpx']);
// 캐시 재사용 기간: ok 는 항상, failed 는 1시간, none 은 24시간 (첨부가 나중에 붙을 수 있다)
const FAILED_RETRY_MS = 60 * 60 * 1000;
const NONE_RECHECK_MS = 24 * 60 * 60 * 1000;

/** 캐시 행을 그대로 써도 되는지 (시간은 ctx.now() 기준) */
function isFresh(row, nowMs) {
  if (row.status === 'ok') return true;
  const at = Date.parse(row.fetched_at);
  if (!Number.isFinite(at)) return false;
  const limit = row.status === 'failed' ? FAILED_RETRY_MS : NONE_RECHECK_MS;
  return nowMs - at < limit;
}

function extOf(s) {
  const clean = String(s ?? '').split(/[?#]/)[0];
  const m = /\.([A-Za-z0-9]+)$/.exec(clean);
  return m ? m[1].toLowerCase() : '';
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return String(url ?? '');
  }
}

/** 'pdf'|'txt'|'hwp'|'hwpx' | 'unknown'(확장자 없음 → 응답 종류·매직바이트로 판단) | null(미지원) */
function kindOf(att) {
  const ext = extOf(att.name) || extOf(pathOf(att.url));
  if (SUPPORTED.has(ext)) return ext;
  return ext ? null : 'unknown';
}

/** content-type 으로 판단, 모르면 null */
function kindOfContentType(ct) {
  const t = String(ct || '').toLowerCase();
  if (t.includes('application/pdf')) return 'pdf';
  if (t.includes('text/plain')) return 'txt';
  if (t.includes('hwp+zip') || t.includes('hwpx')) return 'hwpx';
  if (t.includes('hwp')) return 'hwp';
  return null;
}

/** 매직바이트로 판단: %PDF, OLE 복합문서(HWP 5), zip(HWPX). 모르면 null */
function kindOfMagic(b) {
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (b.length >= 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1) return 'hwp';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return 'hwpx';
  return null;
}

/** 형식별 글자 뽑기. 파싱 실패는 throw */
async function extract(type, bytes) {
  if (type === 'pdf') return pdfText(bytes);
  if (type === 'hwpx') return hwpxText(bytes);
  if (type === 'hwp') return hwpText(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

class TooLarge extends Error {}

/** 10 MB 를 넘으면 TooLarge */
async function readCapped(res) {
  const len = Number(res.headers.get('content-length'));
  if (Number.isFinite(len) && len > MAX_BYTES) {
    if (res.body) await res.body.cancel().catch(() => {});
    throw new TooLarge();
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) throw new TooLarge();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

async function pdfText(bytes) {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const doc = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(doc, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : String(text ?? '');
}

/** @param {{db:any, now():Date, fetch: typeof fetch, bids:{get(id:string):Promise<object|null>}, log(id:string, m:string):void}} ctx */
export function create(ctx) {
  const { db } = ctx;
  const GET_SQL = 'SELECT status, text, fetched_at FROM bid_texts WHERE bid_id = $1';
  const PUT_SQL = `INSERT INTO bid_texts (bid_id, status, text, fetched_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, bid_id) DO UPDATE SET status = excluded.status, text = excluded.text, fetched_at = excluded.fetched_at`;

  /** @returns {Promise<string|null>} 텍스트, 건너뛰면 null. 네트워크·파싱 문제는 throw */
  const readAttachment = async (att) => {
    const kind = kindOf(att);
    if (kind === null) return null;
    let res;
    try {
      res = await ctx.fetch(att.url, { signal: AbortSignal.timeout(TIMEOUT_MS), maxBytes: FETCH_MAX_BYTES });
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') return null;
      throw err;
    }
    if (!res.ok) {
      if (res.body) await res.body.cancel().catch(() => {});
      throw new Error(`attachment status ${res.status}`);
    }
    // 확장자 → content-type → 매직바이트 순으로 형식을 정한다
    let type = kind === 'unknown' ? kindOfContentType(res.headers.get('content-type')) : kind;
    let bytes;
    try {
      bytes = await readCapped(res);
    } catch (err) {
      if (err instanceof TooLarge) return null;
      throw err;
    }
    if (type === null) type = kindOfMagic(bytes);
    if (type === null) return null;
    const text = await extract(type, bytes);
    // 스캔 PDF 처럼 글자가 없으면 null → 다른 첨부도 없으면 none
    const trimmed = text.trim();
    return trimmed ? trimmed : null;
  };

  const bidText = {
    /** @returns {Promise<{status:'ok'|'none'|'failed', text:string}>} */
    async get(bidId) {
      const id = String(bidId);
      const cached = await db.get(GET_SQL, [id]);
      if (cached && isFresh(cached, ctx.now().getTime())) return { status: cached.status, text: cached.text };
      const bid = await ctx.bids.get(id);
      if (!bid) return { status: 'none', text: '' };
      const atts = (Array.isArray(bid.raw && bid.raw.attachments) ? bid.raw.attachments : [])
        .filter((a) => a && typeof a.url === 'string' && a.url)
        .slice(0, MAX_ATTACHMENTS);
      const texts = [];
      let failed = false;
      for (const att of atts) {
        try {
          const t = await readAttachment(att);
          if (t) texts.push(t);
        } catch (err) {
          failed = true;
          ctx.log('bidtext', `attachment ${id} failed: ${err && err.message ? err.message : err}`);
        }
      }
      const result =
        texts.length > 0
          ? { status: 'ok', text: texts.join('\n\n').slice(0, MAX_CHARS) }
          : { status: failed ? 'failed' : 'none', text: '' };
      await db.run(PUT_SQL, [id, result.status, result.text, ctx.now().toISOString()]);
      return result;
    },
  };
  return { bidText };
}
