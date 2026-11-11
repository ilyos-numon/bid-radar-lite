// Supabase 모드 진입: 보안 미들웨어 → (플랫폼 라우트) → 세션 → 워크스페이스 → 워크스페이스 런타임
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { csrf } from 'hono/csrf';
import { secureHeaders } from 'hono/secure-headers';
import { createRuntime, fetchOptions } from './registry.mjs';
import { openDb } from './db.mjs';
import { readCookie } from './auth.mjs';
import { createPlatformMembers } from './members-platform.mjs';
import { createQueue, enqueueRuns } from './queue.mjs';
import { createWorker } from './worker.mjs';
import { RUNS_SQL, runRow, validDate } from './routes-jobs.mjs';
import { logger, logRequest } from './log.mjs';
import { createHealth } from './health.mjs';
import { createHtml, esc } from './html.mjs';
import { createSafeFetch } from './safe-fetch.mjs';
import { createBillingStore } from './billing/store.mjs';
import { createToss } from './billing/toss.mjs';
import { createBillingCycle } from './billing/cycle.mjs';
import { registerBillingRoutes } from './billing/routes.mjs';
import { createLimits } from './billing/limits.mjs';
import { accessOf, isAllowedWhenLocked } from './billing/access.mjs';
import { createEmailSender } from './email.mjs';
import { createEmailAlerts } from './email-alerts.mjs';
import { registerUnsubscribeRoutes } from './email-routes.mjs';
import { createConsents } from './legal/consent.mjs';
import { createHttpGuard, matchRule, GUARD_TEXT, RATE_RULES } from './http-guard.mjs';
import { createBudget } from './budget.mjs';
import { createDemo } from './demo/seed.mjs';
import { registerDemoRoutes } from './demo/routes.mjs';
import { isBlockedForDemo, blockedResponse } from './demo/guard.mjs';
import { DEMO_TEXT } from './demo/fixture.mjs';
import { createOpsStats } from './ops/stats.mjs';
import { registerAdminRoutes } from './ops/admin-routes.mjs';
import { registerStatusRoutes } from './ops/status-routes.mjs';
import { createDayStart, registerCollectRoutes, schedulerOff } from './day-start.mjs';
import { createCredits } from './billing/credits.mjs';

export const WS_COOKIE = 'br_ws';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_NAMES = ['daily', 'reminders', 'support'];

// 현재 요청의 { client, userId, workspaceId } — onInvite·keys.set/remove 가 로그인한 사용자의 클라이언트를 쓰게 한다
const als = new AsyncLocalStorage();

/** @returns {{ client: object, userId: string, workspaceId: string } | null} */
export function getRequestContext() {
  return als.getStore() ?? null;
}

/** 앱 주소의 origin. APP_BASE_URL 이 있으면 그것, 없으면 요청 주소 */
export function appOrigin(env, req) {
  const base = String(env?.APP_BASE_URL ?? '').trim();
  if (base) {
    try {
      return new URL(base).origin;
    } catch {
      // 잘못된 값이면 요청 주소로
    }
  }
  return new URL(req.url).origin;
}

