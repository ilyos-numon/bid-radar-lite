// 운영 현황(관리자 전용)과 공개 서비스 현황 수치.
// 플랫폼 표(subscriptions·payments·billing_jobs·demo_workspaces)는 db.admin 으로,
// 회사별 표(collect_days·job_runs·notification_deliveries)는 회사마다 withWorkspace 안에서 읽는다(행 보안 정책을 그대로 지킨다).
import { PLANS } from '../billing/plans.mjs';

export const OPS_TEXT = {
  admin: { title: '운영 현황', tiles: ['회사 수', '구독', '월 반복 매출', '최근 30일 결제 실패', '오늘 작업', '대기열', '데모 초기화'] },
  status: {
    title: '서비스 현황',
    bids: '오늘 수집한 공고',
    lastRun: '마지막 수집 시각',
    deliveries: '오늘 보낸 알림',
    ok: '정상',
    degraded: '점검 중',
    example: '예시 수치',
    none: '아직 수집 전',
    collect: { label: '오늘 수집', pending: '첫 방문 때 시작', running: '진행 중', done: '완료' },
  },
};

const SUB_STATUSES = ['trialing', 'active', 'past_due', 'canceled', 'expired'];
const JOBS = ['daily', 'reminders', 'support'];
const JOB_STATUSES = ['done', 'failed', 'dead'];
const DAY_MS = 24 * 60 * 60 * 1000;
const KST_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });

