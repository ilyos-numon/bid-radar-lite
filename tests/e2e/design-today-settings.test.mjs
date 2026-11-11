import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';
const T_SOON = '경기도 용인시 수목 관리 용역'; // 마감 2026-11-03
const ERR_BUDGET = '예산 범위가 뒤바뀌었습니다. 최소 예산을 최대 예산보다 작게 적어 주세요.';

let browser;
const cleanups = [];

async function newApp(env = {}) {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  const app = await startApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key', ...env } });
  cleanups.push(() => app.stop());
  return app;
}

async function newPage(baseUrl, cookie) {
  const { context, page } = await openAs(browser, baseUrl, cookie);
  cleanups.push(() => context.close());
  return page;
}

async function saveCriteria(page, baseUrl) {
  await page.goto(`${baseUrl}/settings`);
  await page.fill('#keywords', '조경, 수목, 가로수, 공원');
  await page.fill('#regions', '경기, 서울');
  await page.fill('#budgetMin', '30000000');
  await page.fill('#budgetMax', '500000000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했습니다.').waitFor();
}

describe('design today settings', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('design-today: criteria strip and count heading', { timeout: 120000 }, async () => {
    const app = await newApp();
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);
    await saveCriteria(page, app.baseUrl);
    assert.equal((await runJob(app.baseUrl, 'daily')).status, 200);

    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const strip = page.locator('section.criteria');
    const text = await strip.innerText();
    assert.match(text, /지금 조건/);
    assert.match(text, /조경 · 수목 · 가로수 · 공원/);
    assert.match(text, /경기 · 서울/);
    assert.match(text, /3000만 ~ 5억/);
    assert.equal(await strip.locator('a[href="/settings"]').count(), 1);
    await page.getByRole('heading', { name: /조건에 맞는 공고\s*3건/ }).waitFor();
    assert.equal(await page.locator('main li.card').count(), 3);
    await shot(page, 'design-today-criteria');
  });

  it('design-today: badge kinds and soon chip', { timeout: 120000 }, async () => {
    const app = await newApp({ APP_FAKE_NOW: '2026-11-02' });
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);
    await saveCriteria(page, app.baseUrl);
    assert.equal((await runJob(app.baseUrl, 'daily', { date: '2026-10-29' })).status, 200);

    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const soonCard = page.locator('main li.card', { hasText: T_SOON });
    await soonCard.locator('.dday.soon').waitFor();
    assert.ok((await page.locator('main .dday.soon').count()) >= 1);
    assert.ok((await page.locator('main a.badge.kind-interest').count()) >= 1);

    // 회사 정보 저장 후 판정 뱃지
    await page.goto(`${app.baseUrl}/company`);
    await page.fill('#name', '테스트 조경');
    await page.fill('#licenses', '조경식재공사업');
    await page.fill('#regions', '경기, 서울');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText('저장했습니다.').waitFor();
    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const verdicts = await page.locator('main a.badge.kind-ok, main a.badge.kind-check, main a.badge.kind-no').count();
    assert.ok(verdicts >= 1, `verdict badges: ${verdicts}`);
  });

  it('design-settings: first-visit steps and budget hint', { timeout: 120000 }, async () => {
    const app = await newApp();
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);
    const current = page.locator('section.steps li[aria-current="step"]');

    await page.goto(`${app.baseUrl}/settings?first=1`);
    await current.waitFor();
    assert.match(await current.innerText(), /조건 저장/);

    await page.fill('#keywords', '조경, 수목, 가로수, 공원');
    await page.fill('#regions', '경기, 서울');
    await page.fill('#budgetMin', '30000000');
    await page.fill('#budgetMax', '500000000');
    assert.equal((await page.locator('#budgetMin-hint').innerText()).trim(), '3000만');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText('저장했습니다.').waitFor();
    assert.match(await current.innerText(), /오늘 것 미리보기/);
    assert.equal((await page.locator('#budgetMin-hint').innerText()).trim(), '3000만');
    await shot(page, 'design-settings-first-steps');

    await page.getByRole('button', { name: '오늘 것 미리보기' }).first().click();
    await page.getByText('오늘 알림에 들어갈 공고').waitFor();
    assert.match(await page.locator('section.steps li[aria-current="step"]').innerText(), /오늘의 공고로/);

    // 예산 뒤바뀜
    await page.fill('#budgetMin', '500000000');
    await page.fill('#budgetMax', '30000000');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText(ERR_BUDGET).waitFor();
    assert.equal(await page.locator('#budgetMin').getAttribute('aria-invalid'), 'true');
  });
});
