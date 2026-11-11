// 예약 실행 없음 모드(APP_SCHEDULER_OFF=1)의 하루 첫 방문 트리거.
// rate_limits 표에 KST 날짜별 클레임 행 하나(hits 1 = 진행 중, 2 = 완료)를 두고, 첫 방문 요청이 앱 자신의 잡 엔드포인트를 부른다
import { rateKey } from './rate-store.mjs';
import { logger } from './log.mjs';
import { validDate, RUN_UPSERT_SQL, RUNS_SQL } from './routes-jobs.mjs';

export const DAY_START_PATHS = { collect: '/api/jobs/collect?all=1', demoReset: '/api/jobs/demo-reset' };
export const DAY_START_STATES = ['off', 'pending', 'running', 'done'];

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const CLAIM_SQL = `INSERT INTO rate_limits (key, hits, reset_at) VALUES ($1, 1, now() + ($2::double precision * interval '1 millisecond'))
  ON CONFLICT (key) DO UPDATE SET hits = 1, reset_at = excluded.reset_at WHERE rate_limits.reset_at <= now()
  RETURNING hits`;
const FINISH_SQL = "UPDATE rate_limits SET hits = 2, reset_at = now() + ($2::double precision * interval '1 millisecond') WHERE key = $1";
const STATE_SQL = 'SELECT hits FROM rate_limits WHERE key = $1 AND reset_at > now()';
const RELEASE_SQL = 'DELETE FROM rate_limits WHERE key = $1';

/** @param {Record<string,string|undefined>} [env] */
export function schedulerOff(env) {
  return env?.APP_SCHEDULER_OFF === '1';
}

/**
 * 첫 방문 self-request 주소의 origin. 유효한 http(s) APP_BASE_URL 에서만 만든다(요청 Host 는 쓰지 않는다: 잡 토큰이 밖으로 새지 않게)
 * @param {Record<string,string|undefined>} [env] @returns {string|null}
 */
