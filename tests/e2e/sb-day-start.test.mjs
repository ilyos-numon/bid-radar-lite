import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import { shot } from './helpers/app.mjs';
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
  adminDbUrl,
  withPg,
} from './helpers/supabase.mjs';
import { rateKey } from '../../app/core/rate-store.mjs';

// Supabase 모드 + 예약 실행 없음: 하루 첫 방문 수집, 중복 방지, 데모 로그인 초기화, 무료 가져오기 5회, 안내 툴팁
const PASSWORD = 'e2e-password-1';
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const NARA_KEY = 'e2e-nara-key-7f3a';
const FAKE_DAY = '2026-10-29';
const DOMAIN = `daystart-${randomBytes(3).toString('hex')}.example.com`;
const OWNER_EMAIL = `demo-owner@${DOMAIN}`;
const TIP = '예약 실행을 꺼 두었습니다';
const opts = { skip: skipIfDown, timeout: 240000 };

let browser;
const cleanups = [];

async function newMock() {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync('tests/fixtures/nara-bids.json', 'utf8') });
  return mock;
}

const OFF_ENV = (mock, extra = {}) => ({ APP_SCHEDULER_OFF: '1', APP_DEMO: '1', APP_WORKER: '0', NARA_API_BASE: mock.baseUrl, ...extra });

async function startOff(mock, extra) {
  const app = await startSbApp({ env: OFF_ENV(mock, extra) });
  cleanups.push(() => app.stop());
  return app;
}

/** 가입·회사 만들기·나라장터 키 저장은 예약 없음 모드가 아닌 앱으로 한다(가입 요청이 하루 첫 방문 수집을 먼저 써 버리지 않게) */
async function companyWithKey(mock, tag, { support = false } = {}) {
  const plain = await startSbApp({ env: { APP_WORKER: '0', NARA_API_BASE: mock.baseUrl } });
  try {
    const { cookie } = await signupAndVerify(plain.baseUrl, { email: randomEmail(tag), password: PASSWORD, name: `대표${tag}` });
    const ws = await createWorkspace(plain.baseUrl, cookie, { company: `첫방문 ${tag} 조경`, name: `대표${tag}` });
    const saved = await fetch(
      `${plain.baseUrl}/connections/nara`,
      withOrigin(plain.baseUrl, { method: 'POST', body: new URLSearchParams({ NARA_API_KEY: NARA_KEY }), headers: { cookie: ws.cookie }, redirect: 'manual' }),
    );
    await saved.arrayBuffer();
    assert.equal(saved.status, 303, 'key saved');
    if (support) {
      const sup = await fetch(
        `${plain.baseUrl}/connections/support`,
        withOrigin(plain.baseUrl, {
          method: 'POST',
          body: new URLSearchParams({ SUPPORT_API_KEY: 'e2e-support-key', SUPPORT_API_BASE: mock.baseUrl }),
          headers: { cookie: ws.cookie },
          redirect: 'manual',
        }),
      );
      await sup.arrayBuffer();
      assert.equal(sup.status, 303, 'support key saved');
    }
    return ws;
  } finally {
    await plain.stop();
  }
}

async function pageFor(app, cookie, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  cleanups.push(() => context.close());
  await context.addCookies(toPlaywrightCookies(app.baseUrl, cookie));
  return context.newPage();
}

const sql = (text, params = []) => withPg(adminDbUrl(), async (c) => (await c.query(text, params)).rows);

async function pollStatus(app, ok, ms = 90000) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await (await fetch(`${app.baseUrl}/status.json`)).json();
    if (ok(last)) return last;
    await new Promise((r) => setTimeout(r, 1000));
  }
  assert.fail(`status.json did not reach the expected state: ${JSON.stringify(last)}`);
}

