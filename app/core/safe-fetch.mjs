// 사용자 입력 주소로 나가는 요청: 내부 네트워크 주소 차단(접속 시점 해석 주소 기준)·리다이렉트마다 재검사·응답 크기 상한
// undici Agent 의 connect.lookup 으로 실제 접속할 주소를 검사하고, 범위 판정은 ipaddr.js 를 쓴다.
import dns from 'node:dns';
import { Agent, fetch as undiciFetch } from 'undici';
import ipaddr from 'ipaddr.js';

export const BLOCKED_RANGES = ['unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'private', 'uniqueLocal', 'carrierGradeNat', 'reserved'];
export const MSG = {
  blocked: '이 주소는 쓸 수 없습니다 (내부 네트워크 주소).',
  scheme: '주소는 http:// 또는 https:// 로 시작해야 합니다.',
  tooLarge: (mb) => `응답이 너무 큽니다 (${mb}MB 초과).`,
};

const TIMEOUT_MSG = '응답이 늦어 요청을 멈췄습니다.';
const REDIRECTS_MSG = '주소가 너무 여러 번 다른 곳으로 넘어갑니다.';
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** 출처가 바뀌는 리다이렉트에서 떼는 헤더 (fetch 표준과 같게) */
const CREDENTIAL_HEADERS = ['authorization', 'cookie', 'proxy-authorization'];

const fail = (code, message) => Object.assign(new Error(message), { code });

/** 해석된 IP 가 내부 네트워크 범위인지. 파싱할 수 없는 값도 막는다 */
export function isBlockedAddress(ip) {
  let addr;
  try {
    addr = ipaddr.parse(String(ip ?? '').replace(/^\[|\]$/g, '').replace(/%.*$/, ''));
  } catch {
    return true;
  }
  if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress()) addr = addr.toIPv4Address();
  return BLOCKED_RANGES.includes(addr.range());
}

function normalizeHosts(list) {
  return new Set((Array.isArray(list) ? list : []).map((h) => String(h).trim().toLowerCase()).filter(Boolean));
}

/** URL 의 호스트 이름 (IPv6 대괄호 제거, 소문자) */
const hostOf = (u) => u.hostname.replace(/^\[|\]$/g, '').toLowerCase();

const isLocalName = (host) => host === 'localhost' || host.endsWith('.localhost');

/** 해석 없이 판단할 수 있는 것: 스킴, IP 리터럴, localhost. 결과 없으면 null */
function staticCheck(u, allow) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, code: 'URL_SCHEME', message: MSG.scheme };
  const host = hostOf(u);
  if (allow.has(host)) return { ok: true, host };
  if (ipaddr.isValid(host)) return isBlockedAddress(host) ? { ok: false, code: 'SSRF_BLOCKED', message: MSG.blocked } : { ok: true, host };
  if (isLocalName(host)) return { ok: false, code: 'SSRF_BLOCKED', message: MSG.blocked };
  return null;
}

/** dns.lookup 형태(콜백, 또는 Promise 를 돌려주는 함수) → 주소 목록 Promise */
function resolveAll(lookup, host) {
  return new Promise((resolve, reject) => {
    const done = (err, addrs, family) => {
      if (err) return reject(err);
      if (Array.isArray(addrs)) return resolve(addrs.map((a) => (typeof a === 'string' ? { address: a, family: ipaddr.parse(a).kind() === 'ipv6' ? 6 : 4 } : a)));
      return resolve([{ address: addrs, family }]);
    };
    const out = lookup(host, { all: true }, done);
    if (out && typeof out.then === 'function') out.then((v) => done(null, Array.isArray(v) ? v : [v]), reject);
  });
}

/**
 * 저장 전에 주소를 확인한다. 해석이 안 되는 이름은 통과(접속 시점 검사가 다시 막는다)
 * @returns {Promise<{ ok: true, host: string } | { ok: false, code: string, message: string }>}
 */
export async function checkUrl(url, { lookup = dns.lookup, allowHosts = [] } = {}) {
  let u;
  try {
    u = new URL(String(url ?? '').trim());
  } catch {
    return { ok: false, code: 'URL_SCHEME', message: MSG.scheme };
  }
  const allow = normalizeHosts(allowHosts);
  const known = staticCheck(u, allow);
  if (known) return known;
  const host = hostOf(u);
  let addrs;
  try {
    addrs = await resolveAll(lookup, host);
  } catch {
    return { ok: true, host };
  }
  if (addrs.some((a) => isBlockedAddress(a.address))) return { ok: false, code: 'SSRF_BLOCKED', message: MSG.blocked };
  return { ok: true, host };
}

