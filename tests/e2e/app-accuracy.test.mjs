import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot } from './helpers/app.mjs';
import { startMockHttp, startMockLlm } from './helpers/mock-ext.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures', 'accuracy');
const DOCS = path.join(HERE, '..', 'fixtures', 'docs');
const NARA = path.join(HERE, '..', 'fixtures', 'nara');
const NOW = '2026-11-02';

const T_GARO = '수원시 가로수 전정 및 보호 공사'; // 001: hwpx 첨부, 면허·지역 제한이 맞음
const T_YONGIN = '용인시 조경 시설물 정비공사'; // 004: 참가가능지역 부산광역시
const T_GRAVE = '종로구 공원묘지 정비공사'; // 005: 제외 키워드 대상
const T_BROKEN = '고양시 공원 녹지 관리공사'; // 006: 손상 hwp 첨부
const ID_GARO = '20261102001-000';
const ID_BROKEN = '20261102006-000';

let browser;
const cleanups = [];

const read = (f) => readFileSync(path.join(FIX, f), 'utf8');
const card = (page, title) => page.locator('main li.card', { hasText: title });

/** 모의 나라장터(페이지·inqryDiv·보조·사전규격·개찰결과) + 첨부 서빙 + 모의 LLM + 앱 */
async function bootstrap({ quota = false, llm = false } = {}) {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  const list = (req, q) => {
    if (quota) return { body: readFileSync(path.join(NARA, 'error-22.json'), 'utf8') };
    if (q.inqryDiv === '3') return { body: read('list-changed.json').replaceAll('{{MOCK}}', mock.baseUrl) };
    return { body: read(q.pageNo === '2' ? 'list-p2.json' : 'list-p1.json').replaceAll('{{MOCK}}', mock.baseUrl) };
  };
  mock.set('/getBidPblancListInfoCnstwk', list);
  mock.set('/getBidPblancListInfoLicenseLimit', () => ({ body: read('license-limit.json') }));
  mock.set('/getBidPblancListInfoPrtcptPsblRgn', () => ({ body: read('region-limit.json') }));
  mock.set('/getBidPblancListInfoCnstwkBsisAmount', () => ({ body: read('base-amount.json') }));
  mock.set('/prestd/getPublicPrcureThngInfoCnstwk', () => ({ body: read('prestd.json') }));
  mock.set('/scsbid/getOpengResultListInfoCnstwk', () => ({ body: readFileSync(path.join(NARA, 'openg-result-cnstwk.json'), 'utf8') }));
  mock.set('/scsbid/getScsbidListSttusCnstwk', () => ({ body: readFileSync(path.join(NARA, 'scsbid-list-cnstwk.json'), 'utf8') }));
  mock.set('/files/notice.hwpx', { body: readFileSync(path.join(DOCS, 'sample.hwpx')), contentType: 'application/octet-stream' });
  mock.set('/files/broken.hwp', { body: readFileSync(path.join(DOCS, 'corrupt.hwp')), contentType: 'application/octet-stream' });
  const mockLlm = await startMockLlm({ fixtureDir: FIX });
  cleanups.push(() => mockLlm.close());
  const app = await startApp({
    env: {
      APP_FAKE_NOW: NOW,
      NARA_API_BASE: mock.baseUrl,
      NARA_PRESTD_BASE: `${mock.baseUrl}/prestd`,
      NARA_SCSBID_BASE: `${mock.baseUrl}/scsbid`,
      NARA_API_KEY: 'dummy-key',
      NARA_ROWS: '5',
      NARA_RETRY: '0',
      LLM_API_BASE: llm ? `${mockLlm.baseUrl}/v1` : '',
      LLM_API_KEY: llm ? 'e2e' : '',
      LLM_MODEL: 'mock',
    },
  });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
  const { context, page } = await openAs(browser, app.baseUrl, cookie);
  cleanups.push(() => context.close());
  return { app, mock, page };
}

async function saveCriteria(page, baseUrl, { exclude = '', regions = '경기, 서울' } = {}) {
  await page.goto(`${baseUrl}/settings`);
  await page.fill('#keywords', '조경, 수목, 가로수, 공원');
  await page.fill('#regions', regions);
  await page.fill('#budgetMin', '30000000');
  await page.fill('#budgetMax', '500000000');
  await page.fill('#excludeKeywords', exclude);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했습니다.').waitFor();
}

