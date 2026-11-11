// 인프로세스 워커: pgmq 'jobs' 를 읽어 회사별로 시간 제한·재시도·dead letter·실행 ID 멱등으로 처리한다
import { isJobMessage } from './queue.mjs';
import { logger } from './log.mjs';

const SET_RUNNING_SQL = `UPDATE job_runs SET status = 'running', attempt = $3, started_at = $4, finished_at = NULL, error_code = NULL
  WHERE job = $1 AND date = $2`;
const SET_END_SQL = `UPDATE job_runs SET status = $3, finished_at = $4, error_code = $5 WHERE job = $1 AND date = $2`;

/** 로그용 오류 코드(메시지·값 없이) */
function codeOf(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'error';
}

/**
 * @param {{ queue: object, db: object, runJob: (msg: object, signal: AbortSignal) => Promise<object|null>,
 *   deliver: (ws: string, payload: object, runId: string) => Promise<void>, log?: (line: string) => void,
 *   pollMs?: number, concurrency?: number, timeoutMs?: number, maxAttempts?: number, now?: () => Date }} opts
 * @returns {{ start(): void, stop(): Promise<void>, drain(opts?: { maxMs?: number }): Promise<{ processed: number, remaining: number }> }}
 */
export function createWorker({
  queue,
  db,
  runJob,
  deliver,
  log = (line) => logger.info(String(line)),
  pollMs = 5000,
  concurrency = 2,
  timeoutMs = 300000,
  maxAttempts = 3,
  now = () => new Date(),
}) {
  const vtSec = Math.ceil(timeoutMs / 1000) + 30;
  let running = false;
  let timer = null;
  let loop = null;

  const iso = () => now().toISOString();
  const inWs = (ws, sql, params) => db.withWorkspace(ws, () => db.run(sql, params));
  const statusOf = async (m) => {
    const row = await db.withWorkspace(m.workspaceId, () =>
      db.get('SELECT status, run_id FROM job_runs WHERE job = $1 AND date = $2', [m.job, m.date]),
    );
    return row ? String(row.status) : null;
  };

  /** 시간 제한: 넘으면 signal 을 끊고 { code: 'TIMEOUT' } 로 실패 */
  async function withTimeout(m) {
    const ac = new AbortController();
    let t;
    const timeout = new Promise((_, reject) => {
      t = setTimeout(() => {
        ac.abort();
        reject(Object.assign(new Error('job timeout'), { code: 'TIMEOUT' }));
      }, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => runJob(m, ac.signal)), timeout]);
    } finally {
      clearTimeout(t);
    }
  }

  async function handle({ msgId, readCt, message: m }) {
    if (!isJobMessage(m)) {
      log(`[worker] bad message ${msgId} archived`);
      await queue.archive(msgId);
      return;
    }
    const tag = `${m.runId} attempt ${readCt}`;
    // 재시도 상한을 넘은 메시지: dead letter(archive) + job_runs dead
    if (readCt > maxAttempts) {
      await queue.archive(msgId);
      await inWs(m.workspaceId, SET_END_SQL, [m.job, m.date, 'dead', iso(), 'MAX_ATTEMPTS']);
      log(`[worker] ${tag} dead`);
      return;
    }
    // 실행 ID 멱등: 이미 끝난 실행은 다시 돌리지 않는다
    if ((await statusOf(m)) === 'done') {
      await queue.ack(msgId);
      log(`[worker] ${tag} already done`);
      return;
    }
    await inWs(m.workspaceId, SET_RUNNING_SQL, [m.job, m.date, readCt, iso()]);
    try {
      const n = await withTimeout(m);
      if (n !== null && n !== undefined) await deliver(m.workspaceId, { ...n, runId: m.runId }, m.runId);
    } catch (err) {
      const code = codeOf(err);
      await inWs(m.workspaceId, SET_END_SQL, [m.job, m.date, 'failed', iso(), code]);
      // 메시지는 남겨 둔다: 보이지 않는 시간(vt)이 지나면 다시 읽혀 재시도된다
      log(`[worker] ${tag} failed: ${code}`);
      return;
    }
    await inWs(m.workspaceId, SET_END_SQL, [m.job, m.date, 'done', iso(), null]);
    await queue.ack(msgId);
    log(`[worker] ${tag} done`);
  }

  async function tick() {
    let msgs = [];
    try {
      msgs = await queue.read({ vtSec, qty: concurrency });
    } catch (err) {
      log(`[worker] read failed: ${codeOf(err)}`);
    }
    // 한 회사가 실패·시간 초과해도 나머지는 계속한다
    await Promise.all(
      msgs.map((x) =>
        handle(x).catch((err) => {
          log(`[worker] message ${x.msgId} error: ${codeOf(err)}`);
        }),
      ),
    );
    return msgs.length;
  }

  function schedule(ms) {
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      loop = tick().then((n) => {
        loop = null;
        schedule(n > 0 ? 0 : pollMs);
      });
    }, ms);
  }

  return {
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      if (loop) await loop;
    },
    /** 요청 안에서 큐를 비운다 (start() 와 무관). 빈 응답이거나 maxMs 가 지나면 끝낸다 */
    async drain({ maxMs = 240000 } = {}) {
      const began = now().getTime();
      let processed = 0;
      for (;;) {
        const n = await tick();
        processed += n;
        if (n === 0 || now().getTime() - began > maxMs) break;
      }
      let remaining = 0;
      try {
        remaining = Number(await queue.depth());
      } catch (err) {
        log(`[worker] depth failed: ${codeOf(err)}`);
      }
      return { processed, remaining };
    },
  };
}
