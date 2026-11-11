// 회사별 작업 큐: pgmq 'jobs' 큐(send_batch/read/delete/archive) 와 job_runs 멱등 등록
const QUEUE = 'jobs';
export const JOB_NAMES = ['daily', 'reminders', 'support'];

/** `${job}:${date}:${workspaceId}` */
export function runIdOf(job, date, workspaceId) {
  return `${job}:${date}:${workspaceId}`;
}

/** @returns {{ v: 1, runId: string, job: string, workspaceId: string, date: string, enqueuedAt: string }} JobMessage */
export function jobMessage(job, date, workspaceId, enqueuedAt) {
  return { v: 1, runId: runIdOf(job, date, workspaceId), job, workspaceId, date, enqueuedAt };
}

/** 메시지 모양 검사 (모르는 판·잘못된 값은 버린다) */
export function isJobMessage(m) {
  return (
    Boolean(m) &&
    typeof m === 'object' &&
    m.v === 1 &&
    JOB_NAMES.includes(m.job) &&
    typeof m.workspaceId === 'string' &&
    m.workspaceId !== '' &&
    typeof m.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(m.date) &&
    m.runId === runIdOf(m.job, m.date, m.workspaceId)
  );
}

/**
 * pgmq 'jobs' 큐. 모든 호출은 db.admin (워크스페이스 설정 없이 풀에서 직접).
 * @param {{ db: object }} opts
 */
export function createQueue({ db }) {
  return {
    /** @param {object[]} msgs JobMessage[] @returns {Promise<number>} 보낸 개수 */
    async enqueue(msgs) {
      if (!Array.isArray(msgs) || msgs.length === 0) return 0;
      const r = await db.admin('SELECT * FROM pgmq.send_batch($1::text, $2::jsonb[], $3::integer)', [
        QUEUE,
        msgs.map((m) => JSON.stringify(m)),
        0,
      ]);
      return r.rowCount;
    },
    /** @param {{ vtSec: number, qty: number }} opts */
    async read({ vtSec, qty }) {
      const r = await db.admin(
        "SELECT msg_id, read_ct, message FROM pgmq.read($1::text, $2::integer, $3::integer, '{}'::jsonb)",
        [QUEUE, Math.max(1, Math.ceil(Number(vtSec) || 1)), Math.max(1, Math.floor(Number(qty) || 1))],
      );
      return r.rows.map((row) => ({
        msgId: BigInt(row.msg_id),
        readCt: Number(row.read_ct),
        message: typeof row.message === 'string' ? JSON.parse(row.message) : row.message,
      }));
    },
    async ack(msgId) {
      await db.admin('SELECT pgmq.delete($1::text, $2::bigint)', [QUEUE, String(msgId)]);
    },
    async archive(msgId) {
      await db.admin('SELECT pgmq.archive($1::text, $2::bigint)', [QUEUE, String(msgId)]);
    },
    async depth() {
      const r = await db.admin('SELECT count(*)::integer AS n FROM pgmq.q_jobs');
      return Number(r.rows[0] ? r.rows[0].n : 0);
    },
  };
}

// 같은 (job, date) 가 이미 queued/running/done 이면 건너뛴다. failed/dead 는 다시 queued 로 되돌린다
const CLAIM_SQL = `INSERT INTO job_runs (job, date, run_id, status, attempt)
  VALUES ($1, $2, $3, 'queued', 0)
  ON CONFLICT (workspace_id, job, date) DO UPDATE SET
    run_id = excluded.run_id, status = 'queued', attempt = 0, started_at = NULL, finished_at = NULL, error_code = NULL
  WHERE job_runs.status IN ('failed', 'dead')
  RETURNING run_id`;

/**
 * 회사마다 job_runs 에 queued 를 잡고(멱등), 새로 잡힌 것만 큐에 넣는다.
 * @param {{ db: object, queue: object, workspaceIds: string[], job: string, date: string, now?: () => Date }} opts
 * @returns {Promise<{ runId: string, enqueued: number, skipped: number }>}
 */
export async function enqueueRuns({ db, queue, workspaceIds, job, date, now = () => new Date() }) {
  const msgs = [];
  let skipped = 0;
  for (const ws of workspaceIds) {
    const runId = runIdOf(job, date, ws);
    const r = await db.withWorkspace(ws, () => db.run(CLAIM_SQL, [job, date, runId]));
    if (r.rowCount > 0) msgs.push(jobMessage(job, date, ws, now().toISOString()));
    else skipped += 1;
  }
  let enqueued = 0;
  if (msgs.length > 0) {
    try {
      enqueued = await queue.enqueue(msgs);
    } catch (err) {
      // 큐에 못 넣었으면 queued 로 남기지 않는다(다음 트리거가 다시 잡게 failed 로)
      for (const m of msgs) {
        await db.withWorkspace(m.workspaceId, () =>
          db.run("UPDATE job_runs SET status = 'failed', error_code = 'ENQUEUE_FAILED' WHERE job = $1 AND date = $2", [job, date]),
        );
      }
      throw err;
    }
  }
  return { runId: `${job}:${date}`, enqueued, skipped };
}
