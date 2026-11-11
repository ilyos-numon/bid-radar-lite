import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';

// 기존 모드: 내부 네트워크 주소 차단(허용 목록이 비면 localhost 도 막힌다), 소스 변경은 대표만
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const FEED_FIXTURE = 'tests/e2e/fixtures/sources/feed.xml';
const BLOCKED = '이 주소는 쓸 수 없습니다 (내부 네트워크 주소).';
const OWNER_ONLY = '공고 소스 추가와 변경은 대표만 할 수 있습니다.';

let browser;
const cleanups = [];

async function newMock() {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
  mock.set('/feed.xml', { body: readFileSync(FEED_FIXTURE, 'utf8'), contentType: 'application/rss+xml; charset=utf-8' });
  mock.set('/hook', { body: { ok: true } });
  return mock;
}

async function newApp(mock, allowHosts) {
  const app = await startApp({ env: { NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key', APP_FETCH_ALLOW_HOSTS: allowHosts } });
  cleanups.push(() => app.stop());
  return app;
}

async function newPage(baseUrl, cookie) {
  const { context, page } = await openAs(browser, baseUrl, cookie);
  cleanups.push(() => context.close());
  return page;
}

async function chooseRss(page, baseUrl) {
  await page.goto(`${baseUrl}/sources`);
  await page.locator('select#type').selectOption({ label: '게시판 (RSS)' });
  await page.getByRole('button', { name: '이 종류로 바꾸기' }).click();
  await page.locator('#cfg-url').waitFor();
}

async function addRss(page, baseUrl, url) {
  await chooseRss(page, baseUrl);
  await page.fill('#cfg-url', url);
  await page.fill('#cfg-orgName', '경기도 성남시');
  await page.getByRole('button', { name: '소스 추가', exact: true }).click();
}

/** 대표가 초대 링크를 만들고, 그 링크를 열어 구성원 세션 쿠키를 받는다 */
async function staffCookieOf(app, ownerCookie) {
  const res = await fetch(`${app.baseUrl}/assign/members`, {
    method: 'POST',
    body: new URLSearchParams({ name: '사무담당' }),
    headers: { cookie: ownerCookie },
    redirect: 'manual',
  });
  const link = /value="([^"]*\/join\/[^"]+)"/.exec(await res.text())?.[1];
  assert.ok(link, 'invite link is shown once');
  const joined = await fetch(link, { redirect: 'manual' });
  await joined.arrayBuffer();
  const cookie = (joined.headers.get('set-cookie') ?? '').split(';')[0];
  assert.ok(cookie.startsWith('br_session='), 'join sets a session');
  return cookie;
}

describe('app ssrf', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('ssrf: local feed address is refused with a plain message when no host is allowed', { timeout: 120000 }, async () => {
    const mock = await newMock();
    const app = await newApp(mock, '');
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);

    await page.goto(`${app.baseUrl}/sources`);
    const before = await page.locator('li.source-row').count();
    await addRss(page, app.baseUrl, `${mock.baseUrl}/feed.xml`);
    await page.getByText(BLOCKED).first().waitFor();
    assert.equal(await page.locator('li.source-row').count(), before, 'no source was added');
    assert.doesNotMatch(await page.locator('main').innerText(), /SSRF|ECONN|TypeError|stack/i);
    assert.equal(mock.requests.filter((r) => r.path === '/feed.xml').length, 0, 'the app never called the local address');
    await shot(page, 'ssrf-blocked');

    // 알림 받을 곳도 같은 이유로 저장하지 않는다
    const hook = `${mock.baseUrl}/hook`;
    const res = await fetch(`${app.baseUrl}/settings`, {
      method: 'POST',
      body: new URLSearchParams({ keywords: '조경, 수목', regions: '경기', budgetMin: '30000000', budgetMax: '500000000', webhookUrl: hook }),
      headers: { cookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes(BLOCKED), 'webhook message');
    await page.goto(`${app.baseUrl}/settings`);
    assert.equal(await page.locator('input[name=webhookUrl]').inputValue(), '', 'webhook was not saved');
    assert.equal(mock.requests.filter((r) => r.path === '/hook').length, 0);
  });

  it('ssrf: staff cannot add a source and sees no add form', { timeout: 120000 }, async () => {
    const mock = await newMock();
    const app = await newApp(mock, '');
    const { cookie } = await setupOwner(app.baseUrl);
    const staffCookie = await staffCookieOf(app, cookie);

    const res = await fetch(`${app.baseUrl}/sources`, {
      method: 'POST',
      body: new URLSearchParams({ type: 'rss', 'config.url': 'https://example.com/feed.xml' }),
      headers: { cookie: staffCookie },
      redirect: 'manual',
    });
    assert.equal(res.status, 403);
    assert.ok((await res.text()).includes(OWNER_ONLY));

    const page = await newPage(app.baseUrl, staffCookie);
    await page.goto(`${app.baseUrl}/sources`);
    await page.locator('.owner-only').waitFor();
    assert.equal(await page.locator('main').getByText(OWNER_ONLY).count(), 1);
    assert.equal(await page.locator('select#type').count(), 0, 'no type picker');
    assert.equal(await page.getByRole('button', { name: '소스 추가', exact: true }).count(), 0, 'no add button');
    await shot(page, 'sources-staff');
  });

  it('ssrf: the same feed is added once its host is on the allow list', { timeout: 120000 }, async () => {
    const mock = await newMock();
    const app = await newApp(mock, 'localhost');
    const { cookie } = await setupOwner(app.baseUrl);
    const page = await newPage(app.baseUrl, cookie);

    await page.goto(`${app.baseUrl}/sources`);
    const before = await page.locator('li.source-row').count();
    await addRss(page, app.baseUrl, `${mock.baseUrl}/feed.xml`);
    await page.getByText('소스를 추가했습니다.').waitFor();
    assert.equal(await page.locator('li.source-row').count(), before + 1);
    const row = page.locator('li.source-row', { hasText: '경기도 성남시' });
    await row.getByRole('button', { name: /지금 가져오기/ }).click();
    await page.locator('li.source-row', { hasText: '경기도 성남시' }).getByText('방금 · 3건').waitFor();
    assert.ok(mock.requests.some((r) => r.path === '/feed.xml'));
  });
});
