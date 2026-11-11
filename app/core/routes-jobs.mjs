// 잡 엔드포인트: GET /api/jobs/daily|reminders|support
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// 동기 실행 기록: job_runs 를 (job, date) 로 upsert 한다 (워크스페이스는 세션 설정이 채운다)
export const RUN_UPSERT_SQL = `INSERT INTO job_runs (job, date, run_id, status, attempt, started_at, finished_at, error_code)
  VALUES ($1, $2, $3, $4, 1, $5, $6, $7)
  ON CONFLICT (workspace_id, job, date) DO UPDATE SET
    run_id = excluded.run_id, status = excluded.status, attempt = job_runs.attempt + 1,
    started_at = excluded.started_at, finished_at = excluded.finished_at, error_code = excluded.error_code`;

export const RUNS_SQL =
  'SELECT run_id, status, attempt, started_at, finished_at, error_code FROM job_runs WHERE job = $1 AND date = $2';

/** job_runs 1행 → 응답 모양 */
export function runRow(workspaceId, r) {
  return {
    workspaceId,
    runId: String(r.run_id),
    status: String(r.status),
    attempt: Number(r.attempt),
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    errorCode: r.error_code ?? null,
  };
}

/** @param {object} router @param {object} ctx */
export function registerRoutes(router, ctx) {
  const workspaceId = async () => {
    const row = await ctx.db.get("SELECT current_setting('app.workspace_id', true) AS ws");
    return row && row.ws ? String(row.ws) : '';
  };
  /** run 을 실행하고 (dry 가 아니면) job_runs 에 done/failed 를 남긴다 */
  const runRecorded = async (job, run, { date, dry }) => {
    const runId = `${job}:${date}:${await workspaceId()}`;
    const startedAt = ctx.now().toISOString();
    const record = (status, errorCode) =>
      dry ? null : ctx.db.run(RUN_UPSERT_SQL, [job, date, runId, status, startedAt, ctx.now().toISOString(), errorCode]);
    let n;
    try {
      n = await run({ date, dry });
    } catch (err) {
      await record('failed', String((err && err.code) || 'error'));
      throw err;
    }
    await record('done', null);
    return { n, runId };
  };

  const handle = (job, run, alwaysBody) => async (req) => {
    if (!ctx.auth.checkJob(req)) return Response.json({ error: 'forbidden' }, { status: 403 });
    const q = new URL(req.url).searchParams;
    const raw = q.get('date');
    if (raw !== null && raw !== '' && !validDate(raw)) return Response.json({ error: 'bad_date' }, { status: 400 });
    const date = raw ? raw : ctx.today();
    const dry = q.get('dry') === '1';
    const all = q.get('all') === '1';
    const { n, runId } = await runRecorded(job, run, { date, dry });
    const empty = !alwaysBody && (n === null || n === undefined || n.count === 0);
    // ?all=1: 워크스페이스별 payload 배열. 이 런타임은 워크스페이스 하나라 길이 1, 보낼 것이 없으면 []
    if (all && empty) return Response.json([]);
    if (empty) return new Response(null, { status: 204 });
    // 알림 받을 곳: 설정에 적힌 주소(비면 null). 기록된 알림 내용은 건드리지 않고 응답에만 싣는다
    const saved = String((await ctx.settings.get('notify_webhook_url')) ?? '').trim();
    const payload = { ...n, runId, notifyUrl: saved === '' ? null : saved };
    return Response.json(all ? [payload] : payload);
  };

  // 실행 기록: GET /api/jobs/<name>/runs?date= → [{ workspaceId, runId, status, attempt, startedAt, finishedAt, errorCode }]
  const runs = (job) => async (req) => {
    if (!ctx.auth.checkJob(req)) return Response.json({ error: 'forbidden' }, { status: 403 });
    const raw = new URL(req.url).searchParams.get('date');
    if (raw !== null && raw !== '' && !validDate(raw)) return Response.json({ error: 'bad_date' }, { status: 400 });
    const date = raw ? raw : ctx.today();
    const ws = await workspaceId();
    const rows = await ctx.db.all(RUNS_SQL, [job, date]);
    return Response.json(rows.map((r) => runRow(ws, r)));
  };

  router.get('/api/jobs/daily', handle('daily', (o) => ctx.jobs.runDaily(o), true));
  router.get('/api/jobs/reminders', handle('reminders', (o) => ctx.jobs.runReminders(o), false));
  router.get('/api/jobs/support', handle('support', (o) => ctx.jobs.runSupport(o), false));
  for (const job of ['daily', 'reminders', 'support']) router.get(`/api/jobs/${job}/runs`, runs(job));
}
