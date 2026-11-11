import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';
const SUPPORT_FIXTURE = 'tests/e2e/fixtures/support/support-items.json';
const SUPPORT_TITLE = '조경 분야 소상공인 바우처';
const BID_TITLE = '경기도 용인시 수목 관리 용역';
const NO_KEY = '지원사업 인증키가 아직 없습니다. 운영자가 인증키를 넣으면 수집이 시작됩니다.';

let browser;
const cleanups = [];

async function setup({ key = 'dummy-support-key' } = {}) {
  const nara = await startMockHttp();
  cleanups.push(() => nara.close());
  nara.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  const support = await startMockHttp();
  cleanups.push(() => support.close());
  support.set('/', { body: readFileSync(SUPPORT_FIXTURE, 'utf8') });
  support.set('/items', { body: readFileSync(SUPPORT_FIXTURE, 'utf8') });
  const app = await startApp({
    env: { NARA_API_BASE: nara.baseUrl, NARA_API_KEY: 'dummy-key', SUPPORT_API_BASE: support.baseUrl, SUPPORT_API_KEY: key },
  });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
  const { context, page } = await openAs(browser, app.baseUrl, cookie);
  cleanups.push(() => context.close());
  return { app, page, support };
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

describe('app support', () => {
  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('support: collect list and notify once', { timeout: 120000 }, async () => {
    const { app, page, support } = await setup();
    await saveCriteria(page, app.baseUrl);
    await page.goto(`${app.baseUrl}/support`);
    await page.getByRole('button', { name: '지금 가져오기' }).click();
    await page.waitForSelector('ol.support-items li.card');
    const main = await page.locator('main').innerText();
    assert.ok(main.includes(SUPPORT_TITLE), main);
    assert.ok(main.includes('신청 마감 D-'), main);
    assert.ok(main.includes("왜 추천: 키워드 '조경' 일치"), main);
    assert.ok(!main.includes('청년 창업 컨설팅 지원'), 'non-matching item shown');
    assert.ok(support.requests.some((r) => r.query.serviceKey === 'dummy-support-key'));
    await shot(page, 'support-list');

    const r1 = await runJob(app.baseUrl, 'support', { date: '2026-10-29' });
    assert.equal(r1.status, 200);
    assert.equal(r1.body.kind, 'support');
    assert.equal(r1.body.count, 1);
    assert.ok(r1.body.text.includes('지원사업 레이더'), r1.body.text);
    assert.ok(r1.body.text.includes(SUPPORT_TITLE), r1.body.text);

    const r2 = await runJob(app.baseUrl, 'support', { date: '2026-10-30' });
    assert.equal(r2.status, 204);
  });

  it('support: no key shows message', { timeout: 60000 }, async () => {
    const { app, page } = await setup({ key: '' });
    await page.goto(`${app.baseUrl}/support`);
    await page.getByText(NO_KEY).waitFor();
    assert.equal(await page.getByRole('button', { name: '지금 가져오기' }).count(), 0);
    await shot(page, 'support-nokey');
    const r = await runJob(app.baseUrl, 'support');
    assert.equal(r.status, 204);
  });

  it('support: lists stay separate', { timeout: 120000 }, async () => {
    const { app, page } = await setup();
    await saveCriteria(page, app.baseUrl);
    await page.goto(`${app.baseUrl}/support`);
    await page.getByRole('button', { name: '지금 가져오기' }).click();
    await page.waitForSelector('ol.support-items li.card');
    const d = await runJob(app.baseUrl, 'daily');
    assert.equal(d.status, 200);

    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const today = await page.locator('main').innerText();
    assert.ok(today.includes(BID_TITLE), today);
    assert.ok(!today.includes(SUPPORT_TITLE), 'support item leaked into today');

    await page.goto(`${app.baseUrl}/support`);
    await page.waitForSelector('ol.support-items li.card');
    const sup = await page.locator('main').innerText();
    assert.ok(sup.includes(SUPPORT_TITLE));
    assert.ok(!sup.includes(BID_TITLE), 'bid leaked into support');
  });
});
