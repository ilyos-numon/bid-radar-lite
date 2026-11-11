// 공개 주소 남용 방어: 속도 규칙표(IP·회사 단위), 요청 본문 상한, 처리 시간 상한, 가입 봇 확인(Turnstile)
import { rateLimiter } from 'hono-rate-limiter';
import { bodyLimit as honoBodyLimit } from 'hono/body-limit';
import { timeout as honoTimeout } from 'hono/timeout';
import { HTTPException } from 'hono/http-exception';
import { timingSafeEqual } from 'node:crypto';
import { createPgRateStore, clientIp } from './rate-store.mjs';

export const RATE_RULES = {
  auth: { limit: 10, windowMs: 15 * 60 * 1000, key: 'ip', paths: ['/signup', '/login', '/reset', '/join/*', '/account/password', '/account/delete'] },
  demoLogin: { limit: 20, windowMs: 15 * 60 * 1000, key: 'ip', paths: ['/demo/login'] },
  jobs: { limit: 60, windowMs: 60 * 60 * 1000, key: 'ip', paths: ['/api/jobs/*'] },
  llm: { limit: 30, windowMs: 60 * 60 * 1000, key: 'workspace', paths: ['/summary/*/run', '/keywords/suggest', '/company/verdict'] },
  check: { limit: 10, windowMs: 60 * 60 * 1000, key: 'workspace', paths: ['/connections/*/check'] },
  collect: { limit: 6, windowMs: 60 * 60 * 1000, key: 'workspace', paths: ['/today/run'] },
  invite: { limit: 10, windowMs: 60 * 60 * 1000, key: 'workspace', paths: ['/assign/members'] },
};

export const GUARD_TEXT = {
  tooMany: (min) => `너무 여러 번 요청했습니다. ${min}분 뒤 다시 시도해 주세요.`,
  tooLarge: '보낸 내용이 너무 큽니다',
  timeout: '처리 시간이 길어 중단했습니다',
  human: '사람인지 확인하지 못했습니다. 다시 시도해 주세요.',
};

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const DEFAULT_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5000;
const DEFAULT_BODY_LIMIT = 262144;
const DEFAULT_TIMEOUT_MS = 30000;

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

