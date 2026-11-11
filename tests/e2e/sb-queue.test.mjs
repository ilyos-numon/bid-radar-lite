import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';
import { startNotifySink } from './helpers/mock-servers.mjs';
import {
  skipIfDown,
  startSbApp,
  randomEmail,
  signupAndVerify,
  createWorkspace,
  withOrigin,
} from './helpers/supabase.mjs';

// Supabase 모드 작업 큐: ?all=1 은 회사별 메시지로 나눠 202, 워커가 회사마다 한 번 발송, 실패는 그 회사에만
const PASSWORD = 'e2e-password-1';
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const JOB_TOKEN = 'e2e-job';
const WAIT_MS = 60000;

const cleanups = [];

async function saveHook(app, cookie, hookUrl) {
  const saved = await fetch(
    `${app.baseUrl}/settings`,
    withOrigin(app.baseUrl, {
      method: 'POST',
      body: new URLSearchParams({
        keywords: '조경, 수목, 가로수, 공원',
        regions: '경기, 서울',
        budgetMin: '30000000',
        budgetMax: '500000000',
        webhookUrl: hookUrl,
      }),
      headers: { cookie },
      redirect: 'manual',
    }),
  );
  assert.ok(saved.status === 302 || saved.status === 303, `settings save ${saved.status}`);
}

async function newCompany(app, tag, hookUrl) {
  const email = randomEmail(tag);
  const first = await signupAndVerify(app.baseUrl, { email, password: PASSWORD, name: `${tag}대표` });
  const made = await createWorkspace(app.baseUrl, first.cookie, { company: `${tag} 조경`, name: `${tag}대표` });
  await saveHook(app, made.cookie, hookUrl);
  return { workspaceId: made.workspaceId, cookie: made.cookie };
}

async function startQueueApp() {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  const app = await startSbApp({
    env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key', APP_SHARED_KEYS: '1', APP_WORKER_POLL_MS: '300', APP_WORKER_CONCURRENCY: '4' },
  });
  cleanups.push(() => app.stop());
  return app;
}

const jobGet = (app, pathname, token = JOB_TOKEN) =>
  fetch(`${app.baseUrl}${pathname}`, { headers: token === null ? {} : { 'x-job-token': token } });

async function runsOf(app, date) {
  const res = await jobGet(app, `/api/jobs/daily/runs?date=${date}`);
  assert.equal(res.status, 200);
  return res.json();
}

/** cond(runs) 가 참이 될 때까지 /runs 를 읽는다 (최대 WAIT_MS) */
async function waitRuns(app, date, cond, what) {
  const deadline = Date.now() + WAIT_MS;
  let runs = [];
  while (Date.now() < deadline) {
    runs = await runsOf(app, date);
    if (cond(runs)) return runs;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.fail(`timed out waiting for ${what}; runs: ${JSON.stringify(runs.map((r) => [r.status, r.errorCode]))}`);
}

const rowOf = (runs, workspaceId) => runs.find((r) => r.workspaceId === workspaceId);
const postsFor = (sink, workspaceId, date) => sink.received.filter((p) => p.runId === `daily:${date}:${workspaceId}`);

describe('sb queue', () => {
  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('sb-queue: all=1 answers 202, each company is sent once, second call skips, a failing company stays isolated', { skip: skipIfDown, timeout: 240000 }, async () => {
    const date = '2026-12-07';
    const sink = await startNotifySink({ port: 0 });
    cleanups.push(() => sink.close());
    const app = await startQueueApp();
    const A = await newCompany(app, 'quea', `${sink.baseUrl}/notify`);
    const C = await newCompany(app, 'quec', `${sink.baseUrl}/notify`);

    const res = await jobGet(app, `/api/jobs/daily?all=1&date=${date}`);
    assert.equal(res.status, 202);
    const first = await res.json();
    assert.equal(first.runId, `daily:${date}`);
    assert.ok(first.enqueued >= 2, `at least our 2 companies are enqueued (${first.enqueued})`);

    await waitRuns(app, date, (runs) => [A, C].every((w) => rowOf(runs, w.workspaceId)?.status === 'done'), 'both companies done');
    for (const w of [A, C]) {
      const posts = postsFor(sink, w.workspaceId, date);
      assert.equal(posts.length, 1, 'exactly one POST per company');
      assert.equal(posts[0].kind, 'bids');
      assert.equal(posts[0].date, date);
    }

    // 같은 날 다시 부르면 이미 끝난 회사는 건너뛴다 (발송도 늘지 않는다)
    const again = await (await jobGet(app, `/api/jobs/daily?all=1&date=${date}`)).json();
    assert.ok(again.skipped >= 2, `second call skips our 2 companies (${again.skipped})`);
    assert.equal(again.enqueued + again.skipped, first.enqueued + first.skipped, 'same set of companies');
    await waitRuns(app, date, (runs) => runs.every((r) => r.status !== 'queued' && r.status !== 'running'), 'queue drained');
    for (const w of [A, C]) {
      assert.equal(postsFor(sink, w.workspaceId, date).length, 1, 'still one POST per company');
      assert.equal(rowOf(await runsOf(app, date), w.workspaceId).attempt, 1, 'not run twice');
    }

    // 다음 날: C 의 알림 주소가 500 을 돌려주면 C 만 failed, A 는 done
    const next = '2026-12-08';
    await saveHook(app, C.cookie, `${sink.baseUrl}/fail`);
    const res2 = await jobGet(app, `/api/jobs/daily?all=1&date=${next}`);
    assert.equal(res2.status, 202);
    assert.ok((await res2.json()).enqueued >= 2);
    const runs = await waitRuns(
      app,
      next,
      (r) => rowOf(r, A.workspaceId)?.status === 'done' && rowOf(r, C.workspaceId)?.status === 'failed',
      'A done and C failed',
    );
    assert.equal(rowOf(runs, C.workspaceId).errorCode, 'DELIVERY_FAILED');
    assert.equal(rowOf(runs, A.workspaceId).errorCode, null);
    assert.equal(postsFor(sink, A.workspaceId, next).length, 1, 'A sent once');
    assert.equal(postsFor(sink, C.workspaceId, next).length, 1, 'C was tried once');
  });

  it('sb-queue: job endpoints refuse a missing token and a bad date', { skip: skipIfDown, timeout: 120000 }, async () => {
    const app = await startQueueApp();
    assert.equal((await jobGet(app, '/api/jobs/daily?all=1&date=2026-12-09', null)).status, 403);
    assert.equal((await jobGet(app, '/api/jobs/daily?all=1&date=2026-12-09', 'wrong')).status, 403);
    assert.equal((await jobGet(app, '/api/jobs/daily/runs?date=2026-12-09', null)).status, 403);
    assert.equal((await jobGet(app, '/api/jobs/daily?all=1&date=not-a-date')).status, 400);
    assert.equal((await jobGet(app, '/api/jobs/nope?all=1')).status, 404);
  });
});
