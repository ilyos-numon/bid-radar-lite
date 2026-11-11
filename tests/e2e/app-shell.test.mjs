import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, shot } from './helpers/app.mjs';

// 공통 틀 DOM 계약과 /me
const MENUS = [
  { group: '매일', title: '오늘의 공고', path: '/today' },
  { group: '매일', title: '관심 공고', path: '/interest' },
  { group: '매일', title: '업무 분배', path: '/assign' },
  { group: '공고 더 알기', title: '공고 요약', path: '/summary' },
  { group: '공고 더 알기', title: '내 회사', path: '/company' },
  { group: '공고 더 알기', title: '지난 개찰', path: '/history' },
  { group: '더 넓게', title: '지원사업', path: '/support' },
  { group: '더 넓게', title: '추천 키워드', path: '/keywords' },
  { group: '더 넓게', title: '공고 소스', path: '/sources' },
  { group: '설정', title: '알림 설정', path: '/settings' },
];
const OWNER = { company: '테스트 조경', name: '대표' };
const MOBILE = { width: 390, height: 844 };
const PRIMARY = 'main button:not(.secondary), main .button:not(.secondary)';

let browser;
const cleanups = [];

async function appWithOwner() {
  const app = await startApp();
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl, OWNER);
  return { app, cookie };
}

