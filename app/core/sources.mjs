// 공고 소스: 내장 나라장터 어댑터 + 모듈 어댑터, sources/source_runs 기록
import { randomBytes } from 'node:crypto';
import pRetry from 'p-retry';
import { normalizeNaraResponse } from '../../src/match.js';
import { buildNaraUrl } from '../../scripts/live-check.mjs';

const DEFAULT_NARA_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
const DEFAULT_NARA_OPERATION = 'getBidPblancListInfoCnstwk';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NARA_TIMEOUT_MS = 20000;
const RETRY_MIN_MS = 500;
const SEED_ID = 'nara-cnstwk';
const PRESTD_SEED_ID = 'nara-prestd';
/** settings 키: 사전규격 소스를 이미 한 번 넣었는지 */
const PRESTD_SEEDED_KEY = 'sources_prestd_seeded';
const DEFAULT_PRESTD_BASE = 'https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService';
const DEFAULT_PRESTD_OPERATION = 'getPublicPrcureThngInfoCnstwk';
/** 보조 오퍼레이션 → item 에 붙일 키 (병합 키 bidNtceNo+bidNtceOrd) */
const AUX_OPERATIONS = [
  { operation: 'getBidPblancListInfoLicenseLimit', field: 'lcnsLmtNm', list: 'lcnsLmtList' },
  { operation: 'getBidPblancListInfoPrtcptPsblRgn', field: 'prtcptPsblRgnNm', list: 'prtcptPsblRgnList' },
  { operation: 'getBidPblancListInfoCnstwkBsisAmount', field: 'bssamt', value: 'bssamt' },
];

const MSG = {
  naraNoKey: '나라장터 인증키가 없습니다. 운영자가 인증키를 넣어야 합니다.',
  naraConnect: '나라장터에 연결하지 못했습니다. 잠시 뒤 지금 가져오기를 다시 눌러 주세요.',
  naraCode: (code) =>
    `공고를 가져오지 못했습니다 (나라장터 응답 오류 ${code}). 알림 설정에서 인증키를 확인한 뒤 지금 가져오기를 다시 눌러 주세요.`,
  naraFormat: '공고를 가져오지 못했습니다 (나라장터 응답 형식이 다름). 잠시 뒤 지금 가져오기를 다시 눌러 주세요.',
  naraQuota: '공고를 가져오지 못했습니다 (오늘 조회 한도를 넘었습니다). 내일 다시 시도하거나 운영자에게 알려 주세요.',
  partial: (pages) => `공고가 많아 일부만 가져왔습니다 (${pages}페이지). 운영자에게 알려 주세요.`,
  generic: '공고를 가져오지 못했습니다. 잠시 뒤 지금 가져오기를 다시 눌러 주세요.',
  nextStep: '소스 설정을 확인한 뒤 지금 가져오기를 다시 눌러 주세요.',
  notFound: '공고 소스를 찾지 못했습니다. 목록을 새로 고친 뒤 다시 눌러 주세요.',
  noAdapter: '이 종류의 소스는 지금 쓸 수 없습니다. 다른 종류를 골라 주세요.',
  noName: '소스 이름을 적어 주세요.',
  keepNara: '기본 나라장터 소스는 지울 수 없습니다. 끄려면 사용 안 함으로 바꿔 주세요.',
};