async function purgeDemo() {
  const rows = await withPg(adminDbUrl(), async (c) => {
    const found = (await c.query('SELECT workspace_id, owner_user_id, staff_user_ids FROM public.demo_workspaces')).rows;
    await c.query('DELETE FROM public.demo_workspaces');
    for (const r of found) await c.query('DELETE FROM public.workspaces WHERE id = $1', [r.workspace_id]);
    return found;
  });
  const admin = createClient(SB.url, SB.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ids = new Set();
  for (const r of rows) for (const id of [r.owner_user_id, ...(r.staff_user_ids ?? [])]) ids.add(id);
  for (const id of ids) await admin.auth.admin.deleteUser(id);
}

const runToday = (app, cookie) =>
  fetch(`${app.baseUrl}/today/run`, withOrigin(app.baseUrl, { method: 'POST', headers: { cookie }, redirect: 'manual' }));

const used = async (ws) => {
  const rows = await sql('SELECT used FROM public.collect_credits WHERE workspace_id = $1', [ws]);
  return rows[0] ? Number(rows[0].used) : 0;
};

/** 첫 방문 한 번을 일으키고 수집이 끝날 때까지 기다린다 */
async function firstVisitDone(app) {
  const res = await fetch(`${app.baseUrl}/welcome`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();
  return pollStatus(app, (s) => s.collect?.state === 'done' && s.bids >= 1);
}

describe('sb day start', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
    if (SB.up) await purgeDemo().catch(() => process.stderr.write('warning: e2e day-start demo cleanup failed\n'));
  });

  it('sb-day-start: first visit of the day kicks collection and /status.json shows today and bids', opts, async () => {
    const mock = await newMock();
    await companyWithKey(mock, 'fv');
    const app = await startOff(mock);

    const res = await fetch(`${app.baseUrl}/welcome`);
    assert.equal(res.status, 200);
    await res.arrayBuffer();
    const s = await pollStatus(app, (j) => j.collect?.state === 'done' && j.bids >= 1, 60000);
    assert.equal(s.date, FAKE_DAY);
    assert.ok(s.bids >= 1, `bids ${s.bids}`);
    assert.equal(s.collect.state, 'done');
    assert.equal(s.collect.trigger, 'first-visit');
    assert.ok(mock.requests.some((r) => r.path === NARA_PATH), 'mock nara was called by the first visit');

    const page = await pageFor(app, '', { width: 1000, height: 700 });
    await page.goto(`${app.baseUrl}/status`);
    await page.getByText('서비스 현황').first().waitFor();
    await shot(page, 'status-first-visit');
  });

  it('sb-day-start: later requests do not run collection again', opts, async () => {
    const mock = await newMock();
    const ws = await companyWithKey(mock, 'again');
    const app = await startOff(mock);
    await firstVisitDone(app);
    const attempt = async () => Number((await sql("SELECT attempt FROM public.job_runs WHERE workspace_id = $1 AND job = 'daily' AND date = $2", [ws.workspaceId, FAKE_DAY]))[0]?.attempt);
    assert.equal(await attempt(), 1, 'collected once');

    for (let i = 0; i < 5; i += 1) await (await fetch(`${app.baseUrl}/welcome`)).arrayBuffer();
    assert.equal(await attempt(), 1, 'attempt stays 1');
    const rows = await sql('SELECT hits FROM public.rate_limits WHERE key = $1', [rateKey(`daystart:collect:${FAKE_DAY}`)]);
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].hits), 2, 'day start row is marked done');
  });

  it('sb-day-start: demo login resets the example company when not reset today', opts, async () => {
    await purgeDemo();
    const mock = await newMock();
    // 앱의 오늘을 실제 오늘로 맞춘다(초기화 시각이 앱 시계로 기록되므로)
    const realToday = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const app = await startOff(mock, { APP_DEMO_EMAIL_DOMAIN: DOMAIN, APP_PLATFORM_ADMIN_EMAILS: OWNER_EMAIL, APP_FAKE_NOW: realToday });
    const login = async () => {
      const res = await fetch(`${app.baseUrl}/demo/login`, withOrigin(app.baseUrl, { method: 'POST', redirect: 'manual' }));
      await res.arrayBuffer();
      return res;
    };
    const row = async () => (await sql('SELECT seeded_at, reset_count FROM public.demo_workspaces LIMIT 1'))[0];
    const kst = (d) => new Date(new Date(d).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    const first = await login();
    assert.equal(first.status, 303);
    const a = await row();
    assert.ok(a, 'example company exists after the first login');
    assert.equal(kst(a.seeded_at), kst(new Date()), 'seeded today (KST)');

    const second = await login();
    assert.equal(second.status, 303);
    const b = await row();
    assert.equal(Number(b.reset_count), Number(a.reset_count), 'second login does not reset again');
  });

  it('sb-day-start: a company gets five free collects and then a plan notice', opts, async () => {
    const mock = await newMock();
    const ws = await companyWithKey(mock, 'free');
    const app = await startOff(mock, { APP_FREE_COLLECTS: '5' });
    const page = await pageFor(app, ws.cookie);

    const first = await runToday(app, ws.cookie);
    await first.arrayBuffer();
    assert.equal(first.status, 303, 'a counted run redirects back to /today');
    assert.equal(await used(ws.workspaceId), 1);
    await page.goto(`${app.baseUrl}/today`);
    assert.ok((await page.locator('.chip.credits').innerText()).includes('무료 가져오기 4회 남음'));
    await shot(page, 'today-credits-left');

    for (let i = 2; i <= 5; i += 1) {
      const r = await runToday(app, ws.cookie);
      await r.arrayBuffer();
      assert.equal(r.status, 303, `run ${i}`);
    }
    assert.equal(await used(ws.workspaceId), 5);

    const sixth = await runToday(app, ws.cookie);
    const body = await sixth.text();
    assert.equal(sixth.status, 200);
    assert.ok(body.includes('모두 썼습니다'), 'notice text');
    assert.ok(body.includes('href="/billing"'), 'plan link');
    assert.equal(await used(ws.workspaceId), 5, 'used stays at the limit');

    await page.goto(`${app.baseUrl}/today`);
    assert.ok((await page.locator('.chip.credits.none').innerText()).includes('모두 썼습니다'));
    assert.equal(await page.locator('main button[disabled]').count() >= 1, true, 'run button is disabled');
    await shot(page, 'today-credits-none');
  });

  it('sb-day-start: a paid subscription is not limited', opts, async () => {
    const mock = await newMock();
    const ws = await companyWithKey(mock, 'paid');
    const app = await startOff(mock, { APP_FREE_COLLECTS: '5' });

    const first = await runToday(app, ws.cookie);
    await first.arrayBuffer();
    assert.equal(first.status, 303);
    assert.equal(await used(ws.workspaceId), 1);
    const updated = await sql("UPDATE public.subscriptions SET status = 'active' WHERE workspace_id = $1 RETURNING 1", [ws.workspaceId]);
    assert.equal(updated.length, 1, 'subscription row exists');

    const again = await runToday(app, ws.cookie);
    await again.arrayBuffer();
    assert.equal(again.status, 303, 'a paid company still redirects normally');
    assert.equal(await used(ws.workspaceId), 1, 'used does not change for a paid company');
    const page = await pageFor(app, ws.cookie);
    await page.goto(`${app.baseUrl}/today`);
    assert.ok(!(await page.locator('body').innerText()).includes('무료 가져오기'), 'no free collect chip');
  });

  it('sb-day-start: scheduler-off tips are visible on settings, support and billing', opts, async () => {
    const mock = await newMock();
    const ws = await companyWithKey(mock, 'tip', { support: true });
    const app = await startOff(mock);
    const page = await pageFor(app, ws.cookie, { width: 1100, height: 900 });

    // 결제 화면의 툴팁 문구는 자동 결제 안내(계약 4.5 autoChargeOff)다
    const screens = [['/settings', 'settings-tip', TIP], ['/support', 'support-tip', TIP], ['/billing', 'billing-tip', '자동 결제가 꺼져 있습니다']];
    for (const [pathname, name, text] of screens) {
      await page.goto(`${app.baseUrl}${pathname}`);
      const tip = page.locator(`main .tip[data-tip*="${text}"]`);
      assert.equal(await tip.count(), 1, `${pathname} has one tip`);
      await tip.focus();
      const content = await tip.evaluate((el) => getComputedStyle(el, '::after').content);
      assert.ok(content && content !== 'none' && content.includes(text), `${pathname} tooltip text shows on focus`);
      await shot(page, name);
    }
  });
});
