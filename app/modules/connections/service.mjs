// 연결 설정: 묶음별 상태·저장·삭제·연결 확인. 키 값은 로그·오류 문구에 넣지 않는다(이름·결과만).
import { KEY_GROUPS } from '../../core/keys.mjs';
import { buildNaraUrl } from '../../../scripts/live-check.mjs';
import { buildSupportUrl } from '../support/service.mjs';

export const GROUP_IDS = Object.freeze(Object.keys(KEY_GROUPS));
export const CHECK_RESULTS = Object.freeze(['ok', 'badkey', 'slow', 'fail']);
// 묶음·칸 이름 → view.mjs 의 GROUP_TEXT / FIELD_TEXT 열쇠 (view 는 내부 이름을 쓰지 않는다)
export const TEXT_KEY = Object.freeze({
  nara: 'nara',
  llm: 'summary',
  support: 'support',
  NARA_API_KEY: 'naraKey',
  LLM_API_KEY: 'summaryKey',
  LLM_API_BASE: 'summaryBase',
  LLM_MODEL: 'summaryName',
  SUPPORT_API_KEY: 'supportKey',
  SUPPORT_API_BASE: 'supportBase',
});

const CHECK_TIMEOUT_MS = 10000;
const MAX_LEN = 256;
const DEFAULT_NARA_BASE = 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService';
const DEFAULT_NARA_OPERATION = 'getBidPblancListInfoCnstwk';
// app/core/llm.mjs 의 기본값과 같게 둔다
const DEFAULT_SUMMARY_NAME = 'qwen3.7-flash';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const KEY_ERROR_RE = /SERVICE[_ ]KEY|INVALID[_ ]?(API[_ ]?)?KEY|UNAUTHORIZED|인증키/i;
const NARA_KEY_CODES = new Set(['20', '22', '30', '31', '32']);

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

export function isGroup(group) {
  return typeof group === 'string' && Object.prototype.hasOwnProperty.call(KEY_GROUPS, group);
}

/** 주소 칸인지 (이름이 _BASE 로 끝남) */
export function isAddressField(name) {
  return /_BASE$/.test(name);
}

/**
 * 묶음별 상태. 레거시 모드의 status() 는 배열을 바로 돌려준다.
 * @returns {Promise<Record<string, { registered: boolean, shared: boolean, fields: Record<string, {masked:string, updatedAt:any}|null> }>>}
 */
export async function groupStatus(ctx) {
  const rows = (await ctx.keys.status()) || [];
  const byName = new Map(rows.map((r) => [r.name, r]));
  const sharedOn = str(ctx.env && ctx.env.APP_SHARED_KEYS) === '1';
  const out = {};
  for (const group of GROUP_IDS) {
    const names = KEY_GROUPS[group];
    const fields = {};
    for (const name of names) {
      const r = byName.get(name);
      fields[name] = r ? { masked: String(r.masked ?? ''), updatedAt: r.updatedAt ?? null } : null;
    }
    const registered = fields[names[0]] !== null;
    out[group] = { registered, shared: !registered && sharedOn, fields };
  }
  return out;
}

/**
 * 폼 값 검증. 비어 있는 칸은 "그대로 둠"이라 건너뛴다.
 * @param {string} group
 * @param {Record<string, unknown>} form 이름 → 값
 * @returns {{ values: Record<string,string>, errors: Array<{name:string, code:'address'|'length'|'empty'}> }}
 */
export function validateGroup(group, form) {
  const values = {};
  const errors = [];
  for (const name of KEY_GROUPS[group]) {
    const v = str(form[name]);
    if (v === '') continue;
    if (v.length > MAX_LEN) {
      errors.push({ name, code: 'length' });
      continue;
    }
    if (isAddressField(name)) {
      let ok = false;
      try {
        const u = new URL(v);
        ok = u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        ok = false;
      }
      if (!ok) {
        errors.push({ name, code: 'address' });
        continue;
      }
    }
    values[name] = v;
  }
  if (errors.length === 0 && Object.keys(values).length === 0) errors.push({ name: '', code: 'empty' });
  return { values, errors };
}

/** 검증된 값만 저장. auth = { client, byUserId } (로그인한 사용자의 클라이언트) */
export async function saveGroup(ctx, group, values, auth) {
  const names = KEY_GROUPS[group].filter((n) => Object.prototype.hasOwnProperty.call(values, n));
  // 주소 칸이 내부 네트워크를 가리키면 하나도 저장하지 않는다 (code SSRF_BLOCKED)
  if (typeof ctx.checkUrl === 'function') {
    for (const name of names.filter(isAddressField)) {
      const checked = await ctx.checkUrl(values[name]);
      if (!checked.ok && checked.code === 'SSRF_BLOCKED') {
        ctx.log('connections', `save ${group} blocked: ${name}`);
        throw Object.assign(new Error(checked.message), { code: 'SSRF_BLOCKED', field: name });
      }
    }
  }
  for (const name of names) {
    await ctx.keys.set(name, values[name], { byUserId: auth.byUserId, client: auth.client });
  }
  ctx.log('connections', `saved ${group}: ${names.join(',')}`);
  return names;
}