/** Date -> yyyyMMddHHmm (Asia/Seoul) */
function formatKst(date) {
  const d = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function fileNameOf(url) {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

/** ntceSpecDocUrl1..10 + ntceSpecFileNm1..10 → attachments, prtcptLmtRgnNm → regionLimit */
function toSourceBid(item) {
  const attachments = [];
  for (let i = 1; i <= 10; i++) {
    const url = String(item[`ntceSpecDocUrl${i}`] ?? '').trim();
    if (!url) continue;
    const name = String(item[`ntceSpecFileNm${i}`] ?? '').trim() || fileNameOf(url);
    attachments.push({ name, url });
  }
  const region = String(item.prtcptLmtRgnNm ?? '').trim();
  return { ...item, attachments, regionLimit: region || null };
}

/** 숫자 환경변수 (없거나 잘못되면 기본값) */
function intEnv(v, def, min, max) {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : def;
}

function naraSettings(env) {
  const e = env || {};
  return {
    rows: intEnv(e.NARA_ROWS, 500, 1, 999),
    maxPages: intEnv(e.NARA_MAX_PAGES, 20, 1, 1000),
    retries: intEnv(e.NARA_RETRY, 3, 0, 10),
  };
}

function sourceError(msg, retryable) {
  const err = new Error(`SOURCE_ERROR: ${msg}`);
  err.retryable = retryable;
  return err;
}

/** 게이트웨이 오류(HTTP 4xx + OpenAPI_ServiceResponse, JSON 또는 XML)의 returnReasonCode */
function gatewayCode(text) {
  const m = /returnReasonCode["']?\s*[:>]\s*["']?(\d+)/.exec(String(text));
  return m ? m[1] : null;
}

/** 한 페이지 요청. 네트워크·timeout·5xx 만 p-retry 로 다시 시도한다 (22·30 등 응답 오류는 바로 실패) */
function requestPage(url, req) {
  return pRetry(
    async () => {
      let res;
      let text;
      try {
        res = await req.fetchImpl(url, { signal: AbortSignal.timeout(NARA_TIMEOUT_MS) });
        text = await res.text();
      } catch {
        throw sourceError(MSG.naraConnect, true);
      }
      const gw = gatewayCode(text);
      if (gw) throw sourceError(`NARA_API_ERROR: ${gw}`, false);
      if (!res.ok) throw sourceError(`NARA_API_ERROR: ${res.status}`, res.status >= 500);
      let items;
      try {
        items = normalizeNaraResponse(text);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        throw sourceError(msg.startsWith('NARA_API_ERROR:') ? msg : MSG.naraFormat, false);
      }
      const body = JSON.parse(text).response.body;
      return { items, totalCount: Number(body && body.totalCount) };
    },
    { retries: req.retries, minTimeout: RETRY_MIN_MS, factor: 2, shouldRetry: ({ error }) => Boolean(error && error.retryable) },
  );
}

/**
 * totalCount 까지 페이지를 돈다. 오퍼레이션당 maxPages, 실행 전체 req.limit 요청이 상한 (넘으면 truncated)
 * @returns {Promise<{items:object[], pages:number, truncated:boolean}>}
 */
async function fetchPages(req, { base, operation, key, from, to, inqryDiv }) {
  const items = [];
  let pages = 0;
  let truncated = false;
  for (let pageNo = 1; ; pageNo++) {
    if (pageNo > req.maxPages || req.used >= req.limit) {
      truncated = true;
      break;
    }
    req.used += 1;
    const r = await requestPage(buildNaraUrl({ base, operation, key, from, to, rows: req.rows, pageNo, inqryDiv }), req);
    pages += 1;
    items.push(...r.items);
    if (r.items.length === 0 || !(pageNo * req.rows < r.totalCount)) break;
  }
  return { items, pages, truncated };
}

const bidKey = (it) => `${it && it.bidNtceNo}-${it && it.bidNtceOrd}`;

/** 창 하나의 요청 준비 */
function windowOf(env, since, until) {
  const key = String((env && env.NARA_API_KEY) || '');
  if (!key) throw new Error(`SOURCE_ERROR: ${MSG.naraNoKey}`);
  const from = since instanceof Date ? since : new Date(since);
  const to = until instanceof Date ? until : until ? new Date(until) : new Date(from.getTime() + DAY_MS);
  return { key, from: formatKst(from), to: formatKst(to) };
}

function newRequest(env, fetchImpl) {
  const s = naraSettings(env);
  return { ...s, used: 0, limit: 5 * s.maxPages, fetchImpl };
}

/** 사전규격: 등록일시 창, 사전규격번호로 중복 제거 */
async function fetchPrestd(config, { since, until, fetchImpl, env }) {
  const win = windowOf(env, since, until);
  const req = newRequest(env, fetchImpl);
  const r = await fetchPages(req, {
    ...win,
    base: (env && env.NARA_PRESTD_BASE) || DEFAULT_PRESTD_BASE,
    operation: (config && config.operation) || DEFAULT_PRESTD_OPERATION,
    inqryDiv: 1,
  });
  const byNo = new Map();
  for (const it of r.items) {
    const no = String((it && it.bfSpecRgstNo) ?? '').trim();
    if (no) byNo.set(no, it);
  }
  const out = [...byNo.values()];
  out.pages = r.pages;
  out.truncated = r.truncated;
  return out;
}

/**
 * 내장 나라장터 어댑터. config.service === 'prestd' 면 사전규격 서비스를 읽는다.
 * 결과 배열에 pages·truncated 속성을 붙여 돌려준다.
 */
const naraAdapter = {
  type: 'nara',
  label: '나라장터',
  configFields: [{ key: 'operation', label: '공고 종류', required: true, placeholder: DEFAULT_NARA_OPERATION }],
  validate(config) {
    const op = config && typeof config.operation === 'string' ? config.operation.trim() : '';
    return /^[A-Za-z0-9]+$/.test(op) ? [] : ['공고 종류를 적어 주세요.'];
  },
  async fetch(config, { since, until, fetchImpl, env, log }) {
    if (config && config.service === 'prestd') return fetchPrestd(config, { since, until, fetchImpl, env });
    const win = windowOf(env, since, until);
    const req = newRequest(env, fetchImpl);
    const base = (env && env.NARA_API_BASE) || DEFAULT_NARA_BASE;
    const operation = (config && config.operation) || (env && env.NARA_BID_OPERATION) || DEFAULT_NARA_OPERATION;
    const note = (m) => (typeof log === 'function' ? log('sources', m) : undefined);

    // 공고게시일시(1) + 변경일시(3) → bidId 로 병합 (나중 것이 이긴다)
    const posted = await fetchPages(req, { ...win, base, operation, inqryDiv: 1 });
    const byId = new Map(posted.items.map((it) => [bidKey(it), it]));
    let pages = posted.pages;
    let truncated = posted.truncated;
    try {
      const changed = await fetchPages(req, { ...win, base, operation, inqryDiv: 3 });
      for (const it of changed.items) byId.set(bidKey(it), it);
      pages += changed.pages;
      truncated = truncated || changed.truncated;
    } catch (err) {
      note(`changed list failed: ${err && err.message ? err.message : err}`);
    }

    // 보조 오퍼레이션(공사): 면허제한·참가가능지역·기초금액
    if (/Cnstwk$/.test(operation)) {
      for (const aux of AUX_OPERATIONS) {
        let rows;
        try {
          rows = (await fetchPages(req, { ...win, base, operation: aux.operation, inqryDiv: 1 })).items;
        } catch (err) {
          note(`${aux.operation} failed: ${err && err.message ? err.message : err}`);
          continue;
        }
        for (const row of rows) {
          const v = row ? row[aux.field] : undefined;
          if (v === undefined || v === null || String(v).trim() === '') continue;
          const it = byId.get(bidKey(row));
          if (!it) continue;
          if (aux.list) {
            if (!Array.isArray(it[aux.list])) it[aux.list] = [];
            it[aux.list].push(row);
          } else if (it[aux.value] === undefined || String(it[aux.value]).trim() === '') {
            it[aux.value] = v;
          }
        }
      }
    }

    const out = [...byId.values()].map(toSourceBid);
    out.pages = pages;
    out.truncated = truncated;
    return out;
  },
};

/** 어댑터 오류 → 화면에 보일 문구 (스택·영문 코드 없이) */
function userMessage(err) {
  const raw = err && typeof err.message === 'string' ? err.message : '';
  if (!raw.startsWith('SOURCE_ERROR:')) return MSG.generic;
  const msg = raw.slice('SOURCE_ERROR:'.length).trim();
  if (msg.startsWith('NARA_API_ERROR:')) {
    const code = msg.slice('NARA_API_ERROR:'.length).trim().split(/\s+/)[0] || '';
    if (code === '22') return MSG.naraQuota;
    return /^\d+$/.test(code) ? MSG.naraCode(code) : MSG.naraFormat;
  }
  if (!msg) return MSG.generic;
  return /[.!?]$/.test(msg) ? msg : `${msg}. ${MSG.nextStep}`;
}

function parseConfig(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function toRun(row) {
  return {
    id: Number(row.id),
    sourceId: row.source_id,
    ranAt: row.ran_at,
    ok: Number(row.ok) === 1,
    count: Number(row.count),
    error: row.error ?? null,
  };
}

/** @param {{db:any, now():Date, env:Record<string,string>, fetch: typeof fetch, hooks:{adapters:object[]}, bids:{upsert(b:object, id:string):Promise<object>}}} ctx */
export async function create(ctx) {
  const { db } = ctx;

  const seed = async () => {
    const n = Number((await db.get('SELECT COUNT(*) AS n FROM sources')).n);
    const ins = 'INSERT INTO sources (id, type, name, enabled, config, created_at) VALUES ($1, $2, $3, 1, $4, $5)';
    const at = ctx.now().toISOString();
    const insPrestd = () =>
      db.run(ins, [PRESTD_SEED_ID, 'nara', '나라장터 사전규격 공사', JSON.stringify({ operation: DEFAULT_PRESTD_OPERATION, service: 'prestd' }), at]);
    const flags = ctx.settings && typeof ctx.settings.get === 'function' ? ctx.settings : null;
    if (n > 0) {
      // 사전규격 소스가 생기기 전의 DB: 한 번만 추가한다. 사용자가 지운 뒤에는 플래그가 있어 다시 만들지 않는다
      if (!flags || (await flags.get(PRESTD_SEEDED_KEY)) !== null) return;
      const has = async (id) => Boolean(await db.get('SELECT 1 FROM sources WHERE id = $1', [id]));
      if ((await has(SEED_ID)) && !(await has(PRESTD_SEED_ID))) await insPrestd();
      await flags.set(PRESTD_SEEDED_KEY, '1');
      return;
    }
    await db.run(ins, [
      SEED_ID,
      'nara',
      '나라장터 공사',
      JSON.stringify({ operation: (ctx.env && ctx.env.NARA_BID_OPERATION) || DEFAULT_NARA_OPERATION }),
      at,
    ]);
    await insPrestd();
    if (flags) await flags.set(PRESTD_SEEDED_KEY, '1');
  };
  await seed();

  const toSource = async (row) => {
    if (!row) return null;
    const last = await db.get('SELECT * FROM source_runs WHERE source_id = $1 ORDER BY id DESC LIMIT 1', [row.id]);
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: Number(row.enabled) === 1,
      config: parseConfig(row.config),
      createdAt: row.created_at,
      lastRun: last ? toRun(last) : null,
    };
  };

  const adapters = () => [naraAdapter, ...((ctx.hooks && ctx.hooks.adapters) || [])];
  const adapterFor = (type) => adapters().find((a) => a.type === type) || null;

  const recordRun = async (sourceId, ok, count, error) => {
    await db.run('INSERT INTO source_runs (source_id, ran_at, ok, count, error) VALUES ($1, $2, $3, $4, $5)', [
      sourceId,
      ctx.now().toISOString(),
      ok ? 1 : 0,
      count,
      error,
    ]);
  };

  /** 소스 하나 실행 → upsert → 기록. throw 하지 않는다. 일부만 가져왔으면(truncated) ok 이면서 error 에 안내 문구 */
  const runOne = async (source, since, until) => {
    const adapter = adapterFor(source.type);
    if (!adapter) {
      await recordRun(source.id, false, 0, MSG.noAdapter);
      return { ok: false, count: 0, error: MSG.noAdapter, pages: 0, truncated: false, bids: [] };
    }
    try {
      const got = await adapter.fetch(source.config, { since, until, fetchImpl: ctx.fetch, env: ctx.env || {}, log: ctx.log });
      const list = (Array.isArray(got) ? got : []).map((b) => ({ ...b, source: source.id }));
      const pages = Number(got && got.pages) || 0;
      const truncated = Boolean(got && got.truncated);
      for (const b of list) await ctx.bids.upsert(b, source.id);
      const error = truncated ? MSG.partial(pages) : null;
      await recordRun(source.id, true, list.length, error);
      return { ok: true, count: list.length, error, pages, truncated, bids: list };
    } catch (err) {
      const error = userMessage(err);
      ctx.log('sources', `fetch ${source.id} failed: ${err && err.message ? err.message : err}`);
      await recordRun(source.id, false, 0, error);
      return { ok: false, count: 0, error, pages: 0, truncated: false, bids: [] };
    }
  };

  const checkConfig = (adapter, config) => {
    const errs = typeof adapter.validate === 'function' ? adapter.validate(config || {}) : [];
    return Array.isArray(errs) ? errs : [];
  };

  const sources = {
    async list() {
      const out = [];
      for (const row of await db.all('SELECT * FROM sources ORDER BY created_at, id')) out.push(await toSource(row));
      return out;
    },
    async get(id) {
      return toSource(await db.get('SELECT * FROM sources WHERE id = $1', [String(id)]));
    },
    /**
     * @param {{type:string, name:string, config?:object, enabled?:boolean, id?:string}} cfg
     * @returns {Promise<{ok:boolean, errors:string[], source:object|null}>}
     */
    async add(cfg) {
      const c = cfg || {};
      const adapter = adapterFor(c.type);
      if (!adapter) return { ok: false, errors: [MSG.noAdapter], source: null };
      const name = String(c.name ?? '').trim();
      const errors = [...(name ? [] : [MSG.noName]), ...checkConfig(adapter, c.config)];
      if (errors.length > 0) return { ok: false, errors, source: null };
      if (ctx.limits) {
        const n = Number((await db.get('SELECT COUNT(*) AS n FROM sources')).n);
        const lim = await ctx.limits.check('sources', n + 1);
        if (!lim.ok) return { ok: false, errors: [lim.message], source: null };
      }
      const id = c.id ? String(c.id) : `${adapter.type}-${randomBytes(4).toString('hex')}`;
      await db.run('INSERT INTO sources (id, type, name, enabled, config, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
        id,
        adapter.type,
        name,
        c.enabled === false ? 0 : 1,
        JSON.stringify(c.config || {}),
        ctx.now().toISOString(),
      ]);
      return { ok: true, errors: [], source: await this.get(id) };
    },
    /**
     * @param {string} id
     * @param {{name?:string, enabled?:boolean, config?:object}} patch
     * @returns {Promise<{ok:boolean, errors:string[], source:object|null}>}
     */
    async update(id, patch) {
      const cur = await this.get(id);
      if (!cur) return { ok: false, errors: [MSG.notFound], source: null };
      const p = patch || {};
      const next = {
        name: p.name !== undefined ? String(p.name).trim() : cur.name,
        enabled: p.enabled !== undefined ? Boolean(p.enabled) : cur.enabled,
        config: p.config !== undefined ? p.config : cur.config,
      };
      const errors = [...(next.name ? [] : [MSG.noName])];
      const adapter = adapterFor(cur.type);
      if (adapter && p.config !== undefined) errors.push(...checkConfig(adapter, next.config));
      if (errors.length > 0) return { ok: false, errors, source: cur };
      await db.run('UPDATE sources SET name = $1, enabled = $2, config = $3 WHERE id = $4', [
        next.name,
        next.enabled ? 1 : 0,
        JSON.stringify(next.config || {}),
        cur.id,
      ]);
      return { ok: true, errors: [], source: await this.get(cur.id) };
    },
    /** @returns {Promise<{ok:boolean, errors:string[]}>} */
    async remove(id) {
      const cur = await this.get(id);
      if (!cur) return { ok: false, errors: [MSG.notFound] };
      if (cur.id === SEED_ID) return { ok: false, errors: [MSG.keepNara] };
      await db.run('DELETE FROM source_runs WHERE source_id = $1', [cur.id]);
      await db.run('DELETE FROM sources WHERE id = $1', [cur.id]);
      return { ok: true, errors: [] };
    },
    adapters,
    /** 최근 실행 기록 (새것부터) */
    async runs(id, limit = 10) {
      const n = Math.max(1, Math.min(100, Number(limit) || 10));
      return (await db.all('SELECT * FROM source_runs WHERE source_id = $1 ORDER BY id DESC LIMIT $2', [String(id), n])).map(toRun);
    },
    /** 지금 가져오기: 최근 24시간. @returns {Promise<{ok:boolean, count:number, error:string|null}>} */
    async fetchNow(id) {
      const source = await this.get(id);
      if (!source) return { ok: false, count: 0, error: MSG.notFound };
      const r = await runOne(source, new Date(ctx.now().getTime() - DAY_MS));
      return { ok: r.ok, count: r.count, error: r.error };
    },
    /**
     * 켜진 소스를 순서대로 모두 가져와 저장한다. 하나가 실패해도 나머지는 계속
     * @param {Date} since
     * @param {Date} [until] 없으면 since+24h
     * @returns {Promise<{results: {sourceId:string, ok:boolean, count:number, error:string|null, pages:number, truncated:boolean}[], bids: object[]}>}
     */
    async fetchAll(since, until) {
      const from = since instanceof Date ? since : since ? new Date(since) : new Date(ctx.now().getTime() - DAY_MS);
      const to = until instanceof Date ? until : until ? new Date(until) : undefined;
      const results = [];
      const all = [];
      for (const source of (await this.list()).filter((s) => s.enabled)) {
        const r = await runOne(source, from, to);
        results.push({ sourceId: source.id, ok: r.ok, count: r.count, error: r.error, pages: r.pages, truncated: r.truncated });
        all.push(...r.bids);
      }
      return { results, bids: all };
    },
  };

  return { sources };
}
