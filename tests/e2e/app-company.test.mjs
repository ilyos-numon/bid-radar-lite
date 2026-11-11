import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs, shot } from './helpers/app.mjs';
import { startMockHttp, startMockLlm } from './helpers/mock-ext.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'company');
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const T_OK = '경기도 수원시 가로수 전정 및 보호 사업'; // 20261029001: 조경식재공사업 요구
const T_LACK = '경기도 용인시 수목 관리 용역'; // 20261029007: 전기공사업 요구
const T_REGION = '서울특별시 마포구 어린이공원 리모델링'; // 20261029002

let browser;
const cleanups = [];

/** 모의 HTTP(나라장터 + 첨부 txt) + 모의 LLM + 앱을 띄우고 로그인한 페이지를 돌려준다 */
async function bootstrap(naraFile, regions = '경기, 서울') {
  const mock = await startMockHttp();
  cleanups.push(() => mock.close());
  const body = readFileSync(path.join(FIX, naraFile), 'utf8').replaceAll('__MOCK__', mock.baseUrl);
  mock.set(NARA_PATH, { body });
  for (const f of ['attach-ok.txt', 'attach-lack.txt', 'attach-region.txt']) {
    mock.set(`/files/${f}`, { body: readFileSync(path.join(FIX, f), 'utf8'), contentType: 'text/plain; charset=utf-8' });
  }
  const llm = await startMockLlm({ fixtureDir: FIX });
  cleanups.push(() => llm.close());
  const app = await startApp({
    env: {
      NARA_API_BASE: mock.baseUrl,
      NARA_API_KEY: 'dummy-key',
      LLM_API_BASE: `${llm.baseUrl}/v1`,
      LLM_API_KEY: 'e2e',
      LLM_MODEL: 'mock',
    },
  });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
  const { context, page } = await openAs(browser, app.baseUrl, cookie);
  cleanups.push(() => context.close());

  // 알림 조건 저장 → 오늘 공고 가져오기 (회사 정보는 아직 없음)
  await page.goto(`${app.baseUrl}/settings`);
  await page.fill('#keywords', '조경, 수목, 가로수, 공원');
  await page.fill('#regions', regions);
  await page.fill('#budgetMin', '30000000');
  await page.fill('#budgetMax', '500000000');
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했습니다.').waitFor();
  await page.goto(`${app.baseUrl}/today`);
  await page.getByRole('button', { name: '오늘 공고 가져오기' }).click();
  await page.waitForSelector('ol.bids li.card');
  return { app, page, llm };
}

async function saveProfile(page, baseUrl, { name = '테스트 조경', licenses, regions }) {
  await page.goto(`${baseUrl}/company`);
  await page.fill('#name', name);
  await page.fill('#licenses', licenses);
  await page.fill('#regions', regions);
  await page.getByRole('button', { name: '저장', exact: true }).click();
  await page.getByText('저장했습니다.').waitFor();
}

const card = (page, title) => page.locator('main li.card', { hasText: title });

describe('app company', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    await browser?.close();
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('company: profile saved and bid is eligible', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap('nara-with-requirements.json');

    // 회사 정보가 없을 때: 안내가 보이고 판정 목록은 없다
    await page.goto(`${app.baseUrl}/company`);
    await page.getByText('회사 정보를 적으면 공고마다 참가 가능 여부를 확인합니다.').waitFor();
    assert.equal(await page.locator('main li.card').count(), 0);

    await saveProfile(page, app.baseUrl, {
      licenses: '조경식재공사업, 조경시설물설치공사업',
      regions: '경기, 서울',
    });
    const main = await page.locator('main').innerText();
    assert.ok(main.includes('조경식재공사업, 조경시설물설치공사업'), 'licenses listed');
    assert.ok(main.includes('경기, 서울'), 'regions listed');
    assert.ok(main.includes('공고마다 참가 가능 여부를 자동으로 확인합니다'), 'help text');
    await shot(page, 'company-profile');

    // 판정 목록: 참가 가능 + 근거 인용
    const ok = card(page, T_OK);
    await ok.waitFor();
    const okText = await ok.innerText();
    assert.match(okText, /참가 가능/);
    assert.ok(okText.includes('조경식재공사업 등록업체'), `quote missing: ${okText}`);
    await shot(page, 'company-verdicts');

    // 오늘의 공고 뱃지가 같은 판정을 가리킨다
    await page.goto(`${app.baseUrl}/today`);
    const badge = page.locator('main li.card', { hasText: T_OK }).locator('a.badge', { hasText: '참가 가능' });
    await badge.waitFor();
    assert.match(await badge.getAttribute('href'), /\/company#20261029001-000$/);
  });

  it('company: missing license needs check', { timeout: 120000 }, async () => {
    const { app, page } = await bootstrap('nara-with-requirements.json');
    await saveProfile(page, app.baseUrl, { licenses: '조경시설물설치공사업', regions: '경기, 서울' });
    const lack = card(page, T_LACK);
    await lack.waitFor();
    const text = await lack.innerText();
    assert.match(text, /확인 필요/);
    assert.ok(text.includes("필요 면허 '전기공사업' 가 회사 정보에 없음"), `reason missing: ${text}`);
    assert.doesNotMatch(text, /참가 가능|불가/);

    await page.goto(`${app.baseUrl}/today`);
    await page.locator('main li.card', { hasText: T_LACK }).locator('a.badge', { hasText: '확인 필요' }).waitFor();
  });

  it('company: structured region limit is not eligible', { timeout: 180000 }, async () => {
    // 구조화된 지역 제한(부산광역시) + 회사 지역 경기·서울 → 불가
    const a = await bootstrap('nara-with-requirements.json', '경기, 서울, 부산');
    await saveProfile(a.page, a.app.baseUrl, { licenses: '조경식재공사업', regions: '경기, 서울' });
    const region = card(a.page, T_REGION);
    await region.waitFor();
    const text = await region.innerText();
    assert.match(text, /불가/);
    assert.ok(text.includes("참가 지역 제한 '부산광역시' · 회사 소재지 해당 없음"), `limit reason missing: ${text}`);
    assert.ok(text.includes('회사 소재지: 경기, 서울'), `our region missing: ${text}`);
    await a.page.goto(`${a.app.baseUrl}/today`);
    await a.page.locator('main li.card', { hasText: T_REGION }).locator('a.badge', { hasText: '불가' }).waitFor();

    // 구조화 필드가 없고 모델 응답만 지역 제한을 말하면 불가가 아니라 확인 필요
    const b = await bootstrap('nara-model-region-only.json');
    await saveProfile(b.page, b.app.baseUrl, { licenses: '조경식재공사업', regions: '경기, 서울' });
    const only = card(b.page, T_REGION);
    await only.waitFor();
    const onlyText = await only.innerText();
    assert.match(onlyText, /확인 필요/);
    assert.doesNotMatch(onlyText, /불가/);
  });
});
