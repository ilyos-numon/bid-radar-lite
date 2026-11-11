import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { shot } from './helpers/app.mjs';
import { SB, skipIfDown, startSbApp, randomEmail, latestMailLink, withOrigin, adminDbUrl, withPg } from './helpers/supabase.mjs';

// Supabase 모드 약관: 동의 없이는 가입 불가, 동의하면 2건 기록, 약관 화면과 푸터
const PASSWORD = 'e2e-password-1';
const VERSION = '2026-11-03';

let browser;
const cleanups = [];
const consentEmails = [];

const consentsOf = (email) =>
  withPg(adminDbUrl(), async (c) => (await c.query('SELECT doc, version, email FROM public.consents WHERE email = $1 ORDER BY doc', [email])).rows);

describe('sb legal', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
    // 동의 기록은 사용자 FK 가 없어 계정 삭제로 지워지지 않는다. 이 테스트가 만든 것만 지운다
    if (SB.up && consentEmails.length > 0) await withPg(adminDbUrl(), (c) => c.query('DELETE FROM public.consents WHERE email = ANY($1)', [consentEmails])).catch(() => {});
  });

  it('sb-legal: signup requires consent and records two rows', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await startSbApp({ env: { BUSINESS_NAME: '예시 상사' } });
    cleanups.push(() => app.stop());
    const email = randomEmail('lgsn');
    consentEmails.push(email);

    // 동의 없이 보내면 400 과 안내 문구, 계정도 기록도 없다
    const refuse = async (extra) =>
      fetch(`${app.baseUrl}/signup`, withOrigin(app.baseUrl, { method: 'POST', body: new URLSearchParams({ email, password: PASSWORD, name: '동의', ...extra }), redirect: 'manual' }));
    for (const extra of [{}, { agree_terms: '1' }, { agree_privacy: '1' }]) {
      const res = await refuse(extra);
      assert.equal(res.status, 400, `fields ${Object.keys(extra)}`);
      assert.match(await res.text(), /이용약관과 개인정보 수집·이용에 모두 동의해야 가입할 수 있습니다/);
    }
    assert.deepEqual(await consentsOf(email), []);

    // 브라우저: 체크박스 2개와 약관 링크, 체크하고 가입
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    cleanups.push(() => context.close());
    const page = await context.newPage();
    await page.goto(`${app.baseUrl}/signup`);
    const boxes = page.locator('input[type=checkbox][name^=agree_]');
    assert.equal(await boxes.count(), 2);
    assert.equal(await page.locator('fieldset.consents a[href="/terms"]').count(), 1);
    assert.equal(await page.locator('fieldset.consents a[href="/privacy"]').count(), 1);
    await page.getByLabel('이메일').fill(email);
    await page.getByLabel('비밀번호').fill(PASSWORD);
    await page.getByLabel('내 이름').fill('동의');
    await page.locator('input[name=agree_terms]').check();
    await page.locator('input[name=agree_privacy]').check();
    await shot(page, 'signup-consent');
    await page.locator('main form button[type=submit]').click();
    await page.waitForURL(/\/verify-notice\?/);

    await page.goto(await latestMailLink(email, { subjectIncludes: '가입 확인' }));
    await page.waitForURL(`${app.baseUrl}/workspaces/new`);

    const rows = await consentsOf(email);
    assert.deepEqual(rows.map((r) => [r.doc, r.version]), [['privacy', VERSION], ['terms', VERSION]]);
  });

  it('sb-legal: terms and privacy pages render with footer', { skip: skipIfDown, timeout: 120000 }, async () => {
    const app = await startSbApp({ env: { BUSINESS_NAME: '예시 상사' } });
    cleanups.push(() => app.stop());
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    cleanups.push(() => context.close());
    const page = await context.newPage();

    const terms = await page.goto(`${app.baseUrl}/terms`);
    assert.equal(terms.status(), 200);
    assert.equal(await page.locator('h1').first().innerText(), '이용약관');
    const footer = await page.locator('footer.legal').innerText();
    assert.match(footer, /예시 상사/);
    assert.match(footer, /미설정/, 'unset business fields are marked');
    assert.equal(await page.locator('footer.legal a[href="/terms"]').count(), 1);
    assert.equal(await page.locator('footer.legal a[href="/privacy"]').count(), 1);
    await shot(page, 'terms-footer');

    const privacy = await page.goto(`${app.baseUrl}/privacy`);
    assert.equal(privacy.status(), 200);
    assert.equal(await page.locator('h1').first().innerText(), '개인정보처리방침');
    assert.match(await page.locator('footer.legal').innerText(), /예시 상사/);

    // 로그인 없이 열린다 (리다이렉트 없이 바로 200)
    assert.equal((await fetch(`${app.baseUrl}/terms`, { redirect: 'manual' })).status, 200);
  });
});