/** APP_PLATFORM_ADMIN_EMAILS(쉼표 구분, 대소문자 무시)에 있는 이메일인가. 비어 있으면 아무도 아니다 */
export function isPlatformAdmin(env, email) {
  const me = String(email ?? '').trim().toLowerCase();
  if (!me) return false;
  return String(env?.APP_PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(me);
}

function toDate(v) {
  return v instanceof Date ? v : new Date(v);
}

function iso(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

const num = (v) => Number(v ?? 0) || 0;

/**
 * @param {{ db: object, workspaceIds: () => Promise<string[]>, demoWorkspaceId?: () => Promise<string|null>, queue?: { depth(): Promise<number> }|null, readiness?: () => Promise<boolean>, now?: () => Date|number, cacheMs?: number,
 *   dayStart?: { enabled: boolean, status(): Promise<{ collect: string }> }|null }} deps
 */
export function createOpsStats({ db, workspaceIds, demoWorkspaceId = async () => null, queue = null, readiness = async () => true, now = () => new Date(), cacheMs = 60000, dayStart = null }) {
  const hasAdmin = typeof db.admin === 'function';

  /** 플랫폼 표 읽기. 표가 없거나(기존 모드) 실패하면 null */
  async function platformRows(sql, params = []) {
    if (!hasAdmin) return null;
    try {
      return (await db.admin(sql, params)).rows;
    } catch {
      return null;
    }
  }

  /** 회사별 표 읽기: 회사마다 그 회사 범위 안에서 같은 SQL($1 = 회사 id)을 돌려 행을 모은다 */
  async function tenantRows(ids, sql, params = []) {
    const out = [];
    for (const id of ids) {
      const rows = await db.withWorkspace(id, () => db.all(sql, [id, ...params]));
      out.push(...rows);
    }
    return out;
  }

  async function demoId() {
    try {
      return (await demoWorkspaceId()) ?? null;
    } catch {
      return null;
    }
  }

  async function ids() {
    return [...new Set((await workspaceIds()).map(String))];
  }

  function today() {
    return KST_FMT.format(toDate(now()));
  }

  async function adminSummary() {
    const at = toDate(now());
    const date = today();
    const all = await ids();
    const demo = await demoId();
    const real = all.filter((id) => id !== demo);

    const subscriptions = Object.fromEntries(SUB_STATUSES.map((s) => [s, 0]));
    for (const r of (await platformRows('SELECT status, count(*)::integer AS n FROM subscriptions GROUP BY status')) ?? []) {
      if (Object.hasOwn(subscriptions, r.status)) subscriptions[r.status] = num(r.n);
    }

    let mrr = 0;
    for (const r of (await platformRows("SELECT plan, count(*)::integer AS n FROM subscriptions WHERE status = 'active' GROUP BY plan")) ?? []) {
      mrr += (Object.hasOwn(PLANS, r.plan) ? PLANS[r.plan].price : 0) * num(r.n);
    }

    const since = new Date(at.getTime() - 30 * DAY_MS).toISOString();
    const failed = await platformRows("SELECT count(*)::integer AS n FROM payments WHERE status = 'failed' AND created_at > $1", [since]);
    const paymentFailures30d = num(failed?.[0]?.n);

    const jobsToday = Object.fromEntries(JOBS.map((j) => [j, Object.fromEntries(JOB_STATUSES.map((s) => [s, 0]))]));
    const runs = await tenantRows(all, 'SELECT job, status, count(*)::integer AS n FROM job_runs WHERE workspace_id = $1::uuid AND date = $2 GROUP BY job, status', [date]);
    for (const r of runs) {
      if (jobsToday[r.job] && Object.hasOwn(jobsToday[r.job], r.status)) jobsToday[r.job][r.status] += num(r.n);
    }

    const bj = await platformRows('SELECT charged, failed, expired FROM billing_jobs WHERE run_date = $1', [date]);
    const billingToday = bj && bj[0] ? { charged: num(bj[0].charged), failed: num(bj[0].failed), expired: num(bj[0].expired) } : null;

    let queueDepth = null;
    if (queue && typeof queue.depth === 'function') {
      try {
        queueDepth = num(await queue.depth());
      } catch {
        queueDepth = null;
      }
    }

    let demoInfo = null;
    if (demo) {
      const row = (await platformRows('SELECT seeded_at, reset_count FROM demo_workspaces WHERE workspace_id = $1', [demo]))?.[0];
      demoInfo = { seededAt: iso(row?.seeded_at ?? null), resetCount: num(row?.reset_count) };
    }

    return {
      workspaces: { total: all.length, demo: demo ? 1 : 0 },
      subscriptions,
      mrr,
      paymentFailures30d,
      jobsToday,
      billingToday,
      queueDepth,
      demo: demoInfo,
      example: Boolean(demo) && real.length === 0,
      at: at.toISOString(),
    };
  }

  async function collect(list, date) {
    const rows = await tenantRows(list, 'SELECT coalesce(sum(count), 0)::integer AS bids, max(ran_at) AS last, count(*)::integer AS n FROM collect_days WHERE workspace_id = $1::uuid AND day = $2', [date]);
    let bids = 0;
    let n = 0;
    let last = null;
    for (const r of rows) {
      bids += num(r.bids);
      n += num(r.n);
      if (r.last && (!last || String(r.last) > last)) last = String(r.last);
    }
    return { bids, n, last };
  }

  async function sent(list, date) {
    const rows = await tenantRows(list, "SELECT count(*)::integer AS n FROM notification_deliveries WHERE workspace_id = $1::uuid AND status = 'sent' AND date = $2", [date]);
    return rows.reduce((s, r) => s + num(r.n), 0);
  }

  async function computeStatus() {
    const date = today();
    const demo = await demoId();
    let list = (await ids()).filter((id) => id !== demo);
    let c = await collect(list, date);
    let example = false;
    if (c.n === 0 && demo) {
      list = [demo];
      c = await collect(list, date);
      example = true;
    }
    const deliveries = await sent(list, date);
    let ok = false;
    try {
      ok = (await readiness()) === true;
    } catch {
      ok = false;
    }
    return { date, bids: c.bids, lastRunAt: c.last, deliveries, status: ok ? 'ok' : 'degraded', example };
  }

  /** 오늘 수집 상태: 첫 방문 트리거 모드면 'first-visit'. 캐시하지 않는다(첫 방문 뒤 바로 바뀐다) */
  async function collectState() {
    const trigger = dayStart?.enabled ? 'first-visit' : 'scheduled';
    if (!dayStart) return { trigger, state: 'off' };
    try {
      return { trigger, state: (await dayStart.status()).collect };
    } catch {
      return { trigger, state: 'off' };
    }
  }

  let cached = null; // { at: number, promise }
  async function publicStatus() {
    const [s, collect] = await Promise.all([cachedStatus(), collectState()]);
    return { ...s, collect };
  }

  function cachedStatus() {
    const t = toDate(now()).getTime();
    if (!cached || t - cached.at >= cacheMs || t < cached.at) {
      const promise = computeStatus();
      cached = { at: t, promise };
      promise.catch(() => {
        if (cached && cached.promise === promise) cached = null;
      });
    }
    return cached.promise;
  }

  return { adminSummary, publicStatus };
}
