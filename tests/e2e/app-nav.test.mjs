import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, runJob, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

const NARA_PATH = '/getBidPblancListInfoCnstwk';

// 메뉴 묶음과 순서
const GROUPS = [
  {
    name: '매일',
    menus: [
      { title: '오늘의 공고', path: '/today', help: '오늘 새로 뜬 공고 중 조건에 맞는 것과 추천 근거를 보여줍니다.' },
      { title: '관심 공고', path: '/interest', help: '관심 표시한 공고의 마감 D-day 와 입찰 전 확인 항목입니다.' },
      { title: '업무 분배', path: '/assign', help: '공고를 담당자에게 넘기고 검토중 · 참여 · 패스를 함께 봅니다.' },
    ],
  },
  {
    name: '공고 더 알기',
    menus: [
      { title: '공고 요약', path: '/summary', help: '공고문을 읽어 무슨 사업인지, 필요한 자격, 제출 서류를 세 줄로 보여줍니다.' },
      { title: '내 회사', path: '/company', help: '회사 정보를 한 번 적어 두면 공고마다 참가 가능 여부를 근거와 함께 확인합니다.' },
      { title: '지난 개찰', path: '/history', help: '수요기관이나 공고명으로 지난 개찰 결과와 낙찰자를 찾아봅니다.' },
    ],
  },
  {
    name: '더 넓게',
    menus: [
      { title: '지원사업', path: '/support', help: '정부·지자체 지원사업과 바우처 공고를 입찰과 따로 모아 보여줍니다.' },
      { title: '추천 키워드', path: '/keywords', help: '지금 키워드와 비슷한 말을 제안하고, 채택한 말로 관련 가능성 있는 공고를 1건까지 더 찾습니다.' },
      { title: '공고 소스', path: '/sources', help: '나라장터 외에 지자체·기관 게시판을 더 붙이고 가져온 결과를 확인합니다.' },
    ],
  },
  {
    name: '설정',
    menus: [{ title: '알림 설정', path: '/settings', help: '업종 키워드 · 지역 · 예산과 알림 받을 곳을 정하고 오늘 것을 미리 봅니다.' }],
  },
];

let browser;
const cleanups = [];

describe('app nav', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('nav: ten menus in order with help text', { timeout: 180000 }, async () => {
    const mock = await startMockHttp();
    cleanups.push(() => mock.close());
    mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
    const app = await startApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key' } });
    cleanups.push(() => app.stop());
    const { cookie } = await setupOwner(app.baseUrl);
    const job = await runJob(app.baseUrl, 'daily');
    assert.equal(job.status, 200);

    const { context, page } = await openAs(browser, app.baseUrl, cookie);
    cleanups.push(() => context.close());

    // `/` 는 로그인 상태에서 /today 로 간다
    await page.goto(`${app.baseUrl}/`);
    await page.waitForURL('**/today');

    // 네비: 그룹 4개, 순서, 메뉴 10개, href
    await page.goto(`${app.baseUrl}/today`);
    const nav = page.locator('nav.menu');
    assert.deepEqual(await nav.locator('.group-name').allInnerTexts(), GROUPS.map((g) => g.name));
    const groupItems = nav.locator('ul.groups > li');
    assert.equal(await groupItems.count(), GROUPS.length);
    let total = 0;
    for (let i = 0; i < GROUPS.length; i++) {
      const links = groupItems.nth(i).locator('ul.items a');
      assert.deepEqual(await links.allInnerTexts(), GROUPS[i].menus.map((m) => m.title), `group ${GROUPS[i].name}`);
      assert.deepEqual(
        await links.evaluateAll((els) => els.map((e) => e.getAttribute('href'))),
        GROUPS[i].menus.map((m) => m.path),
        `hrefs of ${GROUPS[i].name}`,
      );
      total += GROUPS[i].menus.length;
    }
    assert.equal(total, 10);
    assert.equal(await nav.locator('ul.items a').count(), 10);
    await shot(page, 'nav-all-menus');

    // 각 메뉴 페이지: 200, 제목, 도움말, active
    for (const m of GROUPS.flatMap((g) => g.menus)) {
      const res = await page.goto(`${app.baseUrl}${m.path}`);
      assert.equal(res.status(), 200, m.path);
      assert.equal(await page.locator('h1').first().innerText(), m.title, `h1 of ${m.path}`);
      assert.equal(await page.locator('h1 + p.help').innerText(), m.help, `help of ${m.path}`);
      const current = page.locator('nav.menu a[aria-current="page"]');
      assert.equal(await current.count(), 1, `active count of ${m.path}`);
      assert.equal(await current.innerText(), m.title, `active of ${m.path}`);
      assert.equal(await current.getAttribute('href'), m.path);
    }
  });
});
