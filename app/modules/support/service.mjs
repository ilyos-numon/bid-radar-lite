// 지원사업: 수집·정규화·저장·키워드 매칭·알림 항목 (외부 호출은 ctx.fetch, 설정값은 ctx.env 만 쓴다)
// 응답 구조는 실제로 확인하지 못했다. 배열·단일 객체·빈 값·response.body.items.item·items·jsonArray 를 모두 받아 배열로 만든다.

const FETCH_TIMEOUT_MS = 20000;
const WRAPPER_KEYS = ['jsonArray', 'response', 'body', 'items', 'item', 'data'];

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** @param {Record<string, string|undefined>} env */
export function hasKey(env) {
  const e = env || {};
  return str(e.SUPPORT_API_KEY) !== '' && str(e.SUPPORT_API_BASE) !== '';
}

/** 인증키가 이미 퍼센트 인코딩돼 있으면 그대로, 아니면 인코딩한다 */
function encodeKey(key) {
  return /%[0-9A-Fa-f]{2}/.test(key) ? key : encodeURIComponent(key);
}

/** @returns {string} `${base}?serviceKey=<키>&type=json&numOfRows=100&pageNo=1` */
export function buildSupportUrl(base, key) {
  const b = str(base);
  const sep = b.includes('?') ? '&' : '?';
  return `${b}${sep}serviceKey=${encodeKey(str(key))}&type=json&numOfRows=100&pageNo=1`;
}

function isItem(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && ('pblancId' in v || 'pblancNm' in v);
}

