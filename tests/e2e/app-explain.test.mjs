import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

// 기존(단일 회사) 모드: 오늘 카드의 "왜 추천됐나" 와 공개 서비스 현황
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const NARA_FIXTURE = 'tests/fixtures/nara-bids.json';

let browser;
const cleanups = [];

async function newApp() {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  const app = await startApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key' } });
  cleanups.push(() => app.stop());
  return app;
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

describe('app explain', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('explain: each today card has a reasons block with checks that are not all met', { timeout: 120000 }, async () => {
    const app = await newApp();
    const { cookie } = await setupOwner(app.baseUrl);
    const { context, page } = await openAs(browser, app.baseUrl, cookie);
    cleanups.push(() => context.close());
    await saveCriteria(page, app.baseUrl);

    await page.goto(`${app.baseUrl}/today`);
    await page.getByRole('button', { name: '오늘 공고 가져오기' }).click();
    await page.waitForSelector('ol.bids li.card');
    const cards = await page.locator('main li.card').count();
    assert.equal(cards, 3);
    assert.equal(await page.locator('details.explain').count(), cards, 'every card has the block');
    assert.equal(await page.locator('.chip.example').count(), 0, 'no example chip outside the demo');
    assert.equal(await page.locator('.banner.demo').count(), 0, 'no demo banner outside the demo');

    const summaries = await page.locator('details.explain > summary').allInnerTexts();
    for (const s of summaries) assert.match(s, /^왜 추천됐나 · \d\/4 조건 맞음$/);

    // 펼치면 네 가지 확인이 보인다
    await page.locator('details.explain > summary').first().click();
    const texts = await page.locator('details.explain[open] li').allInnerTexts();
    assert.equal(texts.length, 4, texts.join(' | '));
    const all = (await page.locator('details.explain').allInnerTexts()).join('\n');
    assert.match(all, /안 맞음|정보 없음/, 'at least one check is not met or unknown');
    assert.match(all, /맞음/);
  });

  it('explain: /status answers 200 with real figures (example false)', { timeout: 120000 }, async () => {
    const app = await newApp();
    await setupOwner(app.baseUrl);
    const res = await fetch(`${app.baseUrl}/status.json`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.example, false);
    assert.equal(typeof j.bids, 'number');
    assert.ok(['ok', 'degraded'].includes(j.status));

    const page = await fetch(`${app.baseUrl}/status`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('서비스 현황'));
    assert.ok(!html.includes('예시 수치'), 'no example label');
  });
});
