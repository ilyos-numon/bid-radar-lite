import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { shot } from './helpers/app.mjs';
import {
  SB,
  skipIfDown,
  startSbApp,
  randomEmail,
  latestMailLink,
  signupAndVerify,
  login,
  createWorkspace,
  toPlaywrightCookies,
} from './helpers/supabase.mjs';

// Supabase 모드 스모크: 첫 화면 → 가입 → 가입 확인 메일 → 회사 만들기 화면
const PASSWORD = 'e2e-password-1';
let browser;
const cleanups = [];

describe('sb smoke', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('sb-smoke: landing and signup mail round trip', { skip: skipIfDown, timeout: 120000 }, async () => {
    const app = await startSbApp();
    cleanups.push(() => app.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    cleanups.push(() => context.close());
    const page = await context.newPage();

    await page.goto(`${app.baseUrl}/`);
    assert.equal(await page.locator('h1').innerText(), '입찰 레이더');
    await shot(page, 'sb-landing');

    await page.getByRole('link', { name: '가입하기' }).click();
    await page.waitForURL(`${app.baseUrl}/signup`);
    const email = randomEmail('smoke');
    await page.getByLabel('이메일').fill(email);
    await page.getByLabel('비밀번호').fill(PASSWORD);
    await page.getByLabel('내 이름').fill('스모크');
    await page.locator('input[name=agree_terms]').check();
    await page.locator('input[name=agree_privacy]').check();
    await shot(page, 'sb-signup');
    await page.locator('main form button[type=submit]').click();
    await page.waitForURL(/\/verify-notice\?/);
    assert.match(await page.locator('main').innerText(), /입찰 레이더 가입 확인/);

    // 메일 링크를 같은 브라우저로 연다 (가입 때 받은 확인 쿠키가 있어야 코드 교환이 된다)
    const link = await latestMailLink(email, { subjectIncludes: '가입 확인' });
    await page.goto(link);
    await page.waitForURL(`${app.baseUrl}/workspaces/new`);
    assert.equal(await page.locator('h1').innerText(), '회사 만들기');
    assert.equal(await page.locator('input[name=name]').inputValue(), '스모크', 'signup name is the default');
  });

  it('sb-smoke: zero external requests on landing/signup/login', { skip: skipIfDown, timeout: 120000 }, async () => {
    const app = await startSbApp();
    cleanups.push(() => app.stop());
    const context = await browser.newContext();
    cleanups.push(() => context.close());
    const page = await context.newPage();
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));

    await page.goto(`${app.baseUrl}/`);
    await page.goto(`${app.baseUrl}/signup`);
    await page.goto(`${app.baseUrl}/login`);
    await page.goto(`${app.baseUrl}/reset`);
    // 브라우저로 가입 폼 제출 (확인 메일은 메일 앱에서 열므로 여기서는 열지 않는다)
    await page.goto(`${app.baseUrl}/signup`);
    await page.getByLabel('이메일').fill(randomEmail('nx'));
    await page.getByLabel('비밀번호').fill(PASSWORD);
    await page.getByLabel('내 이름').fill('외부요청');
    await page.locator('input[name=agree_terms]').check();
    await page.locator('input[name=agree_privacy]').check();
    await page.locator('main form button[type=submit]').click();
    await page.waitForURL(/\/verify-notice\?/);

    // 헬퍼 경로: 가입+확인 → 로그인 → 회사 만들기, 그 세션으로 로그인 뒤 화면들
    const email = randomEmail('helper');
    const first = await signupAndVerify(app.baseUrl, { email, password: PASSWORD, name: '헬퍼' });
    assert.equal(first.location, '/workspaces/new');
    const { cookie } = await login(app.baseUrl, { email, password: PASSWORD });
    const made = await createWorkspace(app.baseUrl, cookie, { company: '스모크 조경', name: '헬퍼' });
    assert.match(made.workspaceId, /^[0-9a-f-]{36}$/);
    await context.addCookies(toPlaywrightCookies(app.baseUrl, made.cookie));
    await page.goto(`${app.baseUrl}/login`);
    await page.waitForURL(`${app.baseUrl}/today`);
    await page.goto(`${app.baseUrl}/account`);
    assert.equal(await page.locator('h1').innerText(), '내 계정');
    assert.match(await page.locator('main').innerText(), /스모크 조경/);
    await page.goto(`${app.baseUrl}/me`);

    assert.ok(urls.length >= 8, `visited pages produced requests (${urls.length})`);
    const outside = urls.filter((u) => !u.startsWith(app.baseUrl) && !u.startsWith('data:') && !u.startsWith('about:'));
    assert.deepEqual(outside, [], 'no request leaves the app origin');
  });

  it('sb-smoke: header sign-out button signs out', { skip: skipIfDown, timeout: 120000 }, async () => {
    const app = await startSbApp();
    cleanups.push(() => app.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    cleanups.push(() => context.close());
    const page = await context.newPage();

    const email = randomEmail('signout');
    await signupAndVerify(app.baseUrl, { email, password: PASSWORD, name: '나가기' });
    const { cookie } = await login(app.baseUrl, { email, password: PASSWORD });
    const made = await createWorkspace(app.baseUrl, cookie, { company: '나가기 조경', name: '나가기' });
    await context.addCookies(toPlaywrightCookies(app.baseUrl, made.cookie));
    await page.goto(`${app.baseUrl}/today`);
    await page.waitForURL(`${app.baseUrl}/today`);

    const button = page.locator('header.top form.logout-form button.logout');
    assert.equal(await button.innerText(), '나가기');
    assert.equal(await page.locator('header.top a.logout').count(), 0, 'no GET sign-out link');
    await shot(page, 'sb-header-signout');
    await button.click();
    await page.waitForURL(`${app.baseUrl}/welcome`);

    await page.goto(`${app.baseUrl}/today`);
    await page.waitForURL(`${app.baseUrl}/welcome`);
    assert.equal(new URL(page.url()).pathname, '/welcome', 'signed out: /today sends back to /welcome');
  });
});
