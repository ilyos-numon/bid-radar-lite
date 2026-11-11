import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';
const TODAY = '2026-10-29';
const NOT_FOUND = '공고를 찾지 못했습니다. 오늘의 공고에서 다시 선택해 주세요.';
const CHECKLIST = [
  '입찰참가자격 등록 확인',
  '입찰보증금·보증서 준비',
  '제출 서류 목록 확인 (공고 요약 참조)',
  '마감 시각 재확인',
  '공동수급·지역제한 확인',
];

let browser;
const cleanups = [];

// 픽스처에서 제목 → 마감일(YYYY-MM-DD) 표
const DEADLINES = new Map(
  JSON.parse(readFileSync(NARA_FIXTURE, 'utf8')).response.body.items.map((i) => [i.bidNtceNm, i.bidClseDt.slice(0, 10)]),
);
const G_TITLE = '경기도 용인시 수목 관리 용역'; // 마감 2026-11-03, 예산 정보 없음

function ddayOf(deadlineDate) {
  return Math.round((Date.parse(`${deadlineDate}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) / 86400000);
}

async function newApp() {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  const app = await startApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key' } });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
  return { app, cookie };
}

async function newPage(baseUrl, cookie) {
  const { context, page } = await openAs(browser, baseUrl, cookie);
  cleanups.push(() => context.close());
  return page;
}

/** /today 에서 제목이 title 인 카드의 bidId 를 `관심` 링크에서 읽는다 */
async function interestHref(page, baseUrl, title) {
  await page.goto(`${baseUrl}/today`);
  await page.waitForSelector('ol.bids li.card');
  const card = page.locator('li.card', { hasText: title }).first();
  return card.getByRole('link', { name: '관심', exact: true }).getAttribute('href');
}

async function addViaPost(baseUrl, cookie, href) {
  const res = await fetch(`${baseUrl}${href}`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
  assert.equal(res.status, 303, `add ${href}`);
}

describe('app interest', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('interest: mark bid then see dday and checklist', { timeout: 120000 }, async () => {
    const { app, cookie } = await newApp();
    const daily = await runJob(app.baseUrl, 'daily');
    assert.equal(daily.status, 200);
    const page = await newPage(app.baseUrl, cookie);

    await page.goto(`${app.baseUrl}/today`);
    await page.waitForSelector('ol.bids li.card');
    const first = page.locator('ol.bids li.card').first();
    const title = (await first.locator('.title').first().innerText()).replace(/^\d+\.\s*/, '').trim();
    assert.ok(DEADLINES.has(title), `unexpected title: ${title}`);
    const expected = `D-${ddayOf(DEADLINES.get(title))}`;
    await first.getByRole('link', { name: '관심', exact: true }).click();

    // 확인 화면
    await page.waitForURL('**/interest/add/**');
    const addBtn = page.getByRole('button', { name: '관심 공고에 담기' });
    assert.equal(await addBtn.count(), 1);
    assert.ok((await page.locator('main').innerText()).includes(title));
    await addBtn.click();

    // 목록
    await page.waitForURL('**/interest');
    const card = page.locator('ol.interest li.card');
    assert.equal(await card.count(), 1);
    const text = await card.innerText();
    assert.ok(text.includes(title));
    assert.ok(text.includes(expected), `expected ${expected} in: ${text}`);
    assert.match(text, /D-\d+/);
    for (const label of CHECKLIST) assert.ok(text.includes(label), `missing checklist: ${label}`);
    assert.equal(await card.locator('button.check').count(), 5);
    assert.equal(await card.locator('button.check[aria-pressed=true]').count(), 0);
    await shot(page, 'interest-list');

    // 항목 1 체크 → 새로고침해도 유지
    await card.locator('button.check[data-item="1"]').click();
    await page.waitForURL('**/interest');
    await page.reload();
    const after1 = page.locator('ol.interest li.card');
    assert.equal(await after1.locator('button.check[aria-pressed=true]').count(), 1);
    assert.equal(await after1.locator('button.check[data-item="1"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await after1.locator('button.check[data-item="2"]').getAttribute('aria-pressed'), 'false');

    // /today 에서는 관심 중으로 보인다
    await page.goto(`${app.baseUrl}/today`);
    await page.getByRole('link', { name: '관심 중' }).first().waitFor();
  });

  it('interest: unknown bid is 404', { timeout: 60000 }, async () => {
    const { app, cookie } = await newApp();
    const page = await newPage(app.baseUrl, cookie);
    const res = await page.goto(`${app.baseUrl}/interest/add/${encodeURIComponent('없는-공고')}`);
    assert.equal(res.status(), 404);
    const main = await page.locator('main').innerText();
    assert.ok(main.includes(NOT_FOUND), main);
    const link = page.getByRole('link', { name: '오늘의 공고' }).last();
    assert.equal(await page.locator('main').getByRole('link', { name: '오늘의 공고' }).count(), 1);
    assert.equal(await link.getAttribute('href'), '/today');
    assert.equal(await page.locator('[role=alert]').count(), 1);
    assert.doesNotMatch(main, /\b(404|NOT_FOUND|Error|undefined)\b|\bat \S+\.mjs/);
    await shot(page, 'interest-404');
  });

  it('interest: reminder job sends once', { timeout: 120000 }, async () => {
    const { app, cookie } = await newApp();
    assert.equal((await runJob(app.baseUrl, 'daily')).status, 200);
    const page = await newPage(app.baseUrl, cookie);
    const href = await interestHref(page, app.baseUrl, G_TITLE);
    assert.match(href, /^\/interest\/add\//);
    await addViaPost(app.baseUrl, cookie, href);

    const date = '2026-10-31';
    const first = await runJob(app.baseUrl, 'reminders', { date });
    assert.equal(first.status, 200);
    assert.equal(first.body.kind, 'reminder');
    assert.ok(first.body.text.includes('D-3'), first.body.text);
    assert.ok(first.body.text.includes(G_TITLE), first.body.text);
    assert.ok(first.body.text.includes('미정'), first.body.text);

    const second = await runJob(app.baseUrl, 'reminders', { date });
    assert.equal(second.status, 204);
    assert.equal(second.body, null);

    // dry 는 기록을 남기지 않는다 (별도 앱 인스턴스)
    const other = await newApp();
    assert.equal((await runJob(other.app.baseUrl, 'daily')).status, 200);
    const page2 = await newPage(other.app.baseUrl, other.cookie);
    const href2 = await interestHref(page2, other.app.baseUrl, G_TITLE);
    await addViaPost(other.app.baseUrl, other.cookie, href2);
    const dry = await runJob(other.app.baseUrl, 'reminders', { date, dry: true });
    assert.equal(dry.status, 200);
    assert.ok(dry.body.text.includes('D-3'));
    const real = await runJob(other.app.baseUrl, 'reminders', { date });
    assert.equal(real.status, 200);
    assert.equal(real.body.kind, 'reminder');
    assert.equal((await runJob(other.app.baseUrl, 'reminders', { date })).status, 204);
  });
});