/** net.connect 의 lookup 자리에 들어가는 검사 lookup */
function guardedLookup(lookup, allow) {
  return (hostname, options, callback) => {
    const opts = typeof options === 'function' ? {} : options || {};
    const cb = typeof options === 'function' ? options : callback;
    const host = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
    resolveAll(lookup, host).then(
      (addrs) => {
        const list = addrs.filter((a) => (opts.family === 4 || opts.family === 6 ? a.family === opts.family : true));
        if (list.length === 0) return cb(Object.assign(new Error(`no address for ${host}`), { code: 'ENOTFOUND' }));
        if (!allow.has(host) && list.some((a) => isBlockedAddress(a.address))) return cb(fail('SSRF_BLOCKED', MSG.blocked));
        if (opts.all) return cb(null, list);
        return cb(null, list[0].address, list[0].family);
      },
      (err) => cb(err),
    );
  };
}

/** 오류와 그 원인 사슬에서 code 를 찾는다 */
function codeIn(err) {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i += 1) {
    if (e.code === 'SSRF_BLOCKED') return e.code;
  }
  return null;
}

async function readBody(res, maxBytes) {
  const tooLarge = () => fail('BODY_TOO_LARGE', MSG.tooLarge(Math.round((maxBytes / (1024 * 1024)) * 10) / 10));
  const len = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(len) && len > maxBytes) {
    if (res.body) await res.body.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw tooLarge();
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
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

/**
 * @param {{ fetchImpl?: typeof fetch, lookup?: Function, allowHosts?: string[], maxBytes?: number, maxRedirects?: number }} [opts]
 * @returns {(url: string|URL, init?: RequestInit & { maxBytes?: number, maxRedirects?: number, timeoutMs?: number }) => Promise<Response>}
 */
export function createSafeFetch({ fetchImpl = undiciFetch, lookup = dns.lookup, allowHosts = [], maxBytes = DEFAULT_MAX_BYTES, maxRedirects = 5 } = {}) {
  const allow = normalizeHosts(allowHosts);
  const dispatcher = new Agent({ connect: { lookup: guardedLookup(lookup, allow) } });

  return async function safeFetch(url, init = {}) {
    const { maxBytes: limit = maxBytes, maxRedirects: hops = maxRedirects, timeoutMs, ...rest } = init || {};
    let timer = null;
    let signal = rest.signal;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = AbortSignal.timeout(timeoutMs);
      signal = signal ? AbortSignal.any([signal, timer]) : timer;
    }
    let target = url;
    let reqInit = { ...rest, signal, redirect: 'manual', dispatcher };
    try {
      for (let hop = 0; ; hop += 1) {
        let u;
        try {
          u = new URL(String(target));
        } catch {
          throw fail('URL_SCHEME', MSG.scheme);
        }
        const known = staticCheck(u, allow);
        if (known && !known.ok) throw fail(known.code, known.message);
        let res;
        try {
          res = await fetchImpl(hop === 0 ? target : u.href, reqInit);
        } catch (err) {
          if (codeIn(err)) throw fail('SSRF_BLOCKED', MSG.blocked);
          throw err;
        }
        const location = REDIRECT_STATUS.has(res.status) && res.headers ? res.headers.get('location') : null;
        if (location) {
          if (res.body) await res.body.cancel().catch(() => {});
          if (hop >= hops) throw fail('TOO_MANY_REDIRECTS', REDIRECTS_MSG);
          const method = String(reqInit.method || 'GET').toUpperCase();
          if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
            const { body, ...noBody } = reqInit;
            reqInit = { ...noBody, method: 'GET' };
          }
          const next = new URL(location, u);
          if (next.origin !== u.origin && reqInit.headers) {
            const headers = new Headers(reqInit.headers);
            for (const name of CREDENTIAL_HEADERS) headers.delete(name);
            reqInit = { ...reqInit, headers };
          }
          target = next.href;
          continue;
        }
        if (NULL_BODY_STATUS.has(res.status)) {
          if (res.body) await res.body.cancel().catch(() => {});
          return new Response(null, { status: res.status, statusText: res.statusText, headers: res.headers });
        }
        const buf = await readBody(res, limit);
        return new Response(buf, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
    } catch (err) {
      if (timer && timer.aborted && !(rest.signal && rest.signal.aborted)) {
        throw Object.assign(new Error(TIMEOUT_MSG), { code: 'TIMEOUT', name: 'TimeoutError' });
      }
      throw err;
    }
  };
}
