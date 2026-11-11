import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';
const TITLES = ['경기도 수원시 가로수 전정 및 보호 사업', '서울특별시 마포구 어린이공원 리모델링', '경기도 용인시 수목 관리 용역'];
const ERR_BUDGET = '예산 범위가 뒤바뀌었습니다. 최소 예산을 최대 예산보다 작게 적어 주세요.';

let browser;
const cleanups = [];

async function newApp(mock) {
  const app = await startApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key' } });
  cleanups.push(() => app.stop());
  return app;
}

async function newMock(setup) {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  setup(mock);
  return mock;
}

async function newPage(baseUrl, cookie) {
  const { context, page } = await openAs(browser, baseUrl, cookie);
  cleanups.push(() => context.close());
  return page;
}

async function fillCriteria(page) {
  await page.fill('#keywords', '조경, 수목, 가로수, 공원');
  await page.fill('#regions', '경기, 서울');
  await page.fill('#budgetMin', '30000000');
  await page.fill('#budgetMax', '500000000');
}

describe('app core', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('core: setup then settings preview then today', { timeout: 120000 }, async () => {
    const mock = await newMock((m) => m.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') }));
    const app = await newApp(mock);
    const page = await newPage(app.baseUrl);

    // 첫 방문 → /setup
    await page.goto(`${app.baseUrl}/`);
    await page.waitForURL('**/setup');
    await page.getByRole('heading', { name: '처음 시작하기' }).waitFor();
    await shot(page, 'core-setup');
    await page.fill('input[name=company]', '테스트 조경');
    await page.fill('input[name=name]', '대표');
    await page.getByRole('button', { name: '시작하기' }).click();

    // /settings?first=1
    await page.waitForURL('**/settings?first=1');
    await page.getByText('내일 아침부터 알림이 갑니다').waitFor();
    await shot(page, 'core-settings-first');

    // 저장 후 미리보기
    await fillCriteria(page);
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText('저장했습니다.').waitFor();
    assert.equal(await page.inputValue('#keywords'), '조경, 수목, 가로수, 공원');
    assert.equal(await page.locator('input[type=time], #notifyTime').count(), 0);
    await page.getByText('알림은 매일 아침 8시쯤 갑니다.').waitFor();
    await page.getByRole('button', { name: '오늘 것 미리보기' }).first().click();
    await page.getByText('오늘 알림에 들어갈 공고 3건').waitFor();
    for (const t of TITLES) assert.ok((await page.locator('main').innerText()).includes(t), `preview missing: ${t}`);

    // 미리보기는 기록을 남기지 않는다
    await page.goto(`${app.baseUrl}/today`);
    await page.getByText('오늘은 조건에 맞는 새 공고가 없습니다.').waitFor();
    await page.getByRole('link', { name: '알림 설정에서 조건 보기' }).waitFor();
    await page.getByRole('button', { name: '오늘 공고 가져오기' }).waitFor();
    await shot(page, 'core-today-empty');

    // 가져오기 → 목록
    await page.getByRole('button', { name: '오늘 공고 가져오기' }).click();
    await page.waitForSelector('ol.bids li.card');
    const main = await page.locator('main').innerText();
    for (const t of TITLES) assert.ok(main.includes(t), `today missing: ${t}`);
    assert.equal(await page.locator('main li.card').count(), 3);
    assert.equal((main.match(/왜 추천:/g) ?? []).length, 3);
    assert.equal((main.match(/마감 \d{2}\/\d{2}\([일월화수목금토]\) \d{2}:\d{2}/g) ?? []).length, 3);
    assert.equal((main.match(/(배정예산|추정가격|기초금액) \d+(\.\d)?(억|만) \(부가세 (포함|제외)\)|예산 미공개/g) ?? []).length, 3);
    assert.ok(main.includes('배정예산 1.2억') && main.includes('추정가격 3.8억'));

    // 네비: 매일 → 설정
    const nav = page.locator('nav.menu');
    await nav.getByRole('link', { name: '오늘의 공고' }).waitFor();
    await nav.getByRole('link', { name: '알림 설정' }).waitFor();
    const groups = await nav.locator('.group-name').allInnerTexts();
    assert.ok(groups.indexOf('매일') >= 0 && groups.indexOf('설정') > groups.indexOf('매일'), `groups: ${groups}`);
    const todayGroup = nav.locator('li', { has: page.locator('.group-name', { hasText: '매일' }) }).first();
    assert.ok((await todayGroup.innerText()).includes('오늘의 공고'));
    const setGroup = nav.locator('li', { has: page.locator('.group-name', { hasText: '설정' }) }).first();
    assert.ok((await setGroup.innerText()).includes('알림 설정'));
    await shot(page, 'core-today-list');
  });

  it('core: invalid budget shows next action', { timeout: 60000 }, async () => {
    const mock = await newMock((m) => m.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') }));
    const app = await newApp(mock);
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);
    await page.goto(`${app.baseUrl}/settings`);
    await page.fill('#keywords', '조경, 수목');
    await page.fill('#regions', '경기');
    await page.fill('#budgetMin', '500000000');
    await page.fill('#budgetMax', '30000000');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText(ERR_BUDGET).waitFor();
    const alert = await page.locator('[role=alert]').first().innerText();
    assert.match(alert, /저장하지 않았습니다/);
    assert.match(alert, /다시 저장해 주세요/);
    assert.equal(await page.inputValue('#keywords'), '조경, 수목');
    assert.equal(await page.inputValue('#regions'), '경기');
    assert.equal(await page.inputValue('#budgetMin'), '500000000');
    assert.equal(await page.inputValue('#budgetMax'), '30000000');
    await shot(page, 'core-settings-error');
  });

  it('core: bad invite link is refused', { timeout: 60000 }, async () => {
    const mock = await newMock(() => {});
    const app = await newApp(mock);
    await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl);
    const res = await page.goto(`${app.baseUrl}/join/not-a-real-token`);
    assert.equal(res.status(), 403);
    await page.getByText('초대 링크가 맞지 않습니다').waitFor();
  });

  it('core: source error shows next action', { timeout: 60000 }, async () => {
    const mock = await newMock((m) =>
      m.set(NARA_PATH, { body: { response: { header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED ERROR.' } } } }),
    );
    const app = await newApp(mock);
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);
    await page.goto(`${app.baseUrl}/today`);
    await page.getByRole('button', { name: '오늘 공고 가져오기' }).click();
    await page.locator('[role=alert]').first().waitFor();
    const text = await page.locator('[role=alert]').first().innerText();
    assert.match(text, /가져오지 못했습니다/);
    assert.match(text, /다시 눌러 주세요|확인/);
    assert.doesNotMatch(text, /resultCode|SERVICE KEY|Error|\bat \S+\.mjs/);
    assert.equal(mock.requests.filter((r) => r.path === NARA_PATH).length > 0, true);
  });
});