export function selfOrigin(env) {
  const base = String(env?.APP_BASE_URL ?? '').trim();
  if (!base) return null;
  try {
    const u = new URL(base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** @param {Date} d @returns {string} YYYY-MM-DD (KST) */
export function kstDate(d) {
  return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

// 다음 KST 자정까지 남은 ms
function untilMidnight(d) {
  const shifted = d.getTime() + KST_OFFSET_MS;
  const next = Math.floor(shifted / DAY_MS) * DAY_MS + DAY_MS;
  return Math.max(1, next - shifted);
}

/** 양의 정수 환경변수(없거나 잘못되면 기본값) */
function intEnv(v, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

/** 로그용 오류 코드(메시지·값 없이) */
function errorCode(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'error';
}

function kindOf(kind) {
  if (!Object.hasOwn(DAY_START_PATHS, kind)) throw new Error(`unknown day start kind: ${kind}`);
  return kind;
}

const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });

/**
 * @param {{ db: { admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, env?: Record<string,string|undefined>,
 *   now?: () => Date, kick?: (url: URL|string) => Promise<Response>, log?: { warn: Function } }} deps
 */
export function createDayStart({ db, env = {}, now = () => new Date(), kick, log = logger } = {}) {
  if (!db || typeof db.admin !== 'function') throw new Error('db is required');
  const origin = selfOrigin(env);
  const wanted = schedulerOff(env) && Boolean(env.APP_JOB_TOKEN);
  const enabled = wanted && origin !== null;
  if (wanted && !enabled) log.warn({ module: 'day-start' }, 'APP_BASE_URL missing or invalid: first visit day start is off');
  const ttlMs = intEnv(env.APP_DAY_START_CLAIM_TTL_MS, 600000);
  const kickWaitMs = intEnv(env.APP_DAY_START_KICK_WAIT_MS, 1500);
  const keyOf = (kind, date) => rateKey(`daystart:${kindOf(kind)}:${date}`);
  // 이 인스턴스가 이미 완료를 본 날짜(DB 조회 생략)
  const doneFor = {};

  const api = {
    enabled,
    async claim(kind, date) {
      const r = await db.admin(CLAIM_SQL, [keyOf(kind, date), ttlMs]);
      return r.rows.length > 0;
    },
    async finish(kind, date) {
      await db.admin(FINISH_SQL, [keyOf(kind, date), untilMidnight(now())]);
    },
    async release(kind, date) {
      await db.admin(RELEASE_SQL, [keyOf(kind, date)]);
    },
    async state(kind, date) {
      const r = await db.admin(STATE_SQL, [keyOf(kind, date)]);
      if (!r.rows[0]) return 'pending';
      return Number(r.rows[0].hits) >= 2 ? 'done' : 'running';
    },
    // 두 번째 인자(호출 쪽 origin)는 쓰지 않는다. 킥 주소는 항상 APP_BASE_URL 의 origin
    async touch(kind, _origin, { waitMs } = {}) {
      kindOf(kind);
      if (!enabled) return { kicked: false, state: 'off' };
      const date = kstDate(now());
      if (doneFor[kind] === date) return { kicked: false, state: 'done' };
      if (!(await api.claim(kind, date))) {
        const state = await api.state(kind, date);
        if (state === 'done') doneFor[kind] = date;
        return { kicked: false, state };
      }
      let finished = false;
      const onResponse = async (res) => {
        let body = null;
        if (res && res.status === 200) body = await res.json().catch(() => null);
        const complete = body && (kind === 'collect' ? body.remaining === 0 : body.ok === true);
        if (complete) {
          await api.finish(kind, date);
          doneFor[kind] = date;
          finished = true;
        } else {
          await api.release(kind, date);
        }
      };
      const p = Promise.resolve()
        .then(() => kick(new URL(DAY_START_PATHS[kind], origin)))
        .then(onResponse)
        .catch(async (err) => {
          log.warn({ module: 'day-start', kind, code: errorCode(err) }, 'day start kick failed');
          await api.release(kind, date).catch((e) => log.warn({ module: 'day-start', kind, code: errorCode(e) }, 'day start release failed'));
        });
      await Promise.race([p, sleep(waitMs ?? kickWaitMs)]);
      return { kicked: true, state: finished ? 'done' : 'running' };
    },
    async status() {
      const date = kstDate(now());
      if (!enabled) return { date, collect: 'off', demoReset: 'off' };
      const of = async (kind) => (doneFor[kind] === date ? 'done' : api.state(kind, date));
      return { date, collect: await of('collect'), demoReset: await of('demoReset') };
    },
  };
  return api;
}

/**
 * GET /api/jobs/collect?all=1[&date=] : 활성 구독·비데모 회사마다 하루 수집(runDaily)을 이 요청 안에서 순서대로 돈다.
 * 알림 발송은 하지 않는다. APP_DAY_START_MAX_MS 를 넘으면 멈추고 remaining 으로 남은 회사 수를 알린다
 * @param {import('hono').Hono} app
 */
export function registerCollectRoutes(app, { env = {}, jobAuthorized, workspaceIds, activeWorkspaceIds, isDemoWorkspace, runIn, db, now = () => new Date() }) {
  const maxMs = intEnv(env.APP_DAY_START_MAX_MS, 240000);
  app.get('/api/jobs/collect', async (c) => {
    if (!jobAuthorized(c.req.raw)) return c.json({ error: 'forbidden' }, 403);
    if (c.req.query('all') !== '1') return c.json({ error: 'all_required' }, 400);
    const raw = c.req.query('date');
    if (raw !== undefined && raw !== '' && !validDate(raw)) return c.json({ error: 'bad_date' }, 400);
    const date = raw ? raw : kstDate(now());

    const ids = [];
    for (const id of await activeWorkspaceIds(await workspaceIds())) {
      if (!(await isDemoWorkspace(id))) ids.push(String(id));
    }
    const started = now().getTime();
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    for (const id of ids) {
      if (now().getTime() - started > maxMs) break;
      const prev = await db.withWorkspace(id, () => db.get(RUNS_SQL, ['daily', date]));
      if (prev && String(prev.status) === 'done') {
        skipped += 1;
        continue;
      }
      const startedAt = now().toISOString();
      let status = 'done';
      let code = null;
      try {
        await runIn(id, (rt) => rt.ctx.jobs.runDaily({ date }));
      } catch (err) {
        status = 'failed';
        code = String((err && err.code) || 'error');
        logger.warn({ module: 'day-start', job: 'collect', workspaceId: id, code: errorCode(err) }, 'collect failed');
      }
      await db.withWorkspace(id, () =>
        db.run(RUN_UPSERT_SQL, ['daily', date, `daily:${date}:${id}`, status, startedAt, now().toISOString(), code]),
      );
      if (status === 'done') processed += 1;
      else failed += 1;
    }
    return c.json({ date, total: ids.length, processed, failed, skipped, remaining: ids.length - processed - failed - skipped });
  });
}
