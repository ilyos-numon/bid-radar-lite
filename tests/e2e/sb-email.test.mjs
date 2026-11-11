import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';
import { startMockEmail } from './helpers/mock-commerce.mjs';
import {
  SB,
  skipIfDown,
  startSbApp,
  randomEmail,
  signupAndVerify,
  createWorkspace,
  toPlaywrightCookies,
  adminDbUrl,
  withPg,
} from './helpers/supabase.mjs';

// Supabase 모드 이메일 알림: 하루 한 번 수신자별 발송, 수신거부 링크
const PASSWORD = 'e2e-password-1';
const JOB_TOKEN = 'e2e-job';
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const WAIT_MS = 60000;

let browser;
const cleanups = [];

async function newContext(opts = {}) {
  const context = await browser.newContext(opts);
  cleanups.push(() => context.close());
  return context;
}

async function startMailApp() {
  const nara = await startMockHttp();
  cleanups.push(() => nara.close());
  nara.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  const mail = await startMockEmail();
  cleanups.push(() => mail.close());
  const app = await startSbApp({
    env: {
      NARA_API_BASE: nara.baseUrl,
      NARA_API_KEY: 'dummy-key',
      APP_SHARED_KEYS: '1',
      APP_WORKER_POLL_MS: '300',
      APP_WORKER_CONCURRENCY: '4',
      EMAIL_API_BASE: mail.baseUrl,
      EMAIL_API_KEY: 'mock',
      EMAIL_FROM: 'alerts@example.com',
    },
  });
  cleanups.push(() => app.stop());
  return { app, mail };
}

const jobGet = (app, pathname) => fetch(`${app.baseUrl}${pathname}`, { headers: { 'x-job-token': JOB_TOKEN } });

async function waitRunDone(app, date, workspaceId) {
  const deadline = Date.now() + WAIT_MS;
  let row;
  while (Date.now() < deadline) {
    const runs = await (await jobGet(app, `/api/jobs/daily/runs?date=${date}`)).json();
    row = runs.find((r) => r.workspaceId === workspaceId);
    if (row && (row.status === 'done' || row.status === 'failed')) return row;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.fail(`run for ${date} did not finish: ${JSON.stringify(row)}`);
}

async function runDaily(app, mail, date, workspaceId) {
  const res = await jobGet(app, `/api/jobs/daily?all=1&date=${date}`);
  assert.equal(res.status, 202);
  const row = await waitRunDone(app, date, workspaceId);
  await mail.sync(); // 모의 서버가 받은 기록이 다 도착한 뒤에 센다
  return row;
}

/** 로그인한 대표가 설정 화면에서 조건과 알림 이메일을 저장 */
async function saveSettings(page, app, emails) {
  await page.goto(`${app.baseUrl}/settings`);
  await page.fill('#keywords', '조경, 수목, 가로수, 공원');
  await page.fill('#regions', '경기, 서울');
  await page.fill('#budgetMin', '30000000');
  await page.fill('#budgetMax', '500000000');
  await page.fill('#notifyEmails', emails);
  await shot(page, 'settings-email');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했습니다.').waitFor();
}

async function setup(tag, emails) {
  const { app, mail } = await startMailApp();
  const first = await signupAndVerify(app.baseUrl, { email: randomEmail(tag), password: PASSWORD, name: `${tag}대표` });
  const made = await createWorkspace(app.baseUrl, first.cookie, { company: `${tag} 조경`, name: `${tag}대표` });
  const ctx = await newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies(toPlaywrightCookies(app.baseUrl, made.cookie));
  const page = await ctx.newPage();
  await saveSettings(page, app, emails);
  return { app, mail, page, workspaceId: made.workspaceId, cookie: made.cookie };
}

const deliveries = (workspaceId) =>
  withPg(adminDbUrl(), async (c) =>
    (await c.query('SELECT kind, date, status FROM public.notification_deliveries WHERE workspace_id = $1 ORDER BY id', [workspaceId])).rows,
  );

// ?all=1 은 공유 DB 의 모든 회사를 돌리므로(앞선 테스트의 회사 포함) 이 테스트의 수신자에게 간 메일만 센다
const mailsTo = (mail, addrs) => mail.received.filter((r) => r.method === 'POST' && r.path === '/emails' && addrs.includes(r.body.to[0]));

describe('sb email', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  // 같은 작업 큐(pgmq)를 모든 앱의 워커가 함께 읽으므로, 앞 테스트의 앱이 살아 있으면 뒤 테스트의 작업을 가져가 자기 모의 서버로 보낸다. 테스트마다 앱을 내린다
  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn().catch(() => {});
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('sb-email: daily alert is emailed once per day with unsubscribe link', { skip: skipIfDown, timeout: 240000 }, async () => {
    const a = `e2e-ma-${Date.now()}@example.com`;
    const b = `e2e-mb-${Date.now()}@example.com`;
    const { app, mail, workspaceId, page } = await setup('emal', `${a}, ${b}`);
    assert.equal(await page.locator('#notifyEmails').inputValue(), `${a}, ${b}`, 'saved addresses are shown again');

    const date = '2026-12-14';
    const row = await runDaily(app, mail, date, workspaceId);
    assert.equal(row.status, 'done');
    const sent = mailsTo(mail, [a, b]);
    assert.equal(sent.length, 2, 'one mail per recipient');
    assert.deepEqual(sent.map((r) => r.body.to.join(',')).sort(), [a, b].sort());
    for (const r of sent) {
      assert.equal(r.headers.authorization, 'Bearer mock');
      assert.match(r.body.subject, /^\[입찰 레이더\]/);
      assert.match(r.body.text, /\/unsubscribe\?ws=/);
      assert.ok(r.body.text.includes(encodeURIComponent(r.body.to[0])), 'the link names that recipient');
    }
    const rows = await deliveries(workspaceId);
    assert.deepEqual(rows.filter((r) => r.kind === 'bids:email').map((r) => [r.date, r.status]), [[date, 'sent']]);

    // 같은 날짜를 다시 돌려도 더 보내지 않는다
    await runDaily(app, mail, date, workspaceId);
    assert.equal(mailsTo(mail, [a, b]).length, 2, 'no extra mail for the same date');
    assert.equal((await deliveries(workspaceId)).filter((r) => r.kind === 'bids:email').length, 1);
  });

  it('sb-email: unsubscribe link stops mail for that address', { skip: skipIfDown, timeout: 240000 }, async () => {
    const keep = `e2e-mk-${Date.now()}@example.com`;
    const drop = `e2e-md-${Date.now()}@example.com`;
    const { app, mail, workspaceId } = await setup('emun', `${keep}, ${drop}`);

    await runDaily(app, mail, '2026-12-15', workspaceId);
    const first = mailsTo(mail, [keep, drop]);
    assert.equal(first.length, 2);
    const link = /https?:\/\/\S+\/unsubscribe\?\S+/.exec(first.find((r) => r.body.to[0] === drop).body.text)?.[0];
    assert.ok(link, 'unsubscribe link in the mail');

    // 잘못된 서명은 거부, 맞는 링크는 안내 문구
    const forged = await fetch(link.replace(/&t=[^&\s]+/, '&t=forged'));
    assert.equal(forged.status, 400);
    const ok = await fetch(link);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /더 이상 보내지 않습니다/);

    // 다음 날: 남은 한 명에게만
    await runDaily(app, mail, '2026-12-16', workspaceId);
    const all = mailsTo(mail, [keep, drop]);
    assert.equal(all.length, 3, 'only one more mail');
    assert.deepEqual(all[2].body.to, [keep]);
  });
});
