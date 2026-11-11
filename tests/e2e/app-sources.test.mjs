import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';
const FEED_FIXTURE = 'tests/e2e/fixtures/sources/feed.xml';
const HTML_FIXTURE = 'tests/e2e/fixtures/sources/not-xml.html';
const RSS_TITLE = '공원 시설물 보수 공사 입찰공고 (마감 2026-11-20)';

let browser;
const cleanups = [];

async function newMock() {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  mock.set('/feed.xml', { body: readFileSync(FEED_FIXTURE, 'utf8'), contentType: 'application/rss+xml; charset=utf-8' });
  mock.set('/notice.html', { body: readFileSync(HTML_FIXTURE, 'utf8'), contentType: 'text/html; charset=utf-8' });
  return mock;
}

async function newApp(mock) {
  const app = await startApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key' } });
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

async function chooseRss(page, baseUrl) {
  await page.goto(`${baseUrl}/sources`);
  await page.locator('select#type').selectOption({ label: '게시판 (RSS)' });
  await page.getByRole('button', { name: '이 종류로 바꾸기' }).click();
  await page.locator('#cfg-url').waitFor();
}

describe('app sources', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('sources: add rss source fetch now and see bid on today', { timeout: 120000 }, async () => {
    const mock = await newMock();
    const app = await newApp(mock);
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);
    await saveCriteria(page, app.baseUrl);

    await chooseRss(page, app.baseUrl);
    const before = await page.locator('li.source-row').count();
    await page.fill('#cfg-url', `${mock.baseUrl}/feed.xml`);
    await page.fill('#cfg-orgName', '경기도 성남시');
    await page.getByRole('button', { name: '소스 추가', exact: true }).click();
    await page.getByText('소스를 추가했습니다.').waitFor();
    assert.equal(await page.locator('li.source-row').count(), before + 1);
    const row = page.locator('li.source-row', { hasText: '경기도 성남시' });
    await row.getByText('게시판 (RSS)').waitFor();

    await row.getByRole('button', { name: /지금 가져오기/ }).click();
    const rowAfter = page.locator('li.source-row', { hasText: '경기도 성남시' });
    await rowAfter.getByText('방금 · 3건').waitFor();
    assert.equal(await rowAfter.locator('.run-error').count(), 0);
    assert.ok(mock.requests.some((r) => r.path === '/feed.xml'));
    await shot(page, 'sources-list');

    const job = await runJob(app.baseUrl, 'daily');
    assert.equal(job.status, 200);
    await page.goto(`${app.baseUrl}/today`);
    await page.getByText('공원 시설물 보수 공사').first().waitFor();
    const main = await page.locator('main').innerText();
    assert.equal(await page.locator('main li.card', { hasText: '공원 시설물 보수 공사' }).count(), 1, main);
    assert.ok(main.includes(RSS_TITLE));
    assert.ok(main.includes('마감 11/20(금) 00:00'), main);
    assert.ok(main.includes('경기도 성남시'), main);
    assert.ok(!main.includes('사무용품'), main);
    assert.ok(!main.includes('청소 용역'), main);
  });

  it('sources: empty url shows message', { timeout: 60000 }, async () => {
    const mock = await newMock();
    const app = await newApp(mock);
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);

    await chooseRss(page, app.baseUrl);
    const before = await page.locator('li.source-row').count();
    await page.fill('#cfg-orgName', '경기도 성남시');
    await page.getByRole('button', { name: '소스 추가', exact: true }).click();
    await page.getByText('주소를 적어 주세요.').waitFor();
    const alert = await page.locator('[role=alert]').first().innerText();
    assert.match(alert, /추가하지 않았습니다/);
    assert.equal(await page.locator('li.source-row').count(), before);
    assert.equal(await page.inputValue('#cfg-orgName'), '경기도 성남시');
    await shot(page, 'sources-add-error');
  });

  it('sources: non xml feed shows error with next step', { timeout: 60000 }, async () => {
    const mock = await newMock();
    const app = await newApp(mock);
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);

    await chooseRss(page, app.baseUrl);
    await page.fill('#cfg-url', `${mock.baseUrl}/notice.html`);
    await page.fill('#cfg-orgName', '경기도 성남시');
    await page.getByRole('button', { name: '소스 추가', exact: true }).click();
    await page.getByText('소스를 추가했습니다.').waitFor();

    const row = page.locator('li.source-row', { hasText: '경기도 성남시' });
    await row.getByRole('button', { name: /지금 가져오기/ }).click();
    const rowAfter = page.locator('li.source-row', { hasText: '경기도 성남시' });
    await rowAfter.getByText('방금 · 가져오지 못함').waitFor();
    const text = await rowAfter.innerText();
    assert.ok(text.includes('피드를 읽지 못했습니다 (XML 아님)'), text);
    assert.match(text, /주소|다시|확인/, `no next step: ${text}`);
    assert.doesNotMatch(text, /SOURCE_ERROR|ECONN|TypeError|\bat \S+\.mjs|stack/i);
    assert.equal(await page.locator('[role=alert]').count(), 0);
    await shot(page, 'sources-fetch-error');
  });
});
