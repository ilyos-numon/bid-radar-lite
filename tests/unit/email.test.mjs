import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import {
  createEmailSender,
  unsubscribeToken,
  verifyUnsubscribeToken,
  unsubscribeUrl,
  renderDigestEmail,
  parseEmails,
  NOTIFY_EMAILS_KEY,
  EMAIL_KIND_SUFFIX,
} from '../../app/core/email.mjs';
import { registerUnsubscribeRoutes, UNSUB_TEXT } from '../../app/core/email-routes.mjs';
import { createHtml } from '../../app/core/html.mjs';
import { startMockEmail } from './helpers/mock-email.mjs';
import { createTestDb, WS_A } from './helpers/fake-platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'test-secret';

describe('email sender', () => {
  let mock;
  before(async () => {
    mock = await startMockEmail();
  });
  after(() => mock.close());
  const env = () => ({ EMAIL_API_BASE: mock.url, EMAIL_API_KEY: 're_test', EMAIL_FROM: '입찰 레이더 <alerts@example.com>' });

  test('enabled only when EMAIL_API_KEY and EMAIL_FROM are set; disabled send does not POST', async () => {
    assert.equal(createEmailSender({ env: {}, fetch }).enabled, false);
    assert.equal(createEmailSender({ env: { EMAIL_API_KEY: 'k' }, fetch }).enabled, false);
    assert.equal(createEmailSender({ env: { EMAIL_FROM: 'a@b.co' }, fetch }).enabled, false);
    assert.equal(createEmailSender({ env: env(), fetch }).enabled, true);
    const before = mock.requests.length;
    const r = await createEmailSender({ env: { EMAIL_API_BASE: mock.url }, fetch }).send({ to: ['a@b.co'], subject: 's', text: 't', html: 'h' });
    assert.equal(r.ok, false);
    assert.equal(mock.requests.length, before);
  });

  test('send POSTs /emails with Bearer key and from/to/subject/text/html/headers', async () => {
    const sender = createEmailSender({ env: env(), fetch });
    const r = await sender.send({ to: ['a@b.co'], subject: '제목', text: '본문', html: '<p>본문</p>', headers: { 'List-Unsubscribe': '<http://x/u>' } });
    assert.equal(r.ok, true);
    assert.match(r.id, /^mock-email-\d+$/);
    const req = mock.requests.at(-1);
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/emails');
    assert.equal(req.headers.authorization, 'Bearer re_test');
    assert.deepEqual(req.body, {
      from: '입찰 레이더 <alerts@example.com>',
      to: ['a@b.co'],
      subject: '제목',
      text: '본문',
      html: '<p>본문</p>',
      headers: { 'List-Unsubscribe': '<http://x/u>' },
    });
  });

  test('server error → { ok:false, status, code }; network error → { ok:false, code }', async () => {
    mock.failNext = 1;
    assert.deepEqual(await createEmailSender({ env: env(), fetch }).send({ to: ['a@b.co'], subject: 's', text: 't', html: 'h' }), {
      ok: false,
      status: 500,
      code: 'http_500',
    });
    const broken = async () => {
      throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    };
    assert.deepEqual(await createEmailSender({ env: env(), fetch: broken }).send({ to: ['a@b.co'], subject: 's', text: 't', html: 'h' }), {
      ok: false,
      code: 'ECONNREFUSED',
    });
  });

  test('default API base is api.resend.com', async () => {
    const calls = [];
    const f = async (url) => {
      calls.push(url);
      return new Response('{"id":"x"}', { status: 200 });
    };
    await createEmailSender({ env: { EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.co' }, fetch: f }).send({ to: ['c@d.co'], subject: 's', text: 't', html: 'h' });
    assert.deepEqual(calls, ['https://api.resend.com/emails']);
  });
});

describe('unsubscribe token', () => {
  test('43-char base64url, email is case-insensitive, verifies', () => {
    const t = unsubscribeToken(SECRET, WS_A, 'Boss@Example.com');
    assert.equal(t.length, 43);
    assert.match(t, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(t, unsubscribeToken(SECRET, WS_A, 'boss@example.com'));
    assert.equal(verifyUnsubscribeToken(SECRET, WS_A, 'boss@example.com', t), true);
  });

  test('forged or mismatched tokens are rejected', () => {
    const t = unsubscribeToken(SECRET, WS_A, 'boss@example.com');
    assert.equal(verifyUnsubscribeToken(SECRET, WS_A, 'other@example.com', t), false);
    assert.equal(verifyUnsubscribeToken('other-secret', WS_A, 'boss@example.com', t), false);
    assert.equal(verifyUnsubscribeToken(SECRET, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'boss@example.com', t), false);
    assert.equal(verifyUnsubscribeToken(SECRET, WS_A, 'boss@example.com', t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A')), false);
    assert.equal(verifyUnsubscribeToken(SECRET, WS_A, 'boss@example.com', 'short'), false);
    assert.equal(verifyUnsubscribeToken(SECRET, WS_A, 'boss@example.com', ''), false);
    assert.equal(verifyUnsubscribeToken(SECRET, WS_A, 'boss@example.com', undefined), false);
  });

  test('unsubscribeUrl encodes the email', () => {
    assert.equal(
      unsubscribeUrl('https://app.example.com', { workspaceId: WS_A, email: 'a+b@c.co', token: 'TOK' }),
      `https://app.example.com/unsubscribe?ws=${WS_A}&e=a%2Bb%40c.co&t=TOK`,
    );
  });
});

describe('renderDigestEmail', () => {
  const unsub = 'https://app.example.com/unsubscribe?ws=w&e=a%40b.co&t=T';
  const bids = {
    kind: 'bids',
    date: '2026-11-04',
    count: 1,
    items: [{ title: '공원 <조경> 공사', deadline: '2026-11-10 18:00', budget: 50000000, reasons: ['키워드 조경'], url: 'https://example.com/b/1' }],
    maybe: null,
  };

  test('subjects for bids · reminder · support (count falls back to items.length)', () => {
    assert.equal(renderDigestEmail({ kind: 'bids', date: '2026-11-04', text: bids, unsubscribeUrl: unsub }).subject, '[입찰 레이더] 11/04 맞는 공고 1건');
    assert.equal(
      renderDigestEmail({ kind: 'reminder', date: '2026-11-04', text: { kind: 'reminder', date: '2026-11-04', items: [{ title: 'a', deadline: 'd' }, { title: 'b', deadline: 'd' }] }, unsubscribeUrl: unsub }).subject,
      '[입찰 레이더] 11/04 마감 임박 2건',
    );
    assert.equal(
      renderDigestEmail({ kind: 'support', date: '2026-11-04', text: { kind: 'support', date: '2026-11-04', count: 3, items: [] }, unsubscribeUrl: unsub }).subject,
      '[입찰 레이더] 11/04 새 지원사업 3건',
    );
  });

  test('text = notify render + unsubscribe line; html wraps escaped body in <pre> with link', () => {
    const m = renderDigestEmail({ kind: 'bids', date: '2026-11-04', text: bids, appUrl: 'https://app.example.com', unsubscribeUrl: unsub });
    assert.ok(m.text.includes('공원 <조경> 공사'));
    assert.ok(m.text.includes('설정 바꾸기: https://app.example.com/settings'));
    assert.ok(m.text.endsWith(`\n\n수신거부: ${unsub}`));
    assert.match(m.html, /^<pre[^>]*>/);
    assert.ok(m.html.includes('공원 &lt;조경&gt; 공사'));
    assert.ok(!m.html.includes('<조경>'));
    assert.ok(m.html.includes(`<a href="${unsub.replace(/&/g, '&amp;')}">수신거부</a>`));
  });
});

describe('parseEmails and constants', () => {
  test('lowercase, dedupe, drop invalid', () => {
    assert.deepEqual(parseEmails(' Boss@Example.com, staff@example.com,boss@example.com, nope, a@b, , x y@z.co '), ['boss@example.com', 'staff@example.com']);
    assert.deepEqual(parseEmails(''), []);
    assert.deepEqual(parseEmails(null), []);
    assert.equal(NOTIFY_EMAILS_KEY, 'notify_emails');
    assert.equal(EMAIL_KIND_SUFFIX, ':email');
  });
});

describe('email migration', () => {
  test('20261104000001_email.sql contains app/core/email/schema.sql body plus FK, revoke and grant', () => {
    const schema = readFileSync(path.join(ROOT, 'app/core/email/schema.sql'), 'utf8');
    const mig = readFileSync(path.join(ROOT, 'supabase/migrations/20261104000001_email.sql'), 'utf8');
    const body = schema.slice(schema.indexOf('CREATE TABLE')).trim();
    assert.ok(body.startsWith('CREATE TABLE IF NOT EXISTS email_unsubscribes'));
    assert.ok(mig.includes(body), 'migration must include schema.sql body verbatim');
    assert.match(mig, /foreign key \(workspace_id\) references public\.workspaces\(id\) on delete cascade/);
    assert.match(mig, /revoke all on public\.email_unsubscribes from public, anon, authenticated;/);
    assert.match(mig, /grant select, insert, update, delete on public\.email_unsubscribes to app_worker;/);
    assert.doesNotMatch(mig, /row level security/i);
  });
});

describe('unsubscribe route', () => {
  let db;
  before(async () => {
    db = await createTestDb();
    await db.admin(readFileSync(path.join(ROOT, 'app/core/email/schema.sql'), 'utf8'));
  });
  after(() => db.close());
  const rows = async () => (await db.admin('SELECT workspace_id, email FROM email_unsubscribes ORDER BY email')).rows;
  const html = createHtml({ menus: () => [] });
  const env = { APP_SECRET: SECRET };

  test('Hono: valid link records the address and shows 200; forged token → 400 without a row', async () => {
    await db.admin('DELETE FROM email_unsubscribes');
    const app = new Hono();
    registerUnsubscribeRoutes(app, { env, db, html });
    const t = unsubscribeToken(SECRET, WS_A, 'boss@example.com');
    const forged = await app.request(`/unsubscribe?ws=${WS_A}&e=boss%40example.com&t=${'A'.repeat(43)}`);
    assert.equal(forged.status, 400);
    assert.ok((await forged.text()).includes(UNSUB_TEXT.bad));
    assert.deepEqual(await rows(), []);
    const res = await app.request(`/unsubscribe?ws=${WS_A}&e=Boss%40example.com&t=${t}`);
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.ok(page.includes('더 이상 보내지 않습니다'));
    assert.ok(page.includes('class="bare"'));
    assert.deepEqual(await rows(), [{ workspace_id: WS_A, email: 'boss@example.com' }]);
    // 두 번 눌러도 200, 한 줄
    assert.equal((await app.request(`/unsubscribe?ws=${WS_A}&e=boss%40example.com&t=${t}`)).status, 200);
    assert.equal((await rows()).length, 1);
  });

  test('bad workspace id, missing params or missing APP_SECRET → 400', async () => {
    await db.admin('DELETE FROM email_unsubscribes');
    const app = new Hono();
    registerUnsubscribeRoutes(app, { env, db, html });
    const t = unsubscribeToken(SECRET, 'not-a-uuid', 'boss@example.com');
    assert.equal((await app.request(`/unsubscribe?ws=not-a-uuid&e=boss%40example.com&t=${t}`)).status, 400);
    assert.equal((await app.request('/unsubscribe')).status, 400);
    const noSecret = new Hono();
    registerUnsubscribeRoutes(noSecret, { env: {}, db });
    const t2 = unsubscribeToken('', WS_A, 'boss@example.com');
    const res = await noSecret.request(`/unsubscribe?ws=${WS_A}&e=boss%40example.com&t=${t2}`);
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.deepEqual(await rows(), []);
  });

  test('internal router style: handler gets a Request', async () => {
    await db.admin('DELETE FROM email_unsubscribes');
    const handlers = {};
    registerUnsubscribeRoutes({ get: (p, h) => (handlers[p] = h) }, { env, db, html });
    const t = unsubscribeToken(SECRET, WS_A, 'staff@example.com');
    const res = await handlers['/unsubscribe'](new Request(`http://localhost/unsubscribe?ws=${WS_A}&e=staff%40example.com&t=${t}`));
    assert.equal(res.status, 200);
    assert.deepEqual(await rows(), [{ workspace_id: WS_A, email: 'staff@example.com' }]);
  });
});
