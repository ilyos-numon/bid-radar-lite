// Legal notices: business info footer, terms/privacy texts, consents store, migration sync.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { BUSINESS_FIELDS, UNSET, businessInfo, footerHtml } from '../../app/core/legal/business.mjs';
import { LEGAL_DEFAULT_VERSION, versions, termsHtml, privacyHtml } from '../../app/core/legal/texts.mjs';
import { CONSENT_FIELDS, createConsents } from '../../app/core/legal/consent.mjs';
import { createLegalPages } from '../../app/core/legal/pages.mjs';
import { createHtml } from '../../app/core/html.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA = readFileSync(path.join(ROOT, 'app/core/legal/schema.sql'), 'utf8');
const USER = '11111111-2222-4333-8444-555555555555';

const lites = [];
after(async () => {
  for (const l of lites) if (!l.closed) await l.close();
});

async function liteDb() {
  const lite = await PGlite.create();
  lites.push(lite);
  await lite.exec(SCHEMA);
  return {
    lite,
    admin: async (text, params = []) => {
      const r = await lite.query(text, params);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  };
}

const FULL = {
  BUSINESS_NAME: '예시상호',
  BUSINESS_REP: '예시대표',
  BUSINESS_REG_NO: '000-00-00000',
  BUSINESS_MAIL_ORDER_NO: '제0000-예시-0000호',
  BUSINESS_ADDRESS: '예시시 예시구',
  BUSINESS_EMAIL: 'help@example.com',
  BUSINESS_PHONE: '000-0000-0000',
  PRIVACY_OFFICER: '예시책임자',
};

describe('legal: business info', () => {
  test('fields list matches contract', () => {
    assert.deepEqual(BUSINESS_FIELDS, Object.keys(FULL));
  });

  test('empty env → every field UNSET, configured false', () => {
    const b = businessInfo({});
    for (const k of ['name', 'rep', 'regNo', 'mailOrderNo', 'address', 'email', 'phone', 'privacyOfficer']) assert.equal(b[k], UNSET);
    assert.equal(b.configured, false);
    assert.equal(businessInfo({ BUSINESS_NAME: '   ' }).name, UNSET);
  });

  test('full env → values and configured true', () => {
    const b = businessInfo(FULL);
    assert.equal(b.name, '예시상호');
    assert.equal(b.privacyOfficer, '예시책임자');
    assert.equal(b.configured, true);
  });

  test('footer shows BUSINESS_NAME and links; escapes values', () => {
    const f = footerHtml({ ...FULL, BUSINESS_NAME: '<b>상호</b>' });
    assert.match(f, /^<footer class="legal">/);
    assert.ok(f.includes('상호 &lt;b&gt;상호&lt;/b&gt;'));
    assert.ok(!f.includes('<b>'));
    assert.ok(f.includes('<a href="/terms">이용약관</a>'));
    assert.ok(f.includes('<a href="/privacy">개인정보처리방침</a>'));
    assert.ok(!f.includes('사업자 정보 미설정'));
    assert.ok(f.includes('help@example.com'));
  });

  test('footer with empty env shows 사업자 정보 미설정', () => {
    const f = footerHtml({});
    assert.ok(f.includes('사업자 정보 미설정'));
    assert.ok(f.includes(`상호 ${UNSET}`));
  });
});

describe('legal: texts', () => {
  test('versions default and override', () => {
    assert.equal(LEGAL_DEFAULT_VERSION, '2026-11-03');
    assert.deepEqual(versions({}), { terms: LEGAL_DEFAULT_VERSION, privacy: LEGAL_DEFAULT_VERSION });
    assert.deepEqual(versions({ LEGAL_TERMS_VERSION: '2027-01-01' }), { terms: '2027-01-01', privacy: LEGAL_DEFAULT_VERSION });
  });

  test('terms: required sections, business substitution, draft notice toggle', () => {
    const t = termsHtml(FULL);
    for (const h of ['목적', '정의', '이용계약의 성립', '요금과 결제', '서비스의 변경', '책임의 제한', '준거법']) assert.ok(t.includes(h), h);
    assert.ok(t.includes('정기결제'));
    assert.ok(t.includes('기간이 끝나는 날'));
    assert.ok(t.includes('환불하지 않습니다'));
    assert.ok(t.includes('예시상호'));
    assert.ok(t.includes('초안 — 시행 전 법률 검토 필요'));
    assert.ok(!termsHtml({ LEGAL_DRAFT_NOTICE: '0' }).includes('초안 — 시행 전 법률 검토 필요'));
    assert.ok(termsHtml({}).includes(UNSET));
  });

  test('privacy: required items', () => {
    const p = privacyHtml(FULL);
    for (const w of ['이메일', '비밀번호', '이름', '회사 이름', '카드번호를 보관하지 않습니다', '처리 목적', '탈퇴', '5년', '처리 위탁', '결제 대행', '이메일 발송', '클라우드', '수신거부', '개인정보 보호책임자 예시책임자']) {
      assert.ok(p.includes(w), w);
    }
  });
});

describe('legal: consents store', () => {
  test('record writes 2 rows at current versions with hashed ip and cut user agent', async () => {
    const db = await liteDb();
    const c = createConsents({ db, env: { APP_TRUST_PROXY: '1' }, now: () => new Date('2026-11-03T00:00:00Z') });
    const req = new Request('http://localhost/', { headers: { 'x-forwarded-for': 'client-a', 'user-agent': 'x'.repeat(300) } });
    await c.record({ userId: USER, email: 'a@example.com', req });
    const rows = (await db.admin('SELECT * FROM consents ORDER BY doc')).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.doc, r.version]), [['privacy', LEGAL_DEFAULT_VERSION], ['terms', LEGAL_DEFAULT_VERSION]]);
    assert.match(rows[0].ip_hash, /^[0-9a-f]{16}$/);
    assert.notEqual(rows[0].ip_hash, 'client-a');
    assert.equal(rows[0].user_agent.length, 100);
    assert.equal(new Date(rows[0].agreed_at).toISOString(), '2026-11-03T00:00:00.000Z');
  });

  test('latest / needsReconsent follow versions(env)', async () => {
    const db = await liteDb();
    const old = createConsents({ db, env: {} });
    assert.deepEqual(await old.latest(USER), { terms: null, privacy: null });
    assert.equal(await old.needsReconsent(USER), true, 'never agreed');
    await old.record({ userId: USER, email: 'a@example.com', req: new Request('http://localhost/') });
    assert.equal(await old.needsReconsent(USER), false);
    const bumped = createConsents({ db, env: { LEGAL_PRIVACY_VERSION: '2027-02-01' } });
    assert.equal(await bumped.needsReconsent(USER), true);
    await bumped.record({ userId: USER, email: 'a@example.com', req: new Request('http://localhost/') });
    assert.deepEqual(await bumped.latest(USER), { terms: LEGAL_DEFAULT_VERSION, privacy: '2027-02-01' });
    assert.equal(await bumped.needsReconsent(USER), false);
  });

  test('non-uuid user id: stored without user_id, never asks again', async () => {
    const db = await liteDb();
    const c = createConsents({ db, env: {} });
    await c.record({ userId: 'user-a', email: 'a@example.com', req: new Request('http://localhost/') });
    const rows = (await db.admin('SELECT user_id FROM consents')).rows;
    assert.deepEqual(rows.map((r) => r.user_id), [null, null]);
    assert.equal(await c.needsReconsent('user-a'), false);
  });

  test('ensureVersions upserts once', async () => {
    const db = await liteDb();
    const c = createConsents({ db, env: { LEGAL_TERMS_VERSION: '2027-01-01' } });
    await c.ensureVersions();
    await c.ensureVersions();
    const rows = (await db.admin('SELECT doc, version FROM legal_versions ORDER BY doc')).rows;
    assert.deepEqual(rows, [{ doc: 'privacy', version: LEGAL_DEFAULT_VERSION }, { doc: 'terms', version: '2027-01-01' }]);
  });

  test('field names', () => {
    assert.deepEqual(CONSENT_FIELDS, { terms: 'agree_terms', privacy: 'agree_privacy' });
  });
});

