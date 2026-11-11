import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'award-link');
const NOW = '2026-11-02';
const T_NOTICE = '수원시 가로수 전정 및 보호 공사';
const T_PRESTD = '가로수 전정 및 보호 공사 사전규격';
const LEGEND = '낙찰자는 낙찰이 확정된 업체이고, 개찰 1순위는 개찰 당시 1순위 투찰 업체입니다. 1순위는 적격심사 뒤 바뀔 수 있습니다.';
const DEGRADED = '낙찰 확정 정보를 가져오지 못해 개찰 1순위만 보여 줍니다. 잠시 뒤 다시 찾아 주세요.';

let browser;
const cleanups = [];

const read = (f) => readFileSync(path.join(FIX, f), 'utf8');
const card = (page, title) => page.locator('main li.card').filter({ has: page.locator('.title', { hasText: title }) });

/** 모의 나라장터(본공고 1건·사전규격 1건·개찰결과·낙찰 목록) + 앱 */
async function bootstrap({ awards = true } = {}) {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set('/getBidPblancListInfoCnstwk', (req, q) => ({
    body: q.inqryDiv === '3' || q.pageNo === '2' ? read('list-empty.json') : read('list-p1.json'),
  }));
  mock.set('/prestd/getPublicPrcureThngInfoCnstwk', () => ({ body: read('prestd.json') }));
  mock.set('/scsbid/getOpengResultListInfoCnstwk', () => ({ body: read('openg-result.json') }));
  if (awards) mock.set('/scsbid/getScsbidListSttusCnstwk', () => ({ body: read('scsbid-list.json') }));
  const app = await startApp({
    env: {
      APP_FAKE_NOW: NOW,
      NARA_API_BASE: mock.baseUrl,
      NARA_PRESTD_BASE: `${mock.baseUrl}/prestd`,
      NARA_SCSBID_BASE: `${mock.baseUrl}/scsbid`,
      NARA_API_KEY: 'dummy-key',
      NARA_ROWS: '5',
      NARA_RETRY: '0',
      LLM_API_BASE: '',
      LLM_API_KEY: '',
      LLM_MODEL: 'mock',
    },
  });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
  const { context, page } = await openAs(browser, app.baseUrl, cookie);
  cleanups.push(() => context.close());
  return { app, mock, page };
}

async function saveCriteria(page, baseUrl) {
  await page.goto(`${baseUrl}/settings`);
  await page.fill('#keywords', '조경, 수목, 가로수, 공원');
  await page.fill('#regions', '경기, 서울');
  await page.fill('#budgetMin', '30000000');
  await page.fill('#budgetMax', '500000000');
  await page.fill('#excludeKeywords', '');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했습니다.').waitFor();
}

async function collect(page, baseUrl) {
  await saveCriteria(page, baseUrl);
  const job = await runJob(baseUrl, 'daily', { date: NOW });
  assert.equal(job.status, 200, JSON.stringify(job.body));
}

describe('app award link', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('award: today shows prestd flow on both cards', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap();
    await collect(page, app.baseUrl);
    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const notice = await card(page, T_NOTICE).first().innerText();
    assert.match(notice, /사전규격 있었음 · 의견마감 11\/06\(금\) 18:00/);
    const prestd = card(page, T_PRESTD).first();
    await prestd.waitFor();
    assert.match(await prestd.innerText(), /본공고 나옴 → /);
    assert.ok((await prestd.innerText()).includes(T_NOTICE));
    await shot(page, 'award-today');
  });

  it('award: interest card keeps the flow line', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap();
    await collect(page, app.baseUrl);
    await page.goto(`${app.baseUrl}/today`);
    await card(page, T_NOTICE).first().getByRole('link', { name: '관심', exact: true }).click();
    await page.waitForURL('**/interest/add/**');
    await page.getByRole('button', { name: '관심 공고에 담기' }).click();
    await page.waitForURL('**/interest');
    const c = page.locator('ol.interest li.card').first();
    await c.waitFor();
    assert.match(await c.innerText(), /사전규격 있었음 · 의견마감 11\/06\(금\) 18:00/);
    await shot(page, 'award-interest');
  });

  it('award: history separates winner and top bidder', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap();
    await page.goto(`${app.baseUrl}/history?q=${encodeURIComponent('군')}`);
    await page.locator('table tbody tr').first().waitFor();
    const rows = page.locator('table tbody tr');
    assert.equal(await rows.count(), 3);
    const cells = (await rows.locator('td:nth-child(4)').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    assert.ok(cells.includes('낙찰자 업체A'), JSON.stringify(cells));
    assert.ok(cells.includes('개찰 1순위 업체B'), JSON.stringify(cells));
    assert.ok(cells.includes('개찰 1순위 업체C'), JSON.stringify(cells));
    assert.equal(await page.locator('table .kind-chip.kind-awarded').count(), 1);
    assert.equal(await page.locator('table .kind-chip.kind-top').count(), 2);
    const main = await page.locator('main').innerText();
    assert.ok(main.includes(LEGEND));
    assert.ok(main.includes('공개된 개찰 결과만 보여 줍니다. 낙찰 가능성은 계산하지 않습니다.'));
    assert.ok(!main.includes(DEGRADED));
    await shot(page, 'award-history');
  });

  it('award: history without award list shows top bidders only', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap({ awards: false });
    await page.goto(`${app.baseUrl}/history?q=${encodeURIComponent('군')}`);
    await page.locator('table tbody tr').first().waitFor();
    const main = await page.locator('main').innerText();
    assert.ok(main.includes(DEGRADED));
    assert.equal(await page.locator('table .kind-chip.kind-awarded').count(), 0);
    assert.equal(await page.locator('table .kind-chip.kind-top').count(), 3);
    assert.ok(main.includes(LEGEND));
    await shot(page, 'award-history-degraded');
  });
});