describe('app accuracy', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('accuracy: two pages collected and today cards show deadline opening budget kind', { timeout: 120000 }, async () => {
    const { app, mock, page } = await bootstrap();
    await saveCriteria(page, app.baseUrl);
    const job = await runJob(app.baseUrl, 'daily', { date: NOW });
    assert.equal(job.status, 200, JSON.stringify(job.body));
    assert.ok(mock.requests.some((r) => r.path === '/getBidPblancListInfoCnstwk' && r.query.pageNo === '2'), 'page 2 requested');
    assert.ok(mock.requests.some((r) => r.path === '/getBidPblancListInfoCnstwk' && r.query.inqryDiv === '3'), 'changed list requested');
    // 알림 항목은 maxItems(5) 개로 잘리므로 9건 수집은 공고 소스 화면의 실행 기록으로 확인한다
    await page.goto(`${app.baseUrl}/sources`);
    await page.getByText(/9건/).first().waitFor();

    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const garo = await card(page, T_GARO).innerText();
    assert.match(garo, /마감 11\/07\(토\) 10:00/);
    assert.match(garo, /개찰 11\/07\(토\) 11:00/);
    assert.match(garo, /추정가격 .*\(부가세 제외\)/);
    const changed = await card(page, '안양시 수목 관리공사').innerText();
    assert.match(changed, /변경/);
    assert.match(changed, /마감 11\/10\(화\) 10:00/);
    await shot(page, 'accuracy-today');
  });

  it('accuracy: exclude keyword removes the grave park card', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap();
    await saveCriteria(page, app.baseUrl);
    await runJob(app.baseUrl, 'daily', { date: NOW });
    await page.goto(`${app.baseUrl}/today`);
    await card(page, T_GRAVE).waitFor();

    await saveCriteria(page, app.baseUrl, { exclude: '묘지' });
    await shot(page, 'accuracy-settings');
    const text = await page.locator('main').innerText();
    assert.ok(text.includes('제외 키워드'));
    await runJob(app.baseUrl, 'daily', { date: NOW });
    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    assert.equal(await card(page, T_GRAVE).count(), 0, 'excluded card gone');
    assert.equal(await card(page, T_GARO).count(), 1, 'other cards stay');
  });

  it('accuracy: company verdict from structured license and region limits', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap();
    await saveCriteria(page, app.baseUrl, { regions: '경기, 서울, 부산' });
    await runJob(app.baseUrl, 'daily', { date: NOW });
    await page.goto(`${app.baseUrl}/company`);
    await page.fill('#name', '테스트 조경');
    await page.fill('#licenses', '조경식재공사업');
    await page.fill('#regions', '경기');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText('저장했습니다.').waitFor();

    const ok = card(page, T_GARO);
    await ok.waitFor();
    const okText = await ok.innerText();
    assert.match(okText, /참가 가능/);
    assert.match(okText, /공고 면허제한 기준/);
    const no = card(page, T_YONGIN);
    await no.waitFor();
    const noText = await no.innerText();
    assert.match(noText, /불가/);
    assert.ok(noText.includes('부산광역시'), `region reason missing: ${noText}`);
    await shot(page, 'accuracy-company');

    const dry = await runJob(app.baseUrl, 'daily', { date: NOW, dry: true });
    assert.match(dry.body.text, /참가 가능 — .*공고 면허제한 기준/);
  });

  it('accuracy: history search shows one winner row and the disclaimer', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap();
    await page.goto(`${app.baseUrl}/history?q=${encodeURIComponent('수원시')}`);
    await page.locator('table tbody tr').first().waitFor();
    assert.equal(await page.locator('table tbody tr').count(), 1);
    const main = await page.locator('main').innerText();
    assert.match(main, /낙찰자\s*업체E/);
    assert.ok(main.includes('공개된 개찰 결과만 보여 줍니다. 낙찰 가능성은 계산하지 않습니다.'));
    await shot(page, 'accuracy-history');
  });

  it('accuracy: quota error shows on sources screen and in daily warnings', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap({ quota: true });
    await saveCriteria(page, app.baseUrl);
    const job = await runJob(app.baseUrl, 'daily', { date: NOW });
    assert.equal(job.status, 200, JSON.stringify(job.body));
    assert.equal(job.body.warnings.length, 1, JSON.stringify(job.body.warnings));
    assert.ok(job.body.warnings[0].includes('오늘 조회 한도'));
    await page.goto(`${app.baseUrl}/sources`);
    await page.getByText('오늘 조회 한도').first().waitFor();
    await shot(page, 'accuracy-sources-quota');
  });

  it('accuracy: hwpx attachment gives a ready summary', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap({ llm: true });
    await saveCriteria(page, app.baseUrl);
    const job = await runJob(app.baseUrl, 'daily', { date: NOW });
    assert.equal(job.status, 200, JSON.stringify(job.body));
    await page.goto(`${app.baseUrl}/summary/${ID_GARO}`);
    await page.locator('dl.summary-lines').waitFor();
    const dl = await page.locator('dl.summary-lines').innerText();
    assert.ok(dl.includes('조경식재공사업 등록업체만 참가할 수 있습니다.'), dl);
    await page.getByText('요약 있음').first().waitFor();
    await shot(page, 'accuracy-summary-ready');
  });

  it('accuracy: corrupt hwp attachment shows unreadable notice', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap({ llm: true });
    await saveCriteria(page, app.baseUrl);
    await runJob(app.baseUrl, 'daily', { date: NOW });
    await page.goto(`${app.baseUrl}/summary/${ID_BROKEN}`);
    await page.getByText('공고문 첨부를 읽지 못했습니다').waitFor();
    const main = await page.locator('main').innerText();
    assert.ok(main.includes('원문 보기에서 직접 확인해 주세요'));
    assert.equal(await page.locator('dl.summary-lines').count(), 0);
    assert.ok(T_BROKEN.length > 0);
    await shot(page, 'accuracy-summary-notext');
  });
});
