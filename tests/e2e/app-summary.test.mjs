import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot } from './helpers/app.mjs';
import { startMockHttp, startMockLlm } from './helpers/mock-ext.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'summary');
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const READY_ID = '20261029001-000';
const UNVERIFIED_ID = '20261029002-000';
const NOTEXT_ID = '20261029007-000';

const MSG_UNVERIFIED = '근거를 원문에서 찾지 못했습니다. 원문을 직접 확인해 주세요.';
const MSG_NOTEXT = '공고문 첨부를 읽지 못했습니다';

let browser;
const cleanups = [];

async function setup({ llm = true } = {}) {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(path.join(FIX, 'nara-with-attachments.json'), 'utf8').replaceAll('{{MOCK}}', mock.baseUrl) });
  for (const f of ['attach-ready.txt', 'attach-unverified.txt']) {
    mock.set(`/files/${f}`, { body: readFileSync(path.join(FIX, f), 'utf8'), contentType: 'text/plain; charset=utf-8' });
  }
  const mockLlm = await startMockLlm({ fixtureDir: FIX });
  cleanups.push(() => mockLlm.close());
  const app = await startApp({
    env: {
      NARA_API_BASE: mock.baseUrl,
      NARA_API_KEY: 'dummy-key',
      LLM_API_BASE: llm ? `${mockLlm.baseUrl}/v1` : '',
      LLM_API_KEY: llm ? 'e2e' : '',
      LLM_MODEL: 'mock',
    },
  });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
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
  return { app, mock, mockLlm, page };
}

describe('app summary', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('summary: ready summary with evidence', { timeout: 120000 }, async () => {
    const { app, page } = await setup();
    await page.goto(`${app.baseUrl}/summary`);
    await page.locator('ol.summaries li.card').first().waitFor();
    const list = await page.locator('main').innerText();
    assert.ok(list.includes('경기도 수원시 가로수 전정 및 보호 사업'));
    assert.ok(list.includes('관내 가로수 1,200주의 전정과 병해충 방제 용역입니다.'));
    await shot(page, 'summary-list');

    await page.goto(`${app.baseUrl}/summary/${READY_ID}`);
    await page.locator('dl.summary-lines').waitFor();
    const dl = await page.locator('dl.summary-lines').innerText();
    for (const t of ['무슨 사업인지', '필요한 자격', '제출 서류', '조경식재공사업 면허를 보유한 경기도 업체여야 합니다.']) {
      assert.ok(dl.includes(t), `missing ${t}`);
    }
    await page.locator('details.evidence summary').click();
    const ev = await page.locator('details.evidence').innerText();
    assert.ok(ev.includes('근거 보기'));
    assert.ok(ev.includes('가로수 1,200주의 전정과 병해충 방제를 수행하는 용역'));
    assert.ok(ev.includes('최근 3년 시공 실적 증명서를 제출'));
    assert.equal(await page.getByText(MSG_UNVERIFIED).count(), 0);
    await shot(page, 'summary-detail-ready');

    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const badge = page.getByRole('link', { name: '요약 보기' }).first();
    await badge.waitFor();
    assert.ok((await badge.getAttribute('href')).endsWith(`/summary/${READY_ID}`));
  });

  it('summary: quote not in text is marked unverified', { timeout: 120000 }, async () => {
    const { app, page } = await setup();
    await page.goto(`${app.baseUrl}/summary/${UNVERIFIED_ID}`);
    await page.getByText(MSG_UNVERIFIED).waitFor();
    const main = await page.locator('main').innerText();
    assert.ok(main.includes('마포구 어린이공원 두 곳의 놀이시설을 교체합니다.'), 'summary still shown');
    assert.ok(main.indexOf(MSG_UNVERIFIED) < main.indexOf('무슨 사업인지'), 'notice above lines');
    await shot(page, 'summary-detail-unverified');

    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const badge = page.getByRole('link', { name: '요약 확인 필요' });
    await badge.first().waitFor();
    assert.ok((await badge.first().getAttribute('href')).endsWith(`/summary/${UNVERIFIED_ID}`));
  });

  it('summary: no attachment text', { timeout: 120000 }, async () => {
    const { app, page, mockLlm } = await setup();
    await page.goto(`${app.baseUrl}/summary/${NOTEXT_ID}`);
    await page.getByText(MSG_NOTEXT).waitFor();
    const main = await page.locator('main').innerText();
    assert.ok(main.includes('원문 보기에서 직접 확인해 주세요'));
    assert.ok((await page.getByRole('link', { name: '원문 보기' }).count()) >= 1, 'original link');
    assert.equal(mockLlm.calls.filter((c) => c.bidId === NOTEXT_ID).length, 0);
    await shot(page, 'summary-detail-notext');
  });

  it('summary: no key shows not ready', { timeout: 120000 }, async () => {
    const { app, page } = await setup({ llm: false });
    await page.goto(`${app.baseUrl}/summary/${READY_ID}`);
    await page.getByText('자동 요약이 아직 준비되지 않았습니다').first().waitFor();
    const main = await page.locator('main').innerText();
    assert.ok(main.replace(/\s+/g, ' ').includes('자동 요약이 아직 준비되지 않았습니다'));
    assert.ok(main.replace(/\s+/g, ' ').includes('원문 보기로 확인하세요'));
    assert.doesNotMatch(main, /NO_KEY|ERROR|Error|\bat \S+\.mjs/);
    await shot(page, 'summary-detail-failed');
  });
});
