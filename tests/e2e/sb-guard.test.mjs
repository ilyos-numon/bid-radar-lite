import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { chromium } from 'playwright';
import { startMockTurnstile } from './helpers/mock-guard.mjs';
import {
  SB,
  skipIfDown,
  startSbApp,
  randomEmail,
  signupAndVerify,
  createWorkspace,
  withOrigin,
} from './helpers/supabase.mjs';

// Supabase 모드 남용 방어: 회사별 속도 제한, 본문 크기, 하루 가입 한도, 사람 확인, 스케일 0 에서 잡 처리
const PASSWORD = 'e2e-password-1';
const JOB_TOKEN = 'e2e-job';
const cleanups = [];
let browser;

/** 잡은 날짜마다 한 번만 돈다(공유 DB 에 남는다). 실행마다 겹치지 않는 먼 미래 날짜를 쓴다 */
const uniqueJobDate = () => `${randomInt(3000, 9000)}-${String(randomInt(1, 13)).padStart(2, '0')}-${String(randomInt(1, 29)).padStart(2, '0')}`;

async function startApp(env = {}) {
  const app = await startSbApp({ env: { APP_WORKER: '0', ...env } });
  cleanups.push(() => app.stop());
  return app;
}

async function newCompany(app, tag) {
  const first = await signupAndVerify(app.baseUrl, { email: randomEmail(tag), password: PASSWORD, name: `${tag}대표` });
  const made = await createWorkspace(app.baseUrl, first.cookie, { company: `${tag} 조경`, name: `${tag}대표` });
  return { cookie: made.cookie, workspaceId: made.workspaceId };
}

const post = (app, pathname, fields, cookie = '', extra = {}) => {
  const init = withOrigin(app.baseUrl, { method: 'POST', body: fields instanceof URLSearchParams || typeof fields === 'string' ? fields : new URLSearchParams(fields), redirect: 'manual', ...extra });
  if (cookie) init.headers.set('cookie', cookie);
  return fetch(`${app.baseUrl}${pathname}`, init);
};

const signupFields = (tag) => ({
  email: randomEmail(tag),
  password: PASSWORD,
  name: `${tag}님`,
  agree_terms: '1',
  agree_privacy: '1',
});

describe('sb guard', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('sb-guard: the seventh collect request in an hour is refused with 429 and a wait time', { skip: skipIfDown, timeout: 240000 }, async () => {
    const app = await startApp();
    const company = await newCompany(app, 'gdrt');
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await post(app, '/today/run', {}, company.cookie);
      await res.arrayBuffer();
      statuses.push(res.status);
    }
    assert.ok(statuses.every((s) => s !== 429), `first six are not limited: ${statuses}`);
    const seventh = await post(app, '/today/run', {}, company.cookie);
    assert.equal(seventh.status, 429);
    assert.ok(Number(seventh.headers.get('retry-after')) >= 1, `retry-after ${seventh.headers.get('retry-after')}`);

    // 다른 회사는 영향이 없다
    const other = await newCompany(app, 'gdr2');
    const free = await post(app, '/today/run', {}, other.cookie);
    await free.arrayBuffer();
    assert.notEqual(free.status, 429);
  });

  it('sb-guard: a 300 KiB body is refused with 413', { skip: skipIfDown, timeout: 120000 }, async () => {
    const app = await startApp();
    const big = new URLSearchParams({ email: randomEmail('gdbig'), password: 'x'.repeat(300 * 1024) });
    const res = await post(app, '/login', big);
    assert.equal(res.status, 413);
    assert.ok((await res.text()).includes('보낸 내용이 너무 큽니다'));
    const small = await post(app, '/login', { email: randomEmail('gdsm'), password: 'wrong-password' });
    await small.arrayBuffer();
    assert.notEqual(small.status, 413, 'a normal body is not limited');
  });

  it('sb-guard: with a daily signup limit of 1 the second signup is refused with 429', { skip: skipIfDown, timeout: 120000 }, async () => {
    const app = await startApp({ APP_DAILY_MAX_SIGNUP: '1' });
    const first = await post(app, '/signup', signupFields('gdsa'));
    await first.arrayBuffer();
    assert.equal(first.status, 303, `first signup status ${first.status}`);
    const second = await post(app, '/signup', signupFields('gdsb'));
    assert.equal(second.status, 429);
    assert.ok((await second.text()).includes('오늘 가입 접수를 마감했습니다'));
  });

  it('sb-guard: a failed human check is refused with 400 and a passed one goes on', { skip: skipIfDown, timeout: 120000 }, async () => {
    const verifier = await startMockTurnstile({ success: false });
    cleanups.push(() => verifier.close());
    const app = await startApp({ TURNSTILE_SITE_KEY: 'site-key-mock', TURNSTILE_SECRET_KEY: 'secret-key-mock', TURNSTILE_VERIFY_URL: verifier.verifyUrl });

    const page = await (await browser.newContext()).newPage();
    cleanups.push(() => page.context().close());
    await page.goto(`${app.baseUrl}/signup`);
    assert.equal(await page.locator('.cf-turnstile').count(), 1, 'widget is on the signup form');

    const failed = await post(app, '/signup', { ...signupFields('gdtf'), 'cf-turnstile-response': 'bad-token' });
    assert.equal(failed.status, 400);
    assert.ok((await failed.text()).includes('사람인지 확인하지 못했습니다'));
    assert.equal(verifier.requests.length, 1, 'verifier was asked once');

    const missing = await post(app, '/signup', signupFields('gdtm'));
    assert.equal(missing.status, 400, 'no token is refused');

    verifier.setSuccess(true);
    const passed = await post(app, '/signup', { ...signupFields('gdtp'), 'cf-turnstile-response': 'good-token' });
    await passed.arrayBuffer();
    assert.equal(passed.status, 303);
  });

  it('sb-guard: with the worker off, wait=1 drains the queue inside the request', { skip: skipIfDown, timeout: 240000 }, async () => {
    const app = await startApp();
    const company = await newCompany(app, 'gdwk');
    await (await fetch(`${app.baseUrl}/billing`, { headers: { cookie: company.cookie } })).arrayBuffer();
    const date = uniqueJobDate();
    const res = await fetch(`${app.baseUrl}/api/jobs/daily?all=1&wait=1&date=${date}`, { headers: { 'x-job-token': JOB_TOKEN } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.processed >= 1, `processed ${body.processed}`);
    assert.equal(typeof body.remaining, 'number');

    const noToken = await fetch(`${app.baseUrl}/api/jobs/daily?all=1&wait=1&date=${date}`);
    assert.ok([401, 403].includes(noToken.status), `no token status ${noToken.status}`);
  });
});