describe('legal: pages', () => {
  const html = createHtml({ menus: () => [], env: FULL });
  const pages = createLegalPages({ env: FULL, html });

  test('terms and privacy render bare pages with footer', async () => {
    const t = await pages.terms();
    assert.equal(t.status, 200);
    const th = await t.text();
    assert.match(th, /<h1>이용약관<\/h1>/);
    assert.match(th, /<footer class="legal">/);
    assert.ok(th.includes('상호 예시상호'));
    const p = await (await pages.privacy()).text();
    assert.match(p, /<h1>개인정보처리방침<\/h1>/);
  });

  test('consent form has two checks; error → 400', async () => {
    const ok = await pages.consent({});
    assert.equal(ok.status, 200);
    const h = await ok.text();
    assert.match(h, /method="post" action="\/consent"/);
    assert.match(h, /name="agree_terms" value="1"/);
    assert.match(h, /name="agree_privacy" value="1"/);
    const bad = await pages.consent({ error: true });
    assert.equal(bad.status, 400);
    assert.match(await bad.text(), /class="error"/);
  });
});

describe('legal: migration', () => {
  test('20261104000002_legal.sql contains schema.sql body and grants', () => {
    const mig = readFileSync(path.join(ROOT, 'supabase/migrations/20261104000002_legal.sql'), 'utf8');
    assert.ok(mig.includes(SCHEMA.trim()), 'schema.sql body included verbatim');
    assert.match(mig, /revoke all on public\.consents from public, anon, authenticated/);
    assert.match(mig, /revoke all on public\.legal_versions from public, anon, authenticated/);
    assert.match(mig, /grant [a-z, ]+ on public\.consents to app_worker/);
    assert.match(mig, /grant [a-z, ]+ on public\.legal_versions to app_worker/);
    assert.match(mig, /sequence public\.consents_id_seq to app_worker/);
  });
});
