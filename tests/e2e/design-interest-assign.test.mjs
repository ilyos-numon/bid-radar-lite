import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';
const G_TITLE = '경기도 용인시 수목 관리 용역'; // 마감 2026-11-03

let browser;
const cleanups = [];

async function newApp({ fakeNow } = {}) {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  const env = { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key' };
  if (fakeNow) env.APP_FAKE_NOW = fakeNow;
  const app = await startApp({ env });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
  return { app, cookie };
}

async function newPage(baseUrl, cookie) {
  const { context, page } = await openAs(browser, baseUrl, cookie);
  cleanups.push(() => context.close());
  return page;
}

async function addViaPost(baseUrl, cookie, href) {
  const res = await fetch(`${baseUrl}${href}`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal(res.status, 303, `add ${href}`);
}

/** /today 카드 n 개의 관심 담기 링크 */
async function interestHrefs(page, baseUrl, count) {
  await page.goto(`${baseUrl}/today`);
  await page.waitForSelector('ol.bids li.card');
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(await page.locator('ol.bids li.card').nth(i).getByRole('link', { name: '관심', exact: true }).getAttribute('href'));
  }
  return out;
}

describe('design interest assign', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('design-interest: note, count, progress', { timeout: 120000 }, async () => {
    const { app, cookie } = await newApp();
    assert.equal((await runJob(app.baseUrl, 'daily')).status, 200);
    const page = await newPage(app.baseUrl, cookie);
    const [href] = await interestHrefs(page, app.baseUrl, 1);
    await addViaPost(app.baseUrl, cookie, href);

    await page.goto(`${app.baseUrl}/interest`);
    await page.waitForSelector('ol.interest li.card');
    const main = page.locator('main');
    const text = await main.innerText();
    assert.ok(text.includes('마감 7일 · 3일 · 1일 전에 다시 알려 드립니다'), text);
    assert.ok(text.includes('마감이 가까운 순 · 1건'), text);
    assert.ok(text.includes('0 / 5 확인'), text);

    const card = page.locator('ol.interest li.card');
    for (const n of ['1', '2']) {
      await card.locator(`button.check[data-item="${n}"]`).click();
      await page.waitForURL('**/interest');
      await page.waitForSelector(`button.check[data-item="${n}"][aria-pressed=true]`);
    }
    const after = page.locator('ol.interest li.card');
    assert.equal(await after.locator('button.check[aria-pressed=true]').count(), 2);
    const t2 = await after.innerText();
    assert.ok(t2.includes('2 / 5 확인'), t2);
    assert.equal(t2.split('확인함').length - 1, 2);
    assert.equal(t2.split('확인 전').length - 1, 0);
    await shot(page, 'design-interest-progress');
  });

  it('design-interest: soon card and assignee badge', { timeout: 120000 }, async () => {
    const { app, cookie } = await newApp({ fakeNow: '2026-11-02' });
    assert.equal((await runJob(app.baseUrl, 'daily', { date: '2026-11-02' })).status, 200);
    const page = await newPage(app.baseUrl, cookie);

    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const todayCard = page.locator('li.card', { hasText: G_TITLE }).first();
    const href = await todayCard.getByRole('link', { name: '관심', exact: true }).getAttribute('href');
    const assignHref = await todayCard.locator('a[href^="/assign/"]').first().getAttribute('href');
    await addViaPost(app.baseUrl, cookie, href);

    await page.goto(`${app.baseUrl}/interest`);
    const card = page.locator('ol.interest li.card');
    await card.first().waitFor();
    assert.equal(await card.count(), 1);
    assert.equal(await card.locator('.dday.soon').count(), 1);
    assert.ok((await card.innerText()).includes('마감 임박'));

    // 담당 저장 → 관심 카드에 담당 뱃지
    await page.goto(`${app.baseUrl}${assignHref}`);
    await page.selectOption('select[name=assignee]', { index: 0 });
    await page.selectOption('select[name=status]', { label: '검토중' });
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.waitForURL('**/assign');

    await page.goto(`${app.baseUrl}/interest`);
    const badge = page.locator('ol.interest li.card a.badge.kind-assign-set');
    await badge.first().waitFor();
    assert.equal(await badge.count(), 1);
    assert.ok((await badge.innerText()).trim().startsWith('담당 '));
    assert.match(await badge.getAttribute('href'), /^\/assign\//);
  });

  it('design-assign: members, columns, deadline, footer', { timeout: 120000 }, async () => {
    const { app, cookie } = await newApp();
    assert.equal((await runJob(app.baseUrl, 'daily')).status, 200);
    const page = await newPage(app.baseUrl, cookie);
    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const assignHrefs = [];
    for (let i = 0; i < 2; i++) {
      assignHrefs.push(await page.locator('ol.bids li.card a[href^="/assign/"]').nth(i).getAttribute('href'));
    }
    for (const h of assignHrefs) {
      await page.goto(`${app.baseUrl}${h}`);
      await page.selectOption('select[name=assignee]', { index: 0 });
      await page.selectOption('select[name=status]', { label: '검토중' });
      await page.getByRole('button', { name: '저장', exact: true }).click();
      await page.waitForURL('**/assign');
    }

    await page.goto(`${app.baseUrl}/assign`);
    const main = page.locator('main');
    await main.locator('.board').waitFor();
    assert.ok((await main.innerText()).includes('구성원 1명'));
    assert.ok((await page.locator('.avatars .avatar').count()) >= 1);

    const cols = page.locator('.board section');
    assert.equal(await cols.count(), 3);
    for (let i = 0; i < 3; i++) assert.equal(await cols.nth(i).locator('.count').count(), 1);
    const review = page.locator('section', { has: page.getByRole('heading', { name: '검토중' }) });
    const go = page.locator('section', { has: page.getByRole('heading', { name: '참여' }) });
    assert.equal((await review.locator('.count').innerText()).trim(), '2');
    assert.equal((await go.locator('.count').innerText()).trim(), '0');
    assert.ok((await go.innerText()).includes('이 상태의 공고가 없습니다.'));
    assert.equal(await review.locator('li.card .dday').count(), 2);

    const link = main.getByRole('link', { name: '오늘의 공고에서 담당자 정하기' });
    assert.equal(await link.count(), 1);
    assert.equal(await link.getAttribute('href'), '/today');
    await shot(page, 'design-assign-board');
  });
});