/** 응답 본문(파싱된 JSON)에서 공고 원본 배열을 꺼낸다 */
export function extractItems(data, depth = 0) {
  if (depth > 6 || data === null || data === undefined || typeof data !== 'object') return [];
  if (Array.isArray(data)) {
    const direct = data.filter(isItem);
    if (direct.length > 0) return direct;
    return data.flatMap((x) => extractItems(x, depth + 1));
  }
  if (isItem(data)) return [data];
  for (const k of WRAPPER_KEYS) {
    if (data[k] !== undefined) {
      const found = extractItems(data[k], depth + 1);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/** 응답에 결과 코드가 있고 정상(0, 00)이 아니면 그 코드, 아니면 null */
export function resultCodeError(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const header = (data.response && data.response.header) || data.header || null;
  const code = header ? str(header.resultCode) : str(data.resultCode);
  if (code === '' || /^0+$/.test(code)) return null;
  return code;
}

/** '20261001 ~ 20261130' → '2026-11-30'. '~' 가 없거나 날짜가 아니면 '' */
export function parseApplyEnd(value) {
  const s = str(value);
  const i = s.indexOf('~');
  if (i < 0) return '';
  const digits = s.slice(i + 1).replace(/\D/g, '');
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(digits);
  if (!m) return '';
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** @returns {{id:string,title:string,org:string,applyEnd:string,url:string,summary:string,region:string}|null} */
export function normalizeItem(raw) {
  if (!isItem(raw)) return null;
  const id = str(raw.pblancId);
  const title = str(raw.pblancNm);
  if (id === '' || title === '') return null;
  return {
    id,
    title,
    org: str(raw.jrsdInsttNm),
    applyEnd: parseApplyEnd(raw.reqstBeginEndDe),
    url: str(raw.pblancUrl),
    summary: str(raw.bsnsSumryCn),
    region: str(raw.trgetNm),
  };
}

/** 응답 본문 → 정규화된 항목 배열 (같은 id 는 마지막 것만) */
export function normalizeResponse(data) {
  const byId = new Map();
  for (const raw of extractItems(data)) {
    const it = normalizeItem(raw);
    if (it) byId.set(it.id, it);
  }
  return [...byId.values()];
}

/**
 * 키워드: title 또는 summary 포함. 지역(있으면): org 또는 region 포함.
 * @returns {string[]|null} reasons (일치하지 않으면 null)
 */
export function matchItem(item, keywords, regions) {
  const text = [str(item.title), str(item.summary)];
  const reasons = [];
  for (const kw of keywords || []) {
    if (kw && text.some((t) => t.includes(kw))) reasons.push(`키워드 '${kw}' 일치`);
  }
  if (reasons.length === 0) return null;
  const regs = (regions || []).filter(Boolean);
  if (regs.length > 0) {
    const where = [str(item.org), str(item.region)];
    const r = regs.find((x) => where.some((w) => w.includes(x)));
    if (r === undefined) return null;
    reasons.push(`지역 '${r}' 일치`);
  }
  return reasons;
}

function parseList(json) {
  if (json === null || json === undefined) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : null;
  } catch {
    return null;
  }
}

/**
 * 지원사업 키워드. 저장된 값이 없으면 입찰 조건의 키워드로 시작한다.
 * @param {{persist?: boolean}} opts persist 이면 첫 방문 초기값을 저장한다
 */
export async function getKeywords(ctx, { persist = false } = {}) {
  const saved = parseList(await ctx.settings.get('support.keywords'));
  if (saved !== null) return saved;
  const c = ctx.criteria && typeof ctx.criteria.get === 'function' ? await ctx.criteria.get() : null;
  const initial = c && Array.isArray(c.keywords) ? c.keywords.map((x) => str(x)).filter(Boolean) : [];
  if (persist) await ctx.settings.set('support.keywords', JSON.stringify(initial));
  return initial;
}

export async function getRegions(ctx) {
  return parseList(await ctx.settings.get('support.regions')) || [];
}

export async function saveFilters(ctx, { keywords, regions }) {
  await ctx.settings.set('support.keywords', JSON.stringify(keywords));
  await ctx.settings.set('support.regions', JSON.stringify(regions));
}

/** '조경, 공원' → ['조경','공원'] */
export function splitList(s) {
  const out = [];
  for (const x of String(s ?? '').split(/[,，、\n]/)) {
    const v = x.trim();
    if (v !== '' && !out.includes(v)) out.push(v);
  }
  return out;
}

async function recordRun(ctx, ok, count, error) {
  await ctx.db.run('INSERT INTO support_runs (ran_at, ok, count, error) VALUES ($1, $2, $3, $4)', [
    ctx.now().toISOString(),
    ok ? 1 : 0,
    count,
    error,
  ]);
}

async function storedFirstSeen(ctx, id) {
  const row = await ctx.db.get('SELECT first_seen FROM support_items WHERE id = $1', [id]);
  return row ? row.first_seen : null;
}

const UPSERT_ITEM = `INSERT INTO support_items (id, title, org, apply_end, url, summary, region, first_seen, matched_reasons)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (workspace_id, id) DO UPDATE SET title = excluded.title, org = excluded.org, apply_end = excluded.apply_end,
    url = excluded.url, summary = excluded.summary, region = excluded.region, matched_reasons = excluded.matched_reasons`;

/**
 * 지원사업을 한 번 받아 온다.
 * @param {object} ctx
 * @param {{date?: string, dry?: boolean}} opts date = 처음 본 날로 기록할 날짜(기본 오늘). dry 이면 DB 에 쓰지 않는다
 * @returns {Promise<{status:'nokey'} | {status:'failed', code:string, httpStatus?:number} | {status:'ok', count:number, items:Array<object>}>}
 */
export async function collect(ctx, { date, dry = false } = {}) {
  const env = ctx.env || {};
  if (!hasKey(env)) return { status: 'nokey' };
  const day = date || ctx.today();
  const key = str(env.SUPPORT_API_KEY);
  const fail = async (code, httpStatus) => {
    if (!dry) await recordRun(ctx, false, 0, code);
    ctx.log('support', `collect failed: ${code}`);
    return httpStatus ? { status: 'failed', code, httpStatus } : { status: 'failed', code };
  };

  let res;
  try {
    res = await ctx.fetch(buildSupportUrl(env.SUPPORT_API_BASE, key), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return fail(err && err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK');
  }
  if (!res.ok) return fail(`HTTP_${res.status}`, res.status);
  let data;
  try {
    const text = await res.text();
    data = text.trim() === '' ? null : JSON.parse(text);
  } catch {
    return fail('BAD_JSON');
  }
  const apiCode = resultCodeError(data);
  if (apiCode !== null) return fail(`API_${apiCode.replace(/[^0-9A-Za-z_]/g, '').slice(0, 20)}`);

  const items = normalizeResponse(data);
  const keywords = await getKeywords(ctx);
  const regions = await getRegions(ctx);
  const out = [];
  for (const it of items) {
    const firstSeen = (await storedFirstSeen(ctx, it.id)) || day;
    const reasons = matchItem(it, keywords, regions) || [];
    if (!dry) {
      await ctx.db.run(UPSERT_ITEM, [it.id, it.title, it.org, it.applyEnd, it.url, it.summary, it.region, firstSeen, JSON.stringify(reasons)]);
    }
    out.push({ ...it, firstSeen });
  }
  if (!dry) await recordRun(ctx, true, out.length, null);
  return { status: 'ok', count: out.length, items: out };
}

function rowToItem(r) {
  return {
    id: r.id,
    title: r.title,
    org: r.org,
    applyEnd: r.apply_end,
    url: r.url,
    summary: r.summary,
    region: r.region,
    firstSeen: r.first_seen,
  };
}

export async function listItems(ctx) {
  return (await ctx.db.all('SELECT * FROM support_items')).map(rowToItem);
}

/** 신청 마감이 남은 것(가까운 순) → 마감 미확인 → 마감 지난 것 */
export function sortByApplyEnd(items, today) {
  const rank = (it) => (it.applyEnd === '' ? 1 : it.applyEnd < today ? 2 : 0);
  return [...items].sort(
    (a, b) => rank(a) - rank(b) || a.applyEnd.localeCompare(b.applyEnd) || a.title.localeCompare(b.title),
  );
}

/** 화면 목록: 현재 키워드·지역에 맞는 항목과 근거. 키워드가 비면 전부 (근거 없음) */
export async function matchedList(ctx) {
  const keywords = await getKeywords(ctx);
  const regions = await getRegions(ctx);
  const all = await listItems(ctx);
  const out = [];
  for (const it of all) {
    if (keywords.length === 0) {
      out.push({ ...it, reasons: [] });
      continue;
    }
    const reasons = matchItem(it, keywords, regions);
    if (reasons) out.push({ ...it, reasons });
  }
  return { total: all.length, items: sortByApplyEnd(out, ctx.today()) };
}

export async function lastRun(ctx) {
  const r = await ctx.db.get('SELECT ran_at, ok, count, error FROM support_runs ORDER BY id DESC LIMIT 1');
  return r ? { ranAt: r.ran_at, ok: Boolean(r.ok), count: Number(r.count), error: r.error } : null;
}

function appUrlOf(env) {
  const e = env || {};
  return e.APP_BASE_URL ? String(e.APP_BASE_URL) : `http://localhost:${e.APP_PORT || 8820}`;
}

/**
 * 일일 지원사업 잡: 그날 처음 본 매칭 항목만 알린다. 없거나 키가 없으면 null.
 * @param {object} ctx @param {{date: string, dry?: boolean}} opts
 */
export async function runSupportJob(ctx, { date, dry = false } = {}) {
  if (!hasKey(ctx.env)) return null;
  const day = date || ctx.today();
  const r = await collect(ctx, { date: day, dry });
  if (r.status !== 'ok') return null;
  const keywords = await getKeywords(ctx);
  const regions = await getRegions(ctx);
  const items = [];
  for (const it of sortByApplyEnd(r.items.filter((x) => x.firstSeen === day), day)) {
    const reasons = matchItem(it, keywords, regions);
    if (!reasons) continue;
    items.push({ bidId: it.id, title: it.title, org: it.org, deadline: it.applyEnd, budget: null, url: it.url, reasons });
  }
  if (items.length === 0) return null;
  return { kind: 'support', date: day, count: items.length, items, appUrl: appUrlOf(ctx.env) };
}
