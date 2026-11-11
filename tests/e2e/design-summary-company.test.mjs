import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot } from './helpers/app.mjs';
import { startMockHttp, startMockLlm } from './helpers/mock-ext.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUM_FIX = path.join(HERE, 'fixtures', 'summary');
const CO_FIX = path.join(HERE, 'fixtures', 'company');
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const READY_ID = '20261029001-000';
const READY_TITLE = '경기도 수원시 가로수 전정 및 보호 사업';

let browser;
const cleanups = [];

async function boot({ fixDir, naraFile, token, attaches }) {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(path.join(fixDir, naraFile), 'utf8').replaceAll(token, mock.baseUrl) });
  for (const f of attaches) {
    mock.set(`/files/${f}`, { body: readFileSync(path.join(fixDir, f), 'utf8'), contentType: 'text/plain; charset=utf-8' });
  }
  const llm = await startMockLlm({ fixtureDir: fixDir });
  cleanups.push(() => llm.close());
  const app = await startApp({
    env: {
      NARA_API_BASE: mock.baseUrl,
      NARA_API_KEY: 'dummy-key',
      LLM_API_BASE: `${llm.baseUrl}/v1`,
      LLM_API_KEY: 'e2e',
      LLM_MODEL: 'mock',
    },
  });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
  return { app, cookie };
}

describe('design summary and company', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('design-summary: breadcrumb, heading, ready box, evidence count', { timeout: 120000 }, async () => {
    const { app, cookie } = await boot({
      fixDir: SUM_FIX,
      naraFile: 'nara-with-attachments.json',
      token: '{{MOCK}}',
      attaches: ['attach-ready.txt', 'attach-unverified.txt'],
    });
    const save = await fetch(`${app.baseUrl}/settings`, {
      method: 'POST',
      headers: { cookie },
      body: new URLSearchParams({ keywords: '조경, 수목, 가로수, 공원', regions: '경기, 서울', budgetMin: '30000000', budgetMax: '500000000' }),
      redirect: 'manual',
    });
    assert.ok(save.status === 303 || save.status === 200, `settings save status ${save.status}`);
    const job = await runJob(app.baseUrl, 'daily');
    assert.equal(job.status, 200, `daily job: ${JSON.stringify(job.body)}`);
    const { context, page } = await openAs(browser, app.baseUrl, cookie);
    cleanups.push(() => context.close());

    await page.goto(`${app.baseUrl}/summary/${READY_ID}`);
    await page.locator('dl.summary-lines').waitFor();

    const crumb = page.locator('p.breadcrumb a');
    assert.equal(await crumb.count(), 1);
    assert.equal(await crumb.getAttribute('href'), '/summary');
    assert.match(await crumb.innerText(), /요약 목록으로/);

    assert.equal((await page.locator('.page-head p.eyebrow').innerText()).trim(), '공고 요약');
    assert.equal((await page.locator('h1').innerText()).trim(), READY_TITLE);

    const status = page.locator('[role=status]').first();
    assert.equal((await status.innerText()).replace(/\s+/g, ' ').trim(), '요약 있음 · 세 줄 모두 공고문에서 근거를 찾았습니다.');

    const summaryText = (await page.locator('details.evidence summary').innerText()).replace(/\s+/g, ' ');
    const m = summaryText.match(/근거 보기 · 원문 인용 (\d+)개/);
    assert.ok(m, `evidence summary text: ${summaryText}`);
    assert.ok(Number(m[1]) >= 1, `N=${m[1]}`);

    assert.equal(await page.locator('details.evidence[open]').count(), 0);
    await page.locator('details.evidence summary').click();
    assert.equal(await page.locator('details.evidence[open]').count(), 1);
    assert.ok((await page.locator('details.evidence blockquote').count()) >= 1);
    await shot(page, 'design-summary-ready');
  });

  it('design-company: tiles and verdict chips', { timeout: 120000 }, async () => {
    const { app, cookie } = await boot({
      fixDir: CO_FIX,
      naraFile: 'nara-with-requirements.json',
      token: '__MOCK__',
      attaches: ['attach-ok.txt', 'attach-lack.txt', 'attach-region.txt'],
    });
    const { context, page } = await openAs(browser, app.baseUrl, cookie);
    cleanups.push(() => context.close());
    await page.goto(`${app.baseUrl}/settings`);
    await page.fill('#keywords', '조경, 수목, 가로수, 공원');
    await page.fill('#regions', '경기, 서울');
    await page.fill('#budgetMin', '30000000');
    await page.fill('#budgetMax', '500000000');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText('저장했습니다.').waitFor();
    await page.goto(`${app.baseUrl}/today`);
    await page.getByRole('button', { name: '오늘 공고 가져오기' }).click();
    await page.waitForSelector('ol.bids li.card');

    await page.goto(`${app.baseUrl}/company`);
    await page.fill('#name', '테스트 조경');
    await page.fill('#licenses', '조경식재공사업, 조경시설물설치공사업');
    await page.fill('#regions', '경기, 서울');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText('저장했습니다.').waitFor();

    const tiles = page.locator('#profile dl dt');
    assert.equal(await tiles.count(), 4);
    const labels = (await tiles.allInnerTexts()).map((s) => s.trim());
    assert.deepEqual(labels, ['회사 이름', '보유 면허', '지역', '중소기업']);

    const cards = page.locator('main ol li.card');
    await cards.first().waitFor();
    const n = await cards.count();
    assert.ok(n >= 1);
    for (let i = 0; i < n; i++) {
      const chips = cards.nth(i).locator('span.badge');
      assert.equal(await chips.count(), 1, `card ${i} chip count`);
      const cls = await chips.first().getAttribute('class');
      assert.equal(cls.split(/\s+/).filter((c) => ['kind-ok', 'kind-check', 'kind-no'].includes(c)).length, 1, `card ${i} class: ${cls}`);
    }
    assert.ok((await page.locator('.notice.info').filter({ hasText: '자동 판정이라 틀릴 수 있습니다' }).count()) >= 1);
    await shot(page, 'design-company-verdicts');
  });
});