/** 묶음 전체 삭제(등록된 것만) */
export async function removeGroup(ctx, group, auth) {
  const rows = (await ctx.keys.status()) || [];
  const have = new Set(rows.map((r) => r.name));
  const names = KEY_GROUPS[group].filter((n) => have.has(n));
  for (const name of names) {
    await ctx.keys.remove(name, { byUserId: auth.byUserId, client: auth.client });
  }
  ctx.log('connections', `removed ${group}: ${names.join(',') || 'none'}`);
  return names;
}

/** Date → yyyyMMddHHmm (Asia/Seoul) */
function formatKst(date) {
  const d = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function nowOf(ctx) {
  const n = typeof ctx.now === 'function' ? ctx.now() : new Date();
  return n instanceof Date && !Number.isNaN(n.getTime()) ? n : new Date();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 공공데이터 응답 본문 안의 결과 코드 (JSON header.resultCode 또는 XML <resultCode>/<returnReasonCode>) */
function bodyCode(text, data) {
  if (data && typeof data === 'object') {
    const header = (data.response && data.response.header) || data.header || null;
    const code = header ? str(header.resultCode) : str(data.resultCode);
    if (code !== '') return code;
  }
  const m = /<(?:returnReasonCode|resultCode)>\s*([^<\s]+)\s*</.exec(text);
  return m ? m[1] : '';
}

function safeCode(v) {
  const s = str(v);
  return /^[A-Za-z0-9_-]{1,20}$/.test(s) ? s : '';
}

function requestFor(ctx, group) {
  const env = ctx.env || {};
  if (group === 'nara') {
    const key = str(env.NARA_API_KEY);
    if (!key) return null;
    const now = nowOf(ctx);
    const url = buildNaraUrl({
      base: str(env.NARA_API_BASE) || DEFAULT_NARA_BASE,
      operation: str(env.NARA_BID_OPERATION) || DEFAULT_NARA_OPERATION,
      key,
      from: formatKst(new Date(now.getTime() - 24 * 60 * 60 * 1000)),
      to: formatKst(now),
      rows: 1,
    });
    return { url, init: { method: 'GET' } };
  }
  if (group === 'llm') {
    const key = str(env.LLM_API_KEY);
    const base = str(env.LLM_API_BASE);
    if (!key || !base) return null;
    return {
      url: `${base.replace(/\/+$/, '')}/chat/completions`,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: str(env.LLM_MODEL) || DEFAULT_SUMMARY_NAME, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      },
    };
  }
  const key = str(env.SUPPORT_API_KEY);
  const base = str(env.SUPPORT_API_BASE);
  if (!key || !base) return null;
  return { url: buildSupportUrl(base, key), init: { method: 'GET' } };
}

/**
 * 실제 호출 1회. 결과: ok | badkey | slow | fail (+ code)
 * @returns {Promise<{ result: 'ok'|'badkey'|'slow'|'fail', code: string }>}
 */
export async function checkGroup(ctx, group, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const r = requestFor(ctx, group);
  let out;
  if (!r) {
    out = { result: 'fail', code: '' };
  } else {
    out = await callOnce(ctx, group, r, timeoutMs);
  }
  ctx.log('connections', `check ${group}: ${out.result}${out.code ? ` ${out.code}` : ''}`);
  return out;
}

async function callOnce(ctx, group, { url, init }, timeoutMs) {
  let res;
  let text = '';
  try {
    res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (err) {
    const name = err && err.name;
    if (name === 'TimeoutError' || name === 'AbortError') return { result: 'slow', code: '' };
    return { result: 'fail', code: '' };
  }
  if (res.status === 401 || res.status === 403) return { result: 'badkey', code: String(res.status) };
  if (KEY_ERROR_RE.test(text) && (group !== 'llm' || !res.ok)) return { result: 'badkey', code: safeCode(res.status) };
  if (!res.ok) return { result: 'fail', code: safeCode(res.status) };
  if (group === 'llm') return { result: 'ok', code: '' };
  const code = bodyCode(text, parseJson(text));
  if (code === '' || /^0+$/.test(code)) return { result: 'ok', code: '' };
  if (group === 'nara' && NARA_KEY_CODES.has(code)) return { result: 'badkey', code: safeCode(code) };
  return { result: 'fail', code: safeCode(code) };
}

/** 주소창 값 정리: 정해진 결과·코드만 화면으로 */
export function readCheck(params) {
  const group = params.get('check');
  const result = params.get('result');
  if (!isGroup(group) || !CHECK_RESULTS.includes(result)) return null;
  return { group, result, code: safeCode(params.get('code')) };
}