async function pageAs(app, cookie, viewport) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const raw = cookie.split(';')[0];
  const i = raw.indexOf('=');
  await context.addCookies([{ name: raw.slice(0, i), value: raw.slice(i + 1), url: app.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
  cleanups.push(() => context.close());
  return context.newPage();
}

describe('app shell', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('shell: header and sidebar contract', { timeout: 120000 }, async () => {
    const { app, cookie } = await appWithOwner();
    const { context, page } = await openAs(browser, app.baseUrl, cookie);
    cleanups.push(() => context.close());
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.goto(`${app.baseUrl}/interest`);
    // 헤더
    const header = page.locator('header.top');
    assert.equal(await header.count(), 1);
    assert.equal(await header.locator('a.brand').getAttribute('href'), '/');
    assert.equal(await header.locator('a.brand .name').innerText(), '입찰 레이더');
    assert.equal(await header.locator('a.brand .company').innerText(), OWNER.company);
    assert.equal(await header.locator('a.brand svg').count() >= 1, true, 'logo icon');
    const me = header.locator('.who a.me');
    assert.equal(await me.getAttribute('href'), '/me');
    assert.equal(await me.getAttribute('aria-label'), `내 정보 · ${OWNER.name}`);
    assert.equal(await me.locator('.avatar').innerText(), '대');
    assert.equal(await me.locator('.avatar').getAttribute('aria-hidden'), 'true');
    assert.equal(await me.locator('.member').innerText(), OWNER.name);
    assert.equal(await me.locator('.role').innerText(), '대표');
    const logout = header.locator('.who a.logout');
    assert.equal(await logout.innerText(), '나가기');
    assert.equal(await logout.getAttribute('href'), '/logout');
    for (const sel of ['.member', '.role', '.dot', '.logout']) {
      assert.equal(await header.locator(sel).first().isVisible(), true, `desktop shows ${sel}`);
    }

    // 사이드바: 그룹, 링크, 아이콘(li > svg, a 밖), 활성
    const nav = page.locator('nav.menu');
    assert.equal(await nav.getAttribute('aria-label'), '메뉴');
    assert.equal(await nav.isVisible(), true);
    assert.deepEqual(await nav.locator('.group-name').allInnerTexts(), ['매일', '공고 더 알기', '더 넓게', '설정']);
    const links = nav.locator('ul.items li > a');
    assert.deepEqual(await links.allInnerTexts(), MENUS.map((m) => m.title));
    assert.equal(await nav.locator('ul.items li > svg').count(), 10, 'one icon per menu');
    assert.equal(await nav.locator('ul.items li > a svg').count(), 0, 'icons live outside the link');
    assert.equal(
      await nav.locator('ul.items li > svg').evaluateAll((els) => els.every((e) => e.getAttribute('aria-hidden') === 'true')),
      true,
    );
    const current = nav.locator('a[aria-current="page"]');
    assert.equal(await current.count(), 1);
    assert.equal(await current.innerText(), '관심 공고');
    assert.equal(await nav.locator('p.menu-note').innerText(), '알림은 매일 아침 8시쯤 갑니다.');

    // 본문 구조
    assert.equal(await page.locator('main#main').count(), 1);
    assert.equal(await page.locator('main nav').count(), 0, 'no nav inside main');
    assert.equal(await page.locator('h1 + p.help').count(), 1);
    // 데스크톱에서는 하단 탭이 보이지 않는다
    assert.equal(await page.locator('nav.tabs').isVisible(), false);
    // 사이드바는 본문 왼쪽
    const navBox = await nav.boundingBox();
    const mainBox = await page.locator('main#main').boundingBox();
    assert.ok(navBox.x + navBox.width <= mainBox.x + 1, 'sidebar is left of main');
  });

  it('shell: eyebrow and bare setup', { timeout: 120000 }, async () => {
    // 소유자가 없는 새 앱: /setup 은 사이드바 없는 단독 화면
    const app = await startApp();
    cleanups.push(() => app.stop());
    const { context, page } = await openAs(browser, app.baseUrl, null);
    cleanups.push(() => context.close());

    await page.goto(`${app.baseUrl}/setup`);
    assert.equal(await page.locator('body.bare').count(), 1);
    assert.equal(await page.locator('main#main.bare').count(), 1);
    assert.equal(await page.locator('header.top').count(), 0);
    assert.equal(await page.locator('nav.menu').count(), 0);
    assert.equal(await page.locator('nav.tabs').count(), 0);
    assert.equal(await page.locator('.eyebrow').count(), 0);
    assert.equal(await page.locator('h1').innerText(), '처음 시작하기');
    assert.equal(await page.locator('main.bare .brand-row .name').innerText(), '입찰 레이더');
    assert.equal(await page.locator('form[action="/setup"] button[type="submit"]').innerText(), '시작하기');
    await shot(page, 'shell-setup-bare');

    // 로그인 후 eyebrow = 활성 메뉴의 그룹 이름, h1 바로 앞
    const { cookie } = await setupOwner(app.baseUrl, OWNER);
    const logged = await openAs(browser, app.baseUrl, cookie);
    cleanups.push(() => logged.context.close());
    for (const m of MENUS) {
      await logged.page.goto(`${app.baseUrl}${m.path}`);
      assert.equal(await logged.page.locator('.page-head p.eyebrow').innerText(), m.group, `eyebrow of ${m.path}`);
      assert.equal(await logged.page.locator('.page-head p.eyebrow + h1').count(), 1, `eyebrow precedes h1 on ${m.path}`);
      assert.equal(await logged.page.locator('.page-head h1').innerText(), m.title);
    }
  });

  it('shell: mobile tabs at 390', { timeout: 120000 }, async () => {
    const { app, cookie } = await appWithOwner();
    const page = await pageAs(app, cookie, MOBILE);

    await page.goto(`${app.baseUrl}/today`);
    // 데스크톱 요소 숨김
    assert.equal(await page.locator('nav.menu').isVisible(), false, 'sidebar hidden');
    const header = page.locator('header.top');
    for (const sel of ['.member', '.role', '.dot', '.logout']) {
      assert.equal(await header.locator(sel).first().isVisible(), false, `mobile hides ${sel}`);
    }
    const me = header.locator('a.me');
    assert.equal(await me.isVisible(), true);
    const meBox = await me.boundingBox();
    assert.ok(meBox.width >= 44 && meBox.height >= 44, `avatar target >= 44px (${meBox.width}x${meBox.height})`);
    assert.equal(await me.getAttribute('aria-label'), `내 정보 · ${OWNER.name}`);

    // 하단 탭: 링크 3개 + 더보기
    const tabs = page.locator('nav.tabs');
    assert.equal(await tabs.isVisible(), true);
    assert.equal(await tabs.getAttribute('aria-label'), '빠른 메뉴');
    assert.deepEqual(await tabs.locator(':scope > a').allInnerTexts(), ['오늘의 공고', '관심 공고', '업무 분배']);
    assert.equal(await tabs.locator('summary').innerText(), '더보기');
    assert.equal(await tabs.locator(':scope > a[aria-current="page"]').innerText(), '오늘의 공고');
    for (const t of await tabs.locator(':scope > a, summary').all()) {
      const box = await t.boundingBox();
      assert.ok(box.height >= 44 && box.width >= 44, 'tab touch target >= 44px');
    }
    const tabBox = await tabs.boundingBox();
    assert.ok(Math.abs(tabBox.y + tabBox.height - MOBILE.height) <= 1, 'tabs pinned to the bottom');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal scroll');
    await shot(page, 'shell-mobile-today-390');

    // 더보기: 패널에 나머지 6개, 그룹 이름 3개
    await page.locator('nav.tabs summary').click();
    const panel = page.locator('nav.tabs .more-panel');
    await panel.waitFor({ state: 'visible' });
    assert.deepEqual(await panel.locator('a').allInnerTexts(), MENUS.slice(3).map((m) => m.title));
    assert.deepEqual(
      await panel.locator('a').evaluateAll((els) => els.map((e) => e.getAttribute('href'))),
      MENUS.slice(3).map((m) => m.path),
    );
    assert.deepEqual(await panel.locator('.group-name').allInnerTexts(), ['공고 더 알기', '더 넓게', '설정']);
    await shot(page, 'shell-mobile-more-390');

    // 더보기 안의 메뉴가 활성이면 summary.on 과 패널 안 aria-current
    await page.locator('nav.tabs .more-panel a[href="/summary"]').click();
    await page.waitForURL('**/summary');
    assert.equal(await page.locator('nav.tabs summary.on').count(), 1);
    assert.equal(await page.locator('nav.tabs .more-panel a[aria-current="page"]').count(), 1);
    assert.equal(await page.locator('nav.tabs > a[aria-current="page"]').count(), 0);

    // 관심 공고 화면
    await page.goto(`${app.baseUrl}/interest`);
    assert.equal(await page.locator('nav.tabs > a[aria-current="page"]').innerText(), '관심 공고');
    assert.equal(await page.locator('nav.tabs summary.on').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal scroll on interest');
    await shot(page, 'shell-mobile-interest-390');
  });

  it('shell: zero external requests', { timeout: 180000 }, async () => {
    const app = await startApp();
    cleanups.push(() => app.stop());
    const { context, page } = await openAs(browser, app.baseUrl, null);
    cleanups.push(() => context.close());
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));

    await page.goto(`${app.baseUrl}/setup`);
    await page.goto(`${app.baseUrl}/welcome`);
    const { cookie } = await setupOwner(app.baseUrl, OWNER);
    const raw = cookie.split(';')[0];
    const i = raw.indexOf('=');
    await context.addCookies([{ name: raw.slice(0, i), value: raw.slice(i + 1), url: app.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    for (const m of MENUS) await page.goto(`${app.baseUrl}${m.path}`);
    await page.goto(`${app.baseUrl}/me`);
    // 모바일 크기에서도 한 번 더 (더보기 열기 포함)
    await page.setViewportSize(MOBILE);
    await page.goto(`${app.baseUrl}/today`);
    await page.locator('nav.tabs summary').click();

    assert.ok(urls.length >= 12, `visited pages produced requests (${urls.length})`);
    const outside = urls.filter((u) => !u.startsWith(app.baseUrl) && !u.startsWith('data:') && !u.startsWith('about:'));
    assert.deepEqual(outside, [], 'no request leaves the app origin');
  });

  it('shell: accessibility basics', { timeout: 180000 }, async () => {
    const { app, cookie } = await appWithOwner();
    const page = await pageAs(app, cookie, { width: 1280, height: 800 });

    for (const path of [...MENUS.map((m) => m.path), '/me']) {
      await page.goto(`${app.baseUrl}${path}`);
      assert.equal(await page.locator('html').getAttribute('lang'), 'ko', `lang ${path}`);
      assert.equal((await page.title()).endsWith('입찰 레이더'), true, `title ${path}`);
      assert.equal(await page.locator('h1').count(), 1, `one h1 ${path}`);
      assert.equal(await page.locator('main#main').count(), 1, `main ${path}`);
      const skip = page.locator('a.skip');
      assert.equal(await skip.getAttribute('href'), '#main', `skip link ${path}`);
      // 장식 아이콘은 읽는 사람에게 숨김
      assert.equal(
        await page.locator('svg.icon').evaluateAll((els) => els.filter((e) => e.getAttribute('aria-hidden') !== 'true').length),
        0,
        `icons hidden from readers ${path}`,
      );
      // 이름 없는 링크·버튼 없음
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll('a, button')]
          .filter((e) => e.offsetParent !== null || getComputedStyle(e).position === 'fixed')
          .filter((e) => !(e.getAttribute('aria-label') || e.textContent.trim()))
          .map((e) => e.outerHTML.slice(0, 80)),
      );
      assert.deepEqual(unnamed, [], `unnamed controls ${path}`);
      // 입력칸에는 이름이 있다
      const unlabeled = await page.evaluate(() =>
        [...document.querySelectorAll('main input:not([type=hidden]), main select, main textarea')]
          .filter((e) => !(e.labels && e.labels.length) && !e.getAttribute('aria-label') && !e.getAttribute('aria-labelledby'))
          .map((e) => e.outerHTML.slice(0, 80)),
      );
      assert.deepEqual(unlabeled, [], `unlabeled inputs ${path}`);
    }

    // 키보드: 첫 Tab 은 본문 건너뛰기 링크, 보이게 되고 Enter 로 #main 이동
    await page.goto(`${app.baseUrl}/today`);
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => document.activeElement?.className);
    assert.equal(focused, 'skip');
    const box = await page.locator('a.skip').boundingBox();
    assert.ok(box.x >= 0, 'skip link visible when focused');
    await page.keyboard.press('Enter');
    assert.ok(page.url().endsWith('#main'));

    // 포커스 링: 링크에 키보드 포커스가 오면 윤곽선이 보인다
    await page.locator('nav.menu a[href="/interest"]').focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    const outline = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement);
      return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
    });
    assert.notEqual(outline.style, 'none');
    assert.ok(outline.width >= 2, `focus outline width ${outline.width}`);

    // 사이드바 링크 높이 44px 이상
    for (const a of await page.locator('nav.menu ul.items a').all()) {
      const b = await a.boundingBox();
      assert.ok(b.height >= 44, `menu link height ${b.height}`);
    }
  });

  it('shell: at most one primary button per screen', { timeout: 180000 }, async () => {
    const { app, cookie } = await appWithOwner();
    const page = await pageAs(app, cookie, { width: 1280, height: 800 });
    for (const path of [...MENUS.map((m) => m.path), '/me']) {
      await page.goto(`${app.baseUrl}${path}`);
      const count = await page.locator(PRIMARY).count();
      assert.ok(count <= 1, `${path} has ${count} primary buttons: ${await page.locator(PRIMARY).allInnerTexts()}`);
    }
    // /me 는 주 버튼이 없다 (나가기는 보조 모양)
    await page.goto(`${app.baseUrl}/me`);
    assert.equal(await page.locator(PRIMARY).count(), 0);
    assert.equal(await page.locator('main a.button.secondary', { hasText: '나가기' }).count(), 1);
  });

  it('shell: busy state', { timeout: 120000 }, async () => {
    const { app, cookie } = await appWithOwner();
    const page = await pageAs(app, cookie, { width: 1280, height: 800 });
    await page.goto(`${app.baseUrl}/today`);

    const button = page.getByRole('button', { name: '오늘 공고 가져오기' });
    assert.equal(await button.count(), 1);
    assert.equal(await button.getAttribute('data-busy'), '가져오는 중…');
    // 서버 응답을 늦춰, 내비게이션 전에 busy 상태를 관찰할 수 있게 한다
    await page.route('**/today/run', (route) => {
      setTimeout(() => route.continue().catch(() => {}), 500);
    });
    const responded = page.waitForResponse((r) => r.url().includes('/today/run'));
    await button.click({ noWaitAfter: true });
    // 눌린 버튼은 잠기고(disabled) 진행 문구로 바뀐다
    await page.waitForFunction(() => {
      const b = document.querySelector('button[aria-busy="true"]');
      return Boolean(b) && b.disabled && b.textContent === '가져오는 중…';
    });
    // 응답이 오면 페이지가 정상적으로 이동한다
    await responded;
    await page.waitForLoadState('load');
    assert.ok(new URL(page.url()).pathname.startsWith('/today'), `after run: ${page.url()}`);
  });

  it('shell: me page', { timeout: 120000 }, async () => {
    const { app, cookie } = await appWithOwner();

    // 쿠키 없이: 302 /welcome
    const anon = await fetch(`${app.baseUrl}/me`, { redirect: 'manual' });
    assert.equal(anon.status, 302);
    assert.equal(new URL(anon.headers.get('location'), app.baseUrl).pathname, '/welcome');

    // 로그인: 이름·역할·회사, 활성 메뉴 없음
    const page = await pageAs(app, cookie, { width: 1280, height: 800 });
    const res = await page.goto(`${app.baseUrl}/me`);
    assert.equal(res.status(), 200);
    assert.equal(await page.locator('h1').innerText(), '내 정보');
    const main = page.locator('main');
    const text = await main.innerText();
    assert.ok(text.includes(OWNER.name), 'owner name');
    assert.ok(text.includes('대표'), 'role');
    assert.ok(text.includes(OWNER.company), 'company');
    assert.equal(await page.locator('nav.menu a[aria-current]').count(), 0);
    assert.equal(await page.locator('nav.menu ul.items a').count(), 10, 'menu still has ten items');
    await shot(page, 'shell-me');

    // 나가기 → /welcome
    await main.getByRole('link', { name: '나가기' }).click();
    await page.waitForURL('**/welcome');
    await page.goto(`${app.baseUrl}/me`);
    await page.waitForURL('**/welcome');

    // 모바일: 헤더 아바타 → /me
    const mobile = await pageAs(app, cookie, MOBILE);
    await mobile.goto(`${app.baseUrl}/today`);
    await mobile.locator('header.top a.me').click();
    await mobile.waitForURL('**/me');
    assert.equal(await mobile.locator('h1').innerText(), '내 정보');
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= 390), 'no horizontal scroll on /me');
    await shot(mobile, 'shell-mobile-me-390');
    await mobile.locator('main').getByRole('link', { name: '나가기' }).click();
    await mobile.waitForURL('**/welcome');
  });
});
