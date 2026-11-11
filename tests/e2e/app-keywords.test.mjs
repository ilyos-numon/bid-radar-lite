import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot } from './helpers/app.mjs';
import { startMockHttp, startMockLlm } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';
const FIXTURE_DIR = 'tests/e2e/fixtures/keywords';
const MAYBE_TITLE = '경기도 성남시 공원 시설물 보수 공사';
const NO_DIRECT = '키워드 직접 일치 없음';
const SIMILAR = "유사어 '시설물' 포함 (키워드 '조경' 의 비슷한 말)";
const ERR_TEXT = '추천 키워드를 가져오지 못했습니다. 잠시 후 다시 눌러 주세요.';

let browser;
const cleanups = [];

// 공원 키워드가 없어야 공원 시설물 보수 공고가 직접 일치하지 않는다
async function newEnv() {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(path.join(FIXTURE_DIR, 'nara-with-park-facility.json'), 'utf8') });
  // 테스트 안에서 파일을 지워 모의 LLM 이 500 을 내게 할 수 있도록 임시 폴더에 복사한다
  const llmDir = mkdtempSync(path.join(tmpdir(), 'br-kw-llm-'));
  cleanups.push(async () => rmSync(llmDir, { recursive: true, force: true }));
  const fixturePath = path.join(llmDir, 'synonyms.default.json');
  copyFileSync(path.join(FIXTURE_DIR, 'synonyms.default.json'), fixturePath);
  const llm = await startMockLlm({ fixtureDir: llmDir });
  cleanups.push(() => llm.close());
  const app = await startApp({
    env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key', LLM_API_BASE: `${llm.baseUrl}/v1`, LLM_API_KEY: 'e2e', LLM_MODEL: 'mock' },
  });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
  const { context, page } = await openAs(browser, app.baseUrl, cookie);
  cleanups.push(() => context.close());
  await page.goto(`${app.baseUrl}/settings`);
  await page.fill('#keywords', '조경, 수목, 가로수');
  await page.fill('#regions', '경기, 서울');
  await page.fill('#budgetMin', '30000000');
  await page.fill('#budgetMax', '500000000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했습니다.').waitFor();
  return { app, page, llm, fixturePath };
}

async function suggestAndAccept(app, page) {
  await page.goto(`${app.baseUrl}/keywords`);
  await page.getByText('제안받은 키워드가 없습니다.').waitFor();
  await page.getByRole('button', { name: '비슷한 키워드 찾기' }).click();
  await page.waitForURL('**/keywords?added=1');
  const card = page.locator('li.card[data-word="시설물"]');
  await card.waitFor();
  return card;
}

describe('app keywords', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('keywords: suggest accept and maybe appears on today', { timeout: 120000 }, async () => {
    const { app, page, llm } = await newEnv();

    // 채택어가 없으면 maybe 는 없다
    const before = await runJob(app.baseUrl, 'daily', { dry: true });
    assert.equal(before.status, 200);
    assert.equal(before.body.maybe, null);

    const card = await suggestAndAccept(app, page);
    assert.deepEqual(llm.calls.map((c) => c.task), ['synonyms']);
    assert.ok((await card.innerText()).includes('조경 의 비슷한 말'));
    await shot(page, 'keywords-suggested');

    await card.getByRole('button', { name: '채택' }).click();
    await page.waitForURL('**/keywords');
    const accepted = page.locator('section[aria-labelledby="kw-accepted"]');
    const acceptedText = await accepted.innerText();
    assert.ok(acceptedText.includes('시설물') && acceptedText.includes('조경 의 비슷한 말'), acceptedText);

    // 채택만으로는 이미 받은 공고에 영향이 없고, 잡을 돌리면 maybe 가 붙는다
    const job = await runJob(app.baseUrl, 'daily');
    assert.equal(job.status, 200);
    const maybe = job.body.maybe;
    assert.ok(maybe, 'maybe missing');
    assert.equal(maybe.title, MAYBE_TITLE);
    assert.deepEqual(maybe.reasons.slice(0, 2), [NO_DIRECT, SIMILAR]);
    assert.ok(!job.body.items.some((i) => i.title === MAYBE_TITLE), 'maybe must not be in matched list');
    assert.ok(job.body.text.includes('관련 가능성 있음') && job.body.text.includes(MAYBE_TITLE), job.body.text);

    await page.goto(`${app.baseUrl}/today`);
    const heading = page.getByRole('heading', { name: /관련 가능성 있음/ });
    await heading.waitFor();
    const section = page.locator('section[aria-labelledby="maybe-title"]');
    assert.equal(await section.locator('li.card').count(), 1);
    const text = await section.innerText();
    assert.ok(text.includes(MAYBE_TITLE), text);
    assert.ok(text.includes(NO_DIRECT), text);
    assert.ok(text.includes(SIMILAR), text);
    // 맨 아래: 목록 카드가 모두 위에 있다
    const hb = await heading.boundingBox();
    const lastMatched = await page.locator('ol.bids').first().locator('li.card').last().boundingBox();
    assert.ok(lastMatched.y < hb.y, 'maybe heading must be below matched list');
    await shot(page, 'keywords-accepted-maybe');
  });

  it('keywords: suggestion failure keeps list', { timeout: 120000 }, async () => {
    const { app, page, fixturePath } = await newEnv();
    await suggestAndAccept(app, page);

    // 이제 모의 LLM 이 500 을 낸다
    rmSync(fixturePath);
    await page.getByRole('button', { name: '비슷한 키워드 찾기' }).click();
    await page.getByText(ERR_TEXT).waitFor();
    assert.equal(await page.locator('.error').count(), 1);
    assert.ok(await page.locator('li.card[data-word="시설물"]').count() === 1, 'existing suggestion must stay');
    const main = await page.locator('main').innerText();
    assert.ok(!/HTTP_|NO_KEY|BAD_JSON|SCHEMA|TIMEOUT|NETWORK|Error|undefined/.test(main), main);
    await shot(page, 'keywords-error');

    // 새로고침해도 목록이 그대로다
    await page.goto(`${app.baseUrl}/keywords`);
    assert.equal(await page.locator('li.card[data-word="시설물"]').count(), 1);
  });

  it('keywords: disabled hides maybe', { timeout: 120000 }, async () => {
    const { app, page } = await newEnv();
    const card = await suggestAndAccept(app, page);
    await card.getByRole('button', { name: '채택' }).click();
    await page.waitForURL('**/keywords');

    const on = await runJob(app.baseUrl, 'daily');
    assert.ok(on.body.maybe, 'maybe should exist while enabled');

    await page.getByText('켜짐 —').waitFor();
    await page.locator('section[aria-labelledby="kw-maybe"]').getByRole('button', { name: '끄기' }).click();
    await page.waitForURL('**/keywords');
    await page.getByText('꺼짐 —').waitFor();

    const off = await runJob(app.baseUrl, 'daily');
    assert.equal(off.status, 200);
    assert.equal(off.body.maybe, null);
    assert.ok(!off.body.text.includes('관련 가능성 있음'), off.body.text);

    await page.goto(`${app.baseUrl}/today`);
    await page.locator('ol.bids li.card').first().waitFor();
    assert.equal(await page.getByRole('heading', { name: /관련 가능성 있음/ }).count(), 0);
    assert.ok(!(await page.locator('main').innerText()).includes(MAYBE_TITLE));
  });
});