function cookieSecure(env) {
  const v = String(env?.APP_COOKIE_SECURE ?? '').trim();
  if (v === '1') return true;
  if (v === '0') return false;
  return /^https:/i.test(String(env?.APP_BASE_URL ?? ''));
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
// 워커 줄: "[worker] <runId> attempt <n> done|dead|already done|failed: <code>"
const WORKER_LINE_RE = /^\[worker\] (\S+) attempt (\d+) (done|dead|already done|failed: (\S+))$/;

/** 응답 헤더를 고칠 수 있도록 복사하고 Set-Cookie 를 덧붙인다 */
function withCookies(res, cookies) {
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
  for (const c of cookies) out.headers.append('set-cookie', c);
  return out;
}

/** 상수 시간 비교(길이가 다르면 false) */
function sameToken(given, expected) {
  if (typeof given !== 'string' || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 로그용 오류 코드(메시지·값 없이) */
function errorCode(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'error';
}

/** 요청 처리 시간 상한을 걸지 않는 경로: 잡(요청 안에서 큐를 비울 수 있다)·결제 웹훅 */
function isJobOrWebhook(pathname) {
  return pathname.startsWith('/api/jobs/') || pathname.startsWith('/webhooks/');
}

const STATIC_RE = /\.(?:ico|png|jpe?g|gif|svg|webp|css|js|map|txt|woff2?)$/i;

/** 하루 첫 방문 킥을 일으키지 않는 경로: 잡·웹훅·상태 확인·정적 자원 */
function skipsDayStart(pathname) {
  return isJobOrWebhook(pathname) || pathname === '/healthz' || pathname === '/readyz' || STATIC_RE.test(pathname);
}

function redirect(location, status = 302) {
  return new Response(null, { status, headers: { location } });
}

/** 'YYYY-MM-DD' (Asia/Seoul). fakeNow 가 날짜면 그날 */
function todayOf(fakeNow) {
  const fixed = typeof fakeNow === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fakeNow) ? new Date(`${fakeNow}T12:00:00+09:00`) : new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(fixed);
}

/** 양의 정수 환경변수(없거나 잘못되면 기본값) */
function intEnv(v, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

/** 'YYYY-MM-DD' fakeNow 면 그날 정오(KST)로 고정한 시계, 아니면 현재 시각 */
function clockOf(fakeNow) {
  const fixed = typeof fakeNow === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fakeNow) ? new Date(`${fakeNow}T12:00:00+09:00`) : null;
  return () => (fixed ? new Date(fixed.getTime()) : new Date());
}

/** APP_BILLING_RETRY_DAYS('1,3,7') → [1,3,7]. 잘못되면 기본값 */
function parseDays(v) {
  const days = String(v ?? '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return days.length > 0 ? days : [1, 3, 7];
}

/** 빌링키 금고: Supabase Vault RPC (service_role). 오류 내용·키 값은 메시지에 넣지 않는다 */
function createVault(platform) {
  const rpc = async (fn, args) => {
    const client = platform.serviceClient;
    if (!client || typeof client.rpc !== 'function') throw Object.assign(new Error('vault is not available'), { code: 'VAULT_UNAVAILABLE' });
    const { data, error } = await client.rpc(fn, args);
    if (error) throw Object.assign(new Error(`${fn} failed`), { code: 'VAULT_ERROR' });
    return data ?? null;
  };
  return {
    async setKey(ws, key) {
      await rpc('billing_set_key', { p_ws: ws, p_key: key });
    },
    getKey: (ws) => rpc('billing_get_key', { p_ws: ws }),
    async deleteKey(ws) {
      await rpc('billing_delete_key', { p_ws: ws });
    },
  };
}

const RUNNERS = { daily: 'runDaily', reminders: 'runReminders', support: 'runSupport' };

/** 멤버십 → 화면용 member (역할·이름은 memberships 가 단일 출처) */
export function memberOf(m) {
  return { id: Number(m.memberId), name: String(m.memberName), role: m.role };
}

/**
 * @param {{ env: Record<string,string|undefined>, platform: object, db?: object, queue?: object, fetchImpl?: typeof fetch, fakeNow?: string, modulesDir?: string, coreDir?: string, registerPlatformRoutes?: (app: Hono, deps: object) => void|Promise<void>, billingVault?: { setKey(ws: string, key: string): Promise<void>, getKey(ws: string): Promise<string|null>, deleteKey(ws: string): Promise<void> } }} opts
 *   db 가 없으면 openDb({ url: env.APP_DB_URL, poolSize: env.APP_DB_POOL }) (그때만 close() 가 닫는다)
 *   queue 가 없으면 createQueue({ db }) (pgmq 'jobs'). 테스트는 가짜 큐를 넣는다
 *   billingVault 가 없으면 platform.serviceClient.rpc('billing_*_key') 로 만든다. 테스트는 메모리 fake 를 넣는다
 * @returns {Promise<{ fetch(req: Request, env?: object, executionCtx?: object): Promise<Response>, close(): Promise<void>, runtimeFor(workspaceId: string): Promise<object>, platform: object, db: object, startWorker(): void, stopWorker(): Promise<void> }>}
 */
export async function createApp({ env, platform, db: givenDb, queue: givenQueue, fetchImpl = globalThis.fetch, fakeNow, modulesDir, coreDir, registerPlatformRoutes, billingVault } = {}) {
  if (!platform || platform.enabled !== true) throw new Error('platform is required');
  let db = givenDb;
  if (!db) {
    const url = String(env.APP_DB_URL ?? '').trim();
    if (!url) {
      throw Object.assign(new Error('APP_DB_URL 이 비어 있습니다. 가입 모드는 공유 Postgres 주소(app_worker 계정)가 필요합니다.'), {
        code: 'APP_DB_URL_REQUIRED',
      });
    }
    const pool = Number(env.APP_DB_POOL);
    db = await openDb({ url, poolSize: Number.isInteger(pool) && pool > 0 ? pool : 10 });
  }
  const queue = givenQueue ?? createQueue({ db });
  const cacheSize = Number(env.APP_RUNTIME_CACHE) > 0 ? Math.floor(Number(env.APP_RUNTIME_CACHE)) : 20;
  const secure = cookieSecure(env);
  const memberMap = new WeakMap();
  /** @type {Map<string, Promise<object>>} 삽입 순서 = 최근 사용 순서 */
  const runtimes = new Map();
  /** @type {Map<Promise<object>, number>} 런타임별 사용 중 요청 수 */
  const refs = new Map();
  /** @type {Set<Promise<object>>} 캐시에서 빠졌지만 사용 중이라 닫기를 미룬 런타임 */
  const retired = new Set();
  let closed = false;
  let dbClosed = false;

  // 결제·이메일: 모든 회사가 같은 store·toss·금고·발송기를 쓴다
  const now = clockOf(fakeNow ?? env.APP_FAKE_NOW);
  const outFetch = fetchImpl === globalThis.fetch ? createSafeFetch(fetchOptions(env)) : fetchImpl;
  const store = createBillingStore({ db, now, trialDays: intEnv(env.APP_TRIAL_DAYS, 14) });
  const toss = createToss({ env, fetch: outFetch });
  const vault = billingVault ?? createVault(platform);
  const cycle = createBillingCycle({ store, toss, vault, now, retryDays: parseDays(env.APP_BILLING_RETRY_DAYS) });
  const sender = createEmailSender({ env, fetch: outFetch });
  const appUrl = String(env.APP_BASE_URL ?? '').trim();
  const guard = createHttpGuard({ db, env, fetch: outFetch });
  const budget = createBudget({ db, env, now });
  const consents = createConsents({ db, env });
  const demo = createDemo({ db, platform, env, now, runtimeFor: (id) => runtimeFor(id), store, consents });
  // 예시 회사 화면 위쪽 안내 띠 (이미 이스케이프된 HTML)
  const demoBanner = () => `${esc(schedulerOff(env) ? DEMO_TEXT.bannerOff : DEMO_TEXT.banner)} <a href="/signup">${esc(DEMO_TEXT.bannerLink)}</a>`;
  // 예약 실행 없음 모드(APP_SCHEDULER_OFF=1): 하루 첫 방문 요청이 앱 자신의 잡 주소를 부른다
  const dayStart = createDayStart({ db, env, now, kick: (url) => outFetch(String(url), { headers: { 'x-job-token': String(env.APP_JOB_TOKEN ?? '') } }) });
  const plainHtml = createHtml({ menus: () => [], logoutPost: true, env });
  const demoHtml = createHtml({ menus: () => [], logoutPost: true, env, banner: demoBanner });
  const page = async (status, opts, cookies) => withCookies(await plainHtml.page(status, opts), cookies ?? []);
  const cspExtras = guard.cspExtras();

  /** @type {Set<Promise<void>>} 진행 중인 close() — 앱 close() 가 기다린다 */
  const closing = new Set();

  function closeLater(pending) {
    const done = pending.then(
      (rt) => rt.close(),
      () => {},
    );
    closing.add(done);
    done.finally(() => closing.delete(done)).catch(() => {});
  }

  // 모든 회사가 공유 Db 하나를 쓴다. 런타임은 그 회사의 설정(키·구성원)만 묶고, 쿼리는 withWorkspace 안에서만 돈다
  async function openRuntime(id) {
    const isDemo = await demo.isDemoWorkspace(id);
    const onInvite = (i) => {
      const rc = getRequestContext();
      if (!rc || rc.workspaceId !== id) {
        throw Object.assign(new Error('invite needs a signed-in request'), { code: 'NO_REQUEST_CONTEXT' });
      }
      // 실패는 기록만(토큰 해시·비밀값 없이)
      return Promise.resolve(
        platform.registerInvite(rc.client, {
          workspaceId: id,
          memberId: i.memberId,
          memberName: i.name,
          role: i.role,
          tokenHash: i.tokenHash,
        }),
      ).catch((err) => {
        logger.warn({ module: 'tenant', workspaceId: id, code: err && err.code ? err.code : 'error' }, 'invite register failed');
        throw err;
      });
    };
    const limits = createLimits({ getPlan: async () => (await store.ensure(id)).plan });
    return db.withWorkspace(id, () =>
      createRuntime({
        db,
        modulesDir,
        secret: env.APP_SECRET,
        jobToken: env.APP_JOB_TOKEN,
        env,
        fetchImpl,
        fakeNow,
        coreDir,
        workspace: {
          id,
          memberFrom: (req) => memberMap.get(req) ?? null,
          onInvite,
          keys: platform.keys(id),
          members: createPlatformMembers({ db, workspaceId: id, platform, onInvite, limits }),
          limits,
          billing: { store, toss, vault, workspaceId: id, env },
          emailAlerts: (ctx) =>
            createEmailAlerts({ db, settings: ctx.settings, notify: ctx.notify, sender, limits: ctx.limits, budget, env, workspaceId: id, appUrl }),
          demo: isDemo ? { enabled: true } : null,
          budget,
          credits: isDemo ? null : createCredits({ db, workspaceId: id, store, env }),
          banner: isDemo ? demoBanner : () => null,
        },
      }),
    );
  }

  /** 캐시에서 뺀 런타임: 사용 중이면 마지막 요청이 끝난 뒤, 아니면 바로 close() */
  function retire(pending) {
    if ((refs.get(pending) ?? 0) > 0) retired.add(pending);
    else closeLater(pending);
  }

  function release(pending) {
    const n = (refs.get(pending) ?? 1) - 1;
    if (n > 0) {
      refs.set(pending, n);
      return;
    }
    refs.delete(pending);
    if (retired.delete(pending)) closeLater(pending);
  }

  /** 요청 처리용: 런타임을 얻고 사용 중으로 센다. 끝나면 release() 를 한 번 부른다 */
  async function acquire(workspaceId) {
    const pending = runtimeFor(workspaceId);
    refs.set(pending, (refs.get(pending) ?? 0) + 1);
    let runtime;
    try {
      runtime = await pending;
    } catch (err) {
      release(pending);
      throw err;
    }
    let done = false;
    return {
      runtime,
      release() {
        if (done) return;
        done = true;
        release(pending);
      },
    };
  }

  /** 캐시에서 빼고 닫는다(사용 중이면 끝난 뒤). 계정 삭제 뒤 닫힌 런타임이 캐시에 남지 않게 한다 */
  async function dropRuntime(workspaceId) {
    const id = String(workspaceId ?? '');
    const pending = runtimes.get(id);
    if (!pending) return;
    runtimes.delete(id);
    if ((refs.get(pending) ?? 0) > 0) {
      retired.add(pending);
      return;
    }
    try {
      await (await pending).close();
    } catch {
      // 열지 못했으면 닫을 것도 없다
    }
  }

  /** LRU: 최근에 쓴 워크스페이스 런타임을 APP_RUNTIME_CACHE 개까지 열어 둔다. 밀려나면 close()(사용 중이면 끝난 뒤) */
  function runtimeFor(workspaceId) {
    const id = String(workspaceId ?? '');
    if (!UUID_RE.test(id)) return Promise.reject(Object.assign(new Error('bad workspace id'), { code: 'BAD_WORKSPACE' }));
    if (closed) return Promise.reject(new Error('app is closed'));
    let pending = runtimes.get(id);
    if (pending) {
      runtimes.delete(id);
      runtimes.set(id, pending);
      return pending;
    }
    pending = openRuntime(id);
    pending.catch(() => {
      if (runtimes.get(id) === pending) runtimes.delete(id);
    });
    runtimes.set(id, pending);
    while (runtimes.size > cacheSize) {
      const [oldId, oldPending] = runtimes.entries().next().value;
      runtimes.delete(oldId);
      retire(oldPending);
    }
    return pending;
  }

  function wsCookie(workspaceId) {
    return `${WS_COOKIE}=${workspaceId}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }
  function clearWsCookie() {
    return `${WS_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  }

  const app = new Hono();

  // 요청 한 줄 로그 (경로만, 쿼리·쿠키 없이). x-request-id 는 형식이 맞으면 이어 쓰고 아니면 새로 만든다
  app.use('*', async (c, next) => {
    const start = Date.now();
    const given = c.req.header('x-request-id');
    const requestId = given && REQUEST_ID_RE.test(given) ? given : randomUUID();
    await next();
    try {
      c.res.headers.set('x-request-id', requestId);
    } catch {
      // 고칠 수 없는 헤더면 그대로 둔다
    }
    logRequest({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - start, requestId, workspaceId: c.get('workspaceId') });
  });
  app.use(
    '*',
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        // 가입 봇 확인(Turnstile)은 켜졌을 때만 cspExtras 가 주소를 더한다
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.tosspayments.com', ...cspExtras.scriptSrc],
        // 토스 결제창 SDK v2: 결제창 iframe 과 API 호출
        frameSrc: ["'self'", 'https://*.tosspayments.com', ...cspExtras.frameSrc],
        connectSrc: ["'self'", 'https://*.tosspayments.com', ...cspExtras.connectSrc],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );
  // 요청 본문 크기 상한, 처리 시간 상한(잡·웹훅 제외)
  app.use('*', guard.bodyLimit());
  const timeout = guard.timeout();
  app.use('*', async (c, next) => (isJobOrWebhook(c.req.path) ? next() : timeout(c, next)));
  app.use('*', csrf({ origin: (origin, c) => origin === appOrigin(env, c.req.raw) }));
  // IP 단위 속도 규칙 (서버 여러 대가 같은 횟수를 본다: Postgres rate_limits). 데모 로그인 규칙은 데모 라우트가 건다
  for (const name of ['auth', 'jobs']) {
    const limiter = guard.ipLimiter(name);
    for (const p of RATE_RULES[name].paths) app.use(p, limiter);
  }
  // 하루 첫 방문 수집 킥 (잡·상태 확인 주소는 제외). 실패해도 요청은 그대로 처리한다
  app.use('*', async (c, next) => {
    if (dayStart.enabled && !skipsDayStart(c.req.path)) {
      try {
        await dayStart.touch('collect', null);
      } catch (err) {
        logger.warn({ module: 'tenant', code: errorCode(err) }, 'day start failed');
      }
    }
    return next();
  });

  await (registerPlatformRoutes ?? (() => {}))(app, {
    env,
    platform,
    runtimeFor,
    dropRuntime,
    db,
    memberOf,
    getRequestContext,
    appOrigin: (req) => appOrigin(env, req),
    wsCookie,
    clearWsCookie,
    WS_COOKIE,
    demo,
    guard,
    budget,
  });

  // 결제 웹훅·결제 잡(/api/jobs/billing 은 아래 /api/jobs/:name 보다 먼저)·수신거부 링크
  registerBillingRoutes(app, { env, billing: { store, toss, cycle, vault }, db });
  registerUnsubscribeRoutes(app, { env, db, html: createHtml({ menus: () => [], logoutPost: true, env }) });
  // 현재 약관 버전을 legal_versions 에 한 번 기록한다. 실패해도 앱은 뜬다(기록만)
  try {
    await consents.ensureVersions();
  } catch (err) {
    logger.warn({ module: 'tenant', code: errorCode(err) }, 'legal versions not recorded');
  }

  app.get('/healthz', (c) => c.json({ status: 'ok', mode: 'supabase' }));
  const health = createHealth({ db, queue, platform, mode: 'supabase' });
  app.get('/readyz', () => health.response());

  const jobAuthorized = (req) => {
    const given = req.headers.get('x-job-token');
    return Boolean(env.APP_JOB_TOKEN) && sameToken(given, env.APP_JOB_TOKEN);
  };
  const listIds = async () => (await platform.listWorkspaces()).map((ws) => String(ws.id)).filter((id) => UUID_RE.test(id));

  // 데모: POST /demo/login, GET /api/jobs/demo-reset (아래 /api/jobs/:name 보다 먼저)
  registerDemoRoutes(app, { env, platform, demo, guard, budget, wsCookie, jobAuthorized, dayStart });
  // 첫 방문 수집: GET /api/jobs/collect?all=1 (아래 /api/jobs/:name 보다 먼저). 회사마다 runDaily, 발송 없음
  const runIn = async (id, fn) => {
    const { runtime, release: done } = await acquire(id);
    try {
      await runtime.ctx.keys.load();
      return await db.withWorkspace(id, () => fn(runtime));
    } finally {
      done();
    }
  };
  registerCollectRoutes(app, {
    env,
    jobAuthorized,
    workspaceIds: listIds,
    activeWorkspaceIds: (ids) => store.activeWorkspaceIds(ids),
    isDemoWorkspace: (id) => demo.isDemoWorkspace(id),
    runIn,
    db,
    now,
  });
  // 운영 현황(/admin, 플랫폼 관리자만)·공개 서비스 현황(/status)
  const stats = createOpsStats({
    db,
    workspaceIds: listIds,
    demoWorkspaceId: () => demo.workspaceId(),
    queue,
    readiness: () => health.readyz().then((r) => r.status === 'ok'),
    now,
    dayStart,
  });
  registerAdminRoutes(app, { env, platform, stats, page });
  registerStatusRoutes(app, { stats, page });

  // 실행 기록: 회사마다 job_runs (job, date) 한 행씩
  app.get('/api/jobs/:name/runs', async (c) => {
    const name = c.req.param('name');
    if (!JOB_NAMES.includes(name)) return c.json({ error: 'not_found' }, 404);
    if (!jobAuthorized(c.req.raw)) return c.json({ error: 'forbidden' }, 403);
    const raw = c.req.query('date');
    if (raw !== undefined && raw !== '' && !validDate(raw)) return c.json({ error: 'bad_date' }, 400);
    const date = raw ? raw : todayOf(fakeNow ?? env.APP_FAKE_NOW);
    const out = [];
    for (const id of await listIds()) {
      const row = await db.withWorkspace(id, () => db.get(RUNS_SQL, [name, date]));
      if (row) out.push(runRow(id, row));
    }
    return c.json(out);
  });

  // 잡: x-job-token 확인 뒤 각 워크스페이스 런타임의 /api/jobs/<name> 을 그대로 부른다(응답 모양은 routes-jobs 가 정한다)
  app.get('/api/jobs/:name', async (c) => {
    const req = c.req.raw;
    const name = c.req.param('name');
    if (!JOB_NAMES.includes(name)) return c.json({ error: 'not_found' }, 404);
    const given = req.headers.get('x-job-token');
    if (!env.APP_JOB_TOKEN || !sameToken(given, env.APP_JOB_TOKEN)) return c.json({ error: 'forbidden' }, 403);
    const url = new URL(req.url);
    const date = url.searchParams.get('date');
    const dry = url.searchParams.get('dry');
    const inner = (all) => {
      const u = new URL(`/api/jobs/${name}`, url.origin);
      if (date !== null) u.searchParams.set('date', date);
      if (dry !== null) u.searchParams.set('dry', dry);
      if (all) u.searchParams.set('all', '1');
      return new Request(u, { headers: { 'x-job-token': given } });
    };
    const runOne = async (workspaceId, all) => {
      const { runtime, release: done } = await acquire(workspaceId);
      try {
        await runtime.ctx.keys.load();
        return await db.withWorkspace(workspaceId, () => runtime.router.fetch(inner(all)));
      } finally {
        done();
      }
    };

    // 가입 모드 매일 작업: 회사별 메시지로 나눠 큐에 넣고 바로 202 (워커가 실행·발송). dry=1 은 아래 동기 미리보기
    if (url.searchParams.get('all') === '1' && dry !== '1') {
      if (date !== null && date !== '' && !validDate(date)) return c.json({ error: 'bad_date' }, 400);
      const d = date ? date : todayOf(fakeNow ?? env.APP_FAKE_NOW);
      // 구독이 끝난 회사(expired·canceled)는 알림을 만들지 않는다
      const r = await enqueueRuns({ db, queue, workspaceIds: await store.activeWorkspaceIds(await listIds()), job: name, date: d });
      // wait=1: 워커가 꺼져 있어도(스케일 0) 요청 안에서 큐를 비우고 200
      if (url.searchParams.get('wait') === '1') {
        const drained = await (worker ?? makeWorker()).drain({ maxMs: intEnv(env.APP_JOB_WAIT_MS, 240000) });
        return c.json({ ...r, processed: drained.processed, remaining: drained.remaining }, 200);
      }
      return c.json(r, 202);
    }
    if (url.searchParams.get('all') === '1') {
      const list = await platform.listWorkspaces();
      const out = [];
      for (const ws of list) {
        if (!UUID_RE.test(String(ws.id))) continue;
        // 한 회사가 실패해도 나머지는 계속한다. 실패 항목은 오류 코드만 남긴다
        try {
          const res = await runOne(ws.id, true);
          if (res.status !== 200) throw Object.assign(new Error('job status'), { code: `status_${res.status}` });
          const items = [];
          for (const payload of await res.json()) items.push({ workspaceId: ws.id, workspaceName: ws.name, ...payload });
          out.push(...items);
        } catch (err) {
          logger.warn({ module: 'tenant', job: name, workspaceId: ws.id, code: errorCode(err) }, 'job failed');
          out.push({ workspaceId: ws.id, workspaceName: ws.name, error: 'job_failed' });
        }
      }
      return c.json(out);
    }
    const one = url.searchParams.get('workspace');
    if (one) {
      if (!UUID_RE.test(one)) return c.json({ error: 'workspace_required' }, 400);
      return runOne(one, false);
    }
    return c.json({ error: 'workspace_required' }, 400);
  });

  // 그 밖: 로그인 → 멤버십 → 현재 워크스페이스 → 그 런타임으로
  app.all('*', async (c) => {
    const req = c.req.raw;
    const { client, user, setCookies } = await platform.auth.fromRequest(req);
    const cookies = [...(setCookies ?? [])];
    const safe = req.method === 'GET' || req.method === 'HEAD';
    if (!user) {
      return withCookies(safe ? redirect('/welcome') : new Response('Forbidden', { status: 403 }), cookies);
    }
    const list = await platform.memberships(user.id, client);
    if (!list || list.length === 0) return withCookies(redirect('/workspaces/new'), cookies);
    const wanted = readCookie(req, WS_COOKIE);
    let membership = list.find((m) => m.workspaceId === wanted);
    if (!membership) {
      membership = list[0];
      cookies.push(wsCookie(membership.workspaceId));
    }
    const pathname = new URL(req.url).pathname;
    // 구독이 끝난 회사: 요금제·계정·약관 등 허용 경로 밖은 잠근다
    const access = accessOf(await store.ensure(membership.workspaceId), now());
    if (!access.active && !isAllowedWhenLocked(pathname)) {
      c.set('workspaceId', membership.workspaceId);
      const locked = safe ? redirect('/billing?locked=1') : Response.json({ error: 'subscription_inactive' }, { status: 402 });
      return withCookies(locked, cookies);
    }
    // 예시 회사: 위험한 동작은 막는다
    if ((await demo.isDemoWorkspace(membership.workspaceId)) && isBlockedForDemo(req.method, pathname, env)) {
      c.set('workspaceId', membership.workspaceId);
      return withCookies(await blockedResponse(req, demoHtml), cookies);
    }
    // 회사 단위 속도 규칙 (자동 요약·연결 확인·공고 가져오기·초대)
    const rule = matchRule(req.method, pathname, 'workspace');
    if (rule) {
      const hit = await guard.hitWorkspace(membership.workspaceId, rule);
      if (!hit.ok) {
        c.set('workspaceId', membership.workspaceId);
        const tooMany = new Response(GUARD_TEXT.tooMany(Math.max(1, Math.ceil(hit.retryAfterSec / 60))), {
          status: 429,
          headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(hit.retryAfterSec) },
        });
        return withCookies(tooMany, cookies);
      }
    }
    const { runtime, release: done } = await acquire(membership.workspaceId);
    try {
      await runtime.ctx.keys.load();
      memberMap.set(req, memberOf(membership));
      c.set('workspaceId', membership.workspaceId);
      const rc = { client, userId: user.id, workspaceId: membership.workspaceId };
      const res = await db.withWorkspace(membership.workspaceId, () => als.run(rc, () => runtime.router.fetch(req)));
      return withCookies(res, cookies);
    } finally {
      done();
    }
  });

  // 워커가 부르는 한 회사 실행: 그 회사 런타임으로 잡을 돌린다. 보낼 것이 없으면 null (daily 는 항상 보낸다)
  async function runJob(msg) {
    jobStarts.set(msg.runId, Date.now());
    const { runtime, release: done } = await acquire(msg.workspaceId);
    try {
      await runtime.ctx.keys.load();
      const n = await db.withWorkspace(msg.workspaceId, () => runtime.ctx.jobs[RUNNERS[msg.job]]({ date: msg.date }));
      if (n === null || n === undefined) return null;
      if (msg.job !== 'daily' && n.count === 0) return null;
      return n;
    } finally {
      done();
    }
  }

  // 워커가 부르는 발송: 그 회사 설정의 웹훅 주소로 한 번만. 실패하면 throw 해서 워커가 재시도한다
  async function deliver(workspaceId, payload, runId) {
    const { runtime, release: done } = await acquire(workspaceId);
    try {
      // 예시 회사는 방문자가 아무 주소나 넣을 수 있으므로 웹훅·이메일 모두 보내지 않는다
      if (runtime.ctx.demo) {
        logger.info({ module: 'worker', workspaceId, runId, kind: payload.kind, reason: 'demo_workspace' }, 'delivery skipped');
        return;
      }
      const [r, mail] = await db.withWorkspace(workspaceId, async () => {
        const url = String((await runtime.ctx.settings.get('notify_webhook_url')) ?? '').trim();
        const hook = await runtime.ctx.notify.deliver({ kind: payload.kind, date: payload.date, runId, url, payload });
        // 이메일 채널: 웹훅 뒤에 보낸다. 기록·중복 방지는 '<kind>:email' 로 따로
        return [hook, await runtime.ctx.emailAlerts.deliver({ payload, runId })];
      });
      if (r.reason === 'failed' || mail.reason === 'failed') throw Object.assign(new Error('delivery failed'), { code: 'DELIVERY_FAILED' });
    } finally {
      done();
    }
  }

  let worker = null;

  function makeWorker() {
    return createWorker({
      queue,
      db,
      runJob,
      deliver,
      log: workerLog,
      pollMs: intEnv(env.APP_WORKER_POLL_MS, 5000),
      concurrency: intEnv(env.APP_WORKER_CONCURRENCY, 2),
      timeoutMs: intEnv(env.APP_JOB_TIMEOUT_MS, 300000),
    });
  }
  /** @type {Map<string, number>} runId → 실행 시작 시각 (job 로그의 ms) */
  const jobStarts = new Map();

  // 워커의 한 줄을 job 구조화 로그로: {"msg":"job","job","runId","workspaceId","status","ms","attempt"}
  function workerLog(line) {
    const m = WORKER_LINE_RE.exec(String(line));
    if (!m) {
      logger.info({ module: 'worker' }, String(line));
      return;
    }
    const [, runId, attempt, outcome, code] = m;
    const [job, date, workspaceId] = runId.split(':');
    const status = code ? 'failed' : outcome === 'already done' ? 'skipped' : outcome;
    const started = jobStarts.get(runId);
    jobStarts.delete(runId);
    const fields = { job, runId, workspaceId, date, status, attempt: Number(attempt) };
    if (started !== undefined) fields.ms = Date.now() - started;
    if (code) fields.errorCode = code;
    (status === 'failed' || status === 'dead' ? logger.warn : logger.info).call(logger, fields, 'job');
  }

  return {
    fetch: (req, envArg, executionCtx) => app.fetch(req, envArg, executionCtx),
    async close() {
      closed = true;
      if (worker) {
        const w = worker;
        worker = null;
        await w.stop();
      }
      for (const pending of runtimes.values()) closeLater(pending);
      for (const pending of retired) closeLater(pending);
      runtimes.clear();
      retired.clear();
      await Promise.allSettled([...closing]);
      if (!givenDb && !dbClosed) {
        dbClosed = true;
        await db.close();
      }
    },
    runtimeFor,
    platform,
    db,
    startWorker() {
      if (closed || worker || String(env.APP_WORKER ?? '1').trim() === '0') return;
      worker = makeWorker();
      worker.start();
    },
    async stopWorker() {
      const w = worker;
      worker = null;
      if (w) await w.stop();
    },
  };
}
