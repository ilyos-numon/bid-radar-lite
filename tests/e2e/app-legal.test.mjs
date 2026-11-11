import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers/app.mjs';

// 기존 모드(가입 없이 한 회사): 푸터와 약관 화면
const cleanups = [];

describe('app legal', () => {
  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
  });

  it('app-legal: legacy mode shows footer and terms', { timeout: 60000 }, async () => {
    const app = await startApp({ env: { BUSINESS_NAME: '', BUSINESS_REP: '', BUSINESS_REG_NO: '', BUSINESS_MAIL_ORDER_NO: '', BUSINESS_ADDRESS: '', BUSINESS_EMAIL: '', BUSINESS_PHONE: '', PRIVACY_OFFICER: '' } });
    cleanups.push(() => app.stop());

    const welcome = await fetch(`${app.baseUrl}/welcome`);
    assert.equal(welcome.status, 200);
    const html = await welcome.text();
    assert.match(html, /<footer class="legal">/);
    assert.match(html, /사업자 정보 미설정/);
    assert.match(html, /href="\/terms"/);

    const terms = await fetch(`${app.baseUrl}/terms`);
    assert.equal(terms.status, 200);
    assert.match(await terms.text(), /<h1[^>]*>이용약관<\/h1>/);
    assert.equal((await fetch(`${app.baseUrl}/privacy`)).status, 200);
    assert.equal((await fetch(`${app.baseUrl}/terms-nope`)).status, 404);
  });
});