// 상수 시간 비교(길이가 다르면 false)
function sameToken(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

const posNum = (v, fallback) => {
  const n = Number(v);
  return String(v ?? '').trim() !== '' && Number.isFinite(n) && n > 0 ? n : fallback;
};

// '*' 가 가운데면 경로 한 칸, 끝이면 그 아래 전부
function pathRegex(pattern) {
  const parts = pattern.split('/').map((seg, i, all) => {
    if (seg === '*') return i === all.length - 1 ? '.+' : '[^/]+';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}$`);
}

const RULE_REGEX = Object.fromEntries(Object.entries(RATE_RULES).map(([name, r]) => [name, r.paths.map(pathRegex)]));

/**
 * 요청에 걸리는 규칙 이름. POST 만 센다(jobs 는 GET 포함)
 * @param {string} method @param {string} pathname @param {'ip'|'workspace'} key
 * @returns {string|null}
 */
export function matchRule(method, pathname, key) {
  const m = String(method ?? '').toUpperCase();
  const p = String(pathname ?? '');
  for (const [name, rule] of Object.entries(RATE_RULES)) {
    if (rule.key !== key) continue;
    const methodOk = name === 'jobs' ? m === 'GET' || m === 'POST' : m === 'POST';
    if (!methodOk) continue;
    if (RULE_REGEX[name].some((re) => re.test(p))) return name;
  }
  return null;
}

/**
 * @param {{ db: { admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, env?: Record<string,string|undefined>, fetch?: Function }} deps
 */
export function createHttpGuard({ db, env = {}, fetch: doFetch } = {}) {
  const fetchFn = doFetch ?? globalThis.fetch;
  const scale = posNum(env.APP_RATE_SCALE, 1);
  const limitOf = (name) => Math.max(1, Math.floor(RATE_RULES[name].limit * scale));
  const minutes = (ms) => Math.max(1, Math.ceil(ms / 60000));
  const ruleOf = (name) => {
    const rule = RATE_RULES[name];
    if (!rule) throw new Error(`unknown rate rule: ${name}`);
    return rule;
  };
  const workspaceStores = new Map();
  const ip = clientIp(env.APP_TRUST_PROXY);
  const jobToken = String(env.APP_JOB_TOKEN ?? '');

  const siteKey = String(env.TURNSTILE_SITE_KEY ?? '').trim();
  const secretKey = String(env.TURNSTILE_SECRET_KEY ?? '').trim();
  const enabled = siteKey !== '' && secretKey !== '';
  const verifyUrl = String(env.TURNSTILE_VERIFY_URL ?? '').trim() || DEFAULT_VERIFY_URL;

  return {
    ipLimiter(name) {
      const rule = ruleOf(name);
      if (rule.key !== 'ip') throw new Error(`not an ip rule: ${name}`);
      return rateLimiter({
        windowMs: rule.windowMs,
        limit: limitOf(name),
        standardHeaders: 'draft-6',
        keyGenerator: (c) => `${name}:${ip(c)}`,
        // 서버 여러 대가 같은 횟수를 본다 (Postgres rate_limits)
        store: createPgRateStore({ db, windowMs: rule.windowMs }),
        message: () => GUARD_TEXT.tooMany(minutes(rule.windowMs)),
        // jobs 는 토큰 추측 방어용: 맞는 x-job-token 은 세지 않는다
        skip: (c) => (name === 'jobs' ? sameToken(c.req.header('x-job-token'), jobToken) : c.req.method !== 'POST'),
      });
    },

    /** @returns {Promise<{ ok: boolean, retryAfterSec: number }>} */
    async hitWorkspace(workspaceId, name) {
      const rule = ruleOf(name);
      let store = workspaceStores.get(name);
      if (!store) {
        store = createPgRateStore({ db, windowMs: rule.windowMs });
        workspaceStores.set(name, store);
      }
      const r = await store.increment(`${name}:${workspaceId}`);
      const ok = r.totalHits <= limitOf(name);
      const retryAfterSec = ok ? 0 : Math.max(1, Math.ceil((r.resetTime.getTime() - Date.now()) / 1000));
      return { ok, retryAfterSec };
    },

    bodyLimit() {
      return honoBodyLimit({
        maxSize: posNum(env.APP_BODY_LIMIT_BYTES, DEFAULT_BODY_LIMIT),
        onError: (c) => c.text(GUARD_TEXT.tooLarge, 413),
      });
    },

    timeout() {
      return honoTimeout(
        posNum(env.APP_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
        () =>
          new HTTPException(504, {
            res: new Response(GUARD_TEXT.timeout, { status: 504, headers: { 'content-type': 'text/plain; charset=UTF-8' } }),
          }),
      );
    },

    turnstile: {
      enabled,
      siteKey: enabled ? siteKey : '',
      scriptSrc: TURNSTILE_SCRIPT,
      widgetHtml() {
        if (!enabled) return '';
        return `<div class="cf-turnstile" data-sitekey="${esc(siteKey)}"></div><script src="${TURNSTILE_SCRIPT}" async defer></script>`;
      },
      /** 꺼져 있으면 외부 호출 없이 true. 실패·예외는 false */
      async verify(token, remoteIp) {
        if (!enabled) return true;
        const response = String(token ?? '').trim();
        if (response === '') return false;
        const form = new URLSearchParams({ secret: secretKey, response });
        if (remoteIp) form.set('remoteip', String(remoteIp));
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), VERIFY_TIMEOUT_MS);
        try {
          const res = await fetchFn(verifyUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: form.toString(),
            signal: ac.signal,
            timeoutMs: VERIFY_TIMEOUT_MS,
          });
          if (!res.ok) return false;
          const j = await res.json();
          return Boolean(j && j.success === true);
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
        }
      },
    },

    cspExtras() {
      if (!enabled) return { scriptSrc: [], frameSrc: [], connectSrc: [] };
      return { scriptSrc: [TURNSTILE_ORIGIN], frameSrc: [TURNSTILE_ORIGIN], connectSrc: [TURNSTILE_ORIGIN] };
    },
  };
}
