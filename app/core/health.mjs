// /readyz: 실제 연결 점검(db·큐·인증). 각 점검 2초 제한, 결과 10초 캐시
const TIMEOUT_MS = 2000;
const CACHE_MS = 10000;

function withTimeout(fn, ms) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms);
  });
  return Promise.race([Promise.resolve().then(fn), timer]).finally(() => clearTimeout(t));
}

async function timed(fn, ms) {
  const start = Date.now();
  try {
    const extra = await withTimeout(fn, ms);
    return { ok: true, ms: Date.now() - start, ...(extra && typeof extra === 'object' ? extra : {}) };
  } catch {
    // 오류 내용(주소·계정)은 응답에 싣지 않는다
    return { ok: false, ms: Date.now() - start };
  }
}

/**
 * @param {{ db: object, queue?: { depth(): Promise<number> }, platform?: { preflight?(opts?: object): Promise<{ ok: boolean }> }, mode: string, timeoutMs?: number, cacheMs?: number, now?: () => number }} opts
 *   queue·platform 이 없으면 그 점검을 싣지 않는다(기존 모드는 db 만)
 */
export function createHealth({ db, queue, platform, mode, timeoutMs = TIMEOUT_MS, cacheMs = CACHE_MS, now = Date.now } = {}) {
  let cached = null; // { at, promise }

  async function check() {
    const jobs = {
      db: timed(async () => {
        await db.admin('select 1');
        const s = typeof db.stats === 'function' ? db.stats() : null;
        return s && Number.isFinite(s.waiting) ? { waiting: s.waiting } : null;
      }, timeoutMs),
    };
    if (queue) jobs.queue = timed(async () => ({ depth: await queue.depth() }), timeoutMs);
    if (platform) {
      jobs.auth = timed(async () => {
        if (typeof platform.preflight !== 'function') throw new Error('no preflight');
        const r = await platform.preflight({ db });
        if (!r || r.ok !== true) throw new Error('auth not ready');
        return null;
      }, timeoutMs);
    }
    const checks = {};
    for (const [k, p] of Object.entries(jobs)) checks[k] = await p;
    const ok = Object.values(checks).every((c) => c.ok);
    return { status: ok ? 'ok' : 'degraded', mode, checks };
  }

  async function readyz() {
    const t = now();
    if (!cached || t - cached.at >= cacheMs) cached = { at: t, promise: check() };
    return cached.promise;
  }

  /** GET /readyz 응답: ok → 200, degraded → 503 */
  async function response() {
    const r = await readyz();
    return Response.json(r, { status: r.status === 'ok' ? 200 : 503, headers: { 'cache-control': 'no-store' } });
  }

  return { readyz, response };
}
