import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';
import {
  SB,
  skipIfDown,
  startSbApp,
  randomEmail,
  signupAndVerify,
  createWorkspace,
  toPlaywrightCookies,
  withOrigin,
  workerDbUrl,
  adminDbUrl,
  withPg,
} from './helpers/supabase.mjs';

// Supabase 모드 테넌시: 회사 간 격리, 프로세스 2개가 같은 설정을 봄, app_worker 세션의 RLS
const PASSWORD = 'e2e-password-1';
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const KEYWORDS = '도로, 포장';

let browser;
const cleanups = [];

async function newOwner(app, tag, company) {
  const email = randomEmail(tag);
  const first = await signupAndVerify(app.baseUrl, { email, password: PASSWORD, name: `${tag}대표` });
  assert.equal(first.location, '/workspaces/new');
  const made = await createWorkspace(app.baseUrl, first.cookie, { company, name: `${tag}대표` });
  return { cookie: made.cookie, workspaceId: made.workspaceId };
}

async function pageFor(app, cookie) {
  const context = await browser.newContext();
  cleanups.push(() => context.close());
  await context.addCookies(toPlaywrightCookies(app.baseUrl, cookie));
  return context.newPage();
}

/** 한 트랜잭션에서 app.workspace_id 를 정하고 sql 의 n 열을 읽는다 (workspaceId 가 null 이면 정하지 않는다) */
async function countAs(client, workspaceId, sql, params = []) {
  await client.query('BEGIN');
  if (workspaceId !== null) await client.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
  const rows = await client.query(sql, params).then(
    (r) => r.rows,
    () => null, // 정책이 빈 설정을 캐스팅 오류로 거부하는 경우
  );
  await client.query('ROLLBACK');
  return rows === null ? 'error' : Number(rows[0].n);
}

describe('sb tenancy', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('sb-tenancy: A data stays out of B, two processes share settings, DB refuses cross-company rows', { skip: skipIfDown, timeout: 180000 }, async () => {
    const mock = await startMockHttp();
    cleanups.push(() => mock.close());
    mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
    const env = { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key', APP_SHARED_KEYS: '1', APP_WORKER: '0' };
    const p1 = await startSbApp({ env });
    cleanups.push(() => p1.stop());
    const p2 = await startSbApp({ env });
    cleanups.push(() => p2.stop());
    assert.notEqual(p1.baseUrl, p2.baseUrl, 'two separate processes');

    // A: 프로세스 1 에서 조건 저장 → 공고 가져오기
    const A = await newOwner(p1, 'tena', '테넌시 가');
    const pa = await pageFor(p1, A.cookie);
    await pa.goto(`${p1.baseUrl}/settings`);
    await pa.fill('#keywords', '조경, 수목, 가로수, 공원');
    await pa.fill('#regions', '경기, 서울');
    await pa.fill('#budgetMin', '30000000');
    await pa.fill('#budgetMax', '500000000');
    await pa.getByRole('button', { name: '저장', exact: true }).click();
    await pa.getByText('저장했습니다.').waitFor();
    await pa.goto(`${p1.baseUrl}/today`);
    await pa.getByRole('button', { name: '오늘 공고 가져오기' }).click();
    await pa.waitForSelector('ol.bids li.card');
    assert.equal(await pa.locator('ol.bids li.card').count(), 3, 'A imported 3 bids');
    const aTitle = (await pa.locator('ol.bids li.card').first().innerText()).split('\n').find((l) => l.trim() !== '').trim();
    const href = await pa.locator('ol.bids li.card a[href^="/assign/"]').first().getAttribute('href');
    const bidId = decodeURIComponent(href.slice('/assign/'.length));

    // 프로세스 1 에서 바꾼 설정을 프로세스 2 가 본다
    await pa.goto(`${p1.baseUrl}/settings`);
    await pa.fill('#keywords', KEYWORDS);
    await pa.getByRole('button', { name: '저장', exact: true }).click();
    await pa.getByText('저장했습니다.').waitFor();
    const viaP2 = await pageFor(p2, A.cookie);
    await viaP2.goto(`${p2.baseUrl}/settings`);
    assert.equal(await viaP2.locator('#keywords').inputValue(), KEYWORDS, 'process 2 sees A settings saved through process 1');
    await viaP2.goto(`${p2.baseUrl}/today`);
    assert.equal(await viaP2.locator('ol.bids li.card').count(), 3, 'process 2 sees the 3 bids process 1 stored');

    // B: 프로세스 2 에서 다른 회사 — A 공고는 오늘 화면에도 요약에도 없다
    const B = await newOwner(p2, 'tenb', '테넌시 나');
    assert.notEqual(B.workspaceId, A.workspaceId);
    const pb = await pageFor(p2, B.cookie);
    await pb.goto(`${p2.baseUrl}/today`);
    assert.equal(await pb.locator('ol.bids li.card').count(), 0, 'B today has no bids');
    assert.ok(!(await pb.locator('main').innerText()).includes(aTitle), 'no A bid title on B today');
    const cross = await fetch(`${p2.baseUrl}/summary/${encodeURIComponent(bidId)}`, { headers: { cookie: B.cookie }, redirect: 'manual' });
    assert.equal(cross.status, 404, 'B cannot open A bid summary');
    const own = await fetch(`${p1.baseUrl}/summary/${encodeURIComponent(bidId)}`, { headers: { cookie: A.cookie }, redirect: 'manual' });
    assert.equal(own.status, 200, 'A still opens its own summary');

    // app_worker 로 직접 접속: B 세션에서는 A 행이 0, A 세션에서는 3
    await withPg(workerDbUrl(), async (client) => {
      const q = 'SELECT count(*)::int AS n FROM bids WHERE workspace_id = $1';
      assert.equal(await countAs(client, B.workspaceId, q, [A.workspaceId]), 0, 'B session sees 0 rows of A');
      assert.equal(await countAs(client, B.workspaceId, 'SELECT count(*)::int AS n FROM bids'), 0, 'B session sees no bids at all');
      const total = await withPg(adminDbUrl(), async (c) => Number((await c.query(q, [A.workspaceId])).rows[0].n));
      assert.ok(total >= 3, `A has bids stored (${total})`);
      assert.equal(await countAs(client, A.workspaceId, q, [A.workspaceId]), total, 'A session sees all of its bids');
      const noWs = await countAs(client, null, 'SELECT count(*)::int AS n FROM bids');
      assert.ok(noWs === 0 || noWs === 'error', `no workspace set sees nothing (${noWs})`);

      // B 세션에서 A 회사로 행을 넣으려 하면 DB 가 거부한다
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.workspace_id', $1, true)", [B.workspaceId]);
      await assert.rejects(
        client.query(
          "INSERT INTO bids (workspace_id, bid_id, source_id, title, raw, first_seen) VALUES ($1, 'TENANCY-X', 'nara', 'x', '{}', '2026-11-03')",
          [A.workspaceId],
        ),
        /row-level security|policy/i,
      );
      await client.query('ROLLBACK');
    });

    // 로그인하지 않은 요청: 화면은 /welcome 으로, 쓰기는 403
    const today = await fetch(`${p1.baseUrl}/today`, { redirect: 'manual' });
    assert.ok(today.status === 302 || today.status === 303, `signed-out redirect ${today.status}`);
    assert.equal(new URL(today.headers.get('location'), p1.baseUrl).pathname, '/welcome');
    const write = await fetch(
      `${p1.baseUrl}/settings`,
      withOrigin(p1.baseUrl, { method: 'POST', body: new URLSearchParams({ keywords: 'x' }), redirect: 'manual' }),
    );
    assert.equal(write.status, 403);
  });
});
