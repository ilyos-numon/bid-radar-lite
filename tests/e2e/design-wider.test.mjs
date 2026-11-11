import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp, startMockLlm } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';
const SUPPORT_FIXTURE = 'tests/e2e/fixtures/support/support-items.json';
const KW_FIXTURE_DIR = 'tests/e2e/fixtures/keywords';
const SUPPORT_TITLE = '조경 분야 소상공인 바우처';

let browser;
const cleanups = [];

async function saveCriteria(page, baseUrl) {
  await page.goto(`${baseUrl}/settings`);
  await page.fill('#keywords', '조경, 수목, 가로수');
  await page.fill('#regions', '경기, 서울');
  await page.fill('#budgetMin', '30000000');
  await page.fill('#budgetMax', '500000000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했습니다.').waitFor();
}

describe('design wider', () => {
  before(async () => {
    browser = await chromium.launch();
  });
  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('design-support: note and card chips', { timeout: 120000 }, async () => {
    const nara = await startMockHttp();
    cleanups.push(() => nara.close());
    nara.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
    const support = await startMockHttp();
    cleanups.push(() => support.close());
    support.set('/', { body: readFileSync(SUPPORT_FIXTURE, 'utf8') });
    support.set('/items', { body: readFileSync(SUPPORT_FIXTURE, 'utf8') });
    const app = await startApp({
      env: { NARA_API_BASE: nara.baseUrl, NARA_API_KEY: 'dummy-key', SUPPORT_API_BASE: support.baseUrl, SUPPORT_API_KEY: 'dummy-support-key' },
    });
    cleanups.push(() => app.stop());
    const { cookie } = await setupOwner(app.baseUrl);
    const { context, page } = await openAs(browser, app.baseUrl, cookie);
    cleanups.push(() => context.close());
    await saveCriteria(page, app.baseUrl);

    await page.goto(`${app.baseUrl}/support`);
    assert.ok((await page.locator('main').innerText()).includes('8시 20분'), 'note missing');
    await page.getByRole('button', { name: '지금 가져오기' }).click();
    await page.waitForSelector('ol.support-items li.card');
    const main = await page.locator('main').innerText();
    assert.ok(main.includes('8시 20분'), main);
    const card = page.locator('ol.support-items li.card').filter({ hasText: SUPPORT_TITLE });
    assert.equal(await card.count(), 1);
    const dday = (await card.locator('.dday').first().innerText()).trim();
    assert.ok(dday.startsWith('신청 마감 D-'), dday);
    assert.ok((await card.locator('p.facts').innerText()).includes('까지'));
    assert.ok((await card.locator('.num').count()) >= 1, 'number chip missing');
    assert.equal((await card.locator('.num').first().innerText()).trim(), '1');
    await shot(page, 'design-support-list');
  });

  it('design-keywords: count and maybe pill', { timeout: 120000 }, async () => {
    const mock = await startMockHttp();
    cleanups.push(() => mock.close());
    mock.set(NARA_PATH, { body: readFileSync(path.join(KW_FIXTURE_DIR, 'nara-with-park-facility.json'), 'utf8') });
    const llmDir = mkdtempSync(path.join(tmpdir(), 'br-dw-llm-'));
    cleanups.push(async () => rmSync(llmDir, { recursive: true, force: true }));
    copyFileSync(path.join(KW_FIXTURE_DIR, 'synonyms.default.json'), path.join(llmDir, 'synonyms.default.json'));
    const llm = await startMockLlm({ fixtureDir: llmDir });
    cleanups.push(() => llm.close());
    const app = await startApp({
      env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key', LLM_API_BASE: `${llm.baseUrl}/v1`, LLM_API_KEY: 'e2e', LLM_MODEL: 'mock' },
    });
    cleanups.push(() => app.stop());
    const { cookie } = await setupOwner(app.baseUrl);
    const { context, page } = await openAs(browser, app.baseUrl, cookie);
    cleanups.push(() => context.close());
    await saveCriteria(page, app.baseUrl);

    await page.goto(`${app.baseUrl}/keywords`);
    await page.getByRole('button', { name: '비슷한 키워드 찾기' }).click();
    await page.waitForURL('**/keywords?added=1');
    await page.locator('li.card[data-word]').first().waitFor();

    const suggested = page.locator('section[aria-labelledby="kw-suggested"]');
    const n = await suggested.locator('li.card[data-word]').count();
    assert.ok(n >= 1, 'no suggestions');
    await suggested.getByText(`${n}개 · 쓸 말은 채택을 눌러 주세요`).waitFor();

    const maybe = page.locator('section[aria-labelledby="kw-maybe"]');
    assert.ok((await maybe.locator('.pill').innerText()).includes('켜짐'));
    assert.equal(await page.getByText('켜짐 —').count(), 1);

    const now = page.locator('section#suggest');
    assert.ok((await now.innerText()).includes('지금 키워드'));
    assert.ok((await now.locator('.chip').count()) >= 1, 'keyword chips missing');
    await shot(page, 'design-keywords-suggested');
  });

  it('design-sources: counts, default chip, add card', { timeout: 120000 }, async () => {
    const mock = await startMockHttp();
    cleanups.push(() => mock.close());
    mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
    const app = await startApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key' } });
    cleanups.push(() => app.stop());
    const { cookie } = await setupOwner(app.baseUrl);
    const { context, page } = await openAs(browser, app.baseUrl, cookie);
    cleanups.push(() => context.close());

    await page.goto(`${app.baseUrl}/sources`);
    await page.getByRole('heading', { name: '공고를 가져오는 곳 2곳 · 켜짐 2' }).waitFor();
    const nara = page.locator('li.source-row').filter({ hasText: '나라장터' }).filter({ has: page.locator('.chip.default') });
    assert.equal(await nara.count(), 1);
    assert.equal((await nara.locator('.chip.default').innerText()).trim(), '기본');
    assert.equal(await nara.getByRole('button', { name: /삭제/ }).count(), 0);

    const add = page.locator('section[aria-labelledby="add-title"]');
    assert.ok((await add.innerText()).includes('지자체·기관 게시판 주소를 붙이면'));
    assert.equal(await add.locator('select#type').count(), 1);
    assert.equal(await add.getByRole('button', { name: '이 종류로 바꾸기' }).count(), 1);
    await shot(page, 'design-sources-list');
  });
});
