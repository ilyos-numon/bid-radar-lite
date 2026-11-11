import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create as createNotify } from '../../app/core/notify.mjs';
import { createEmailSender, verifyUnsubscribeToken } from '../../app/core/email.mjs';
import { createEmailAlerts } from '../../app/core/email-alerts.mjs';
import { createRuntime } from '../../app/core/registry.mjs';
import { startMockEmail } from './helpers/mock-email.mjs';
import { createTestDb, WS_A } from './helpers/fake-platform.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SECRET = 'test-secret';
const APP = 'https://app.example.com';
const PAYLOAD = {
  kind: 'bids',
  date: '2026-11-04',
  count: 1,
  items: [{ title: '공원 조경 공사', deadline: '2026-11-10 18:00', budget: 50000000, reasons: ['키워드 조경'], url: 'https://example.com/b/1' }],
  maybe: null,
};

describe('email alerts', () => {
  let db;
  let mock;
  before(async () => {
    db = await createTestDb();
    await db.admin(readFileSync(path.join(ROOT, 'app/core/email/schema.sql'), 'utf8'));
    mock = await startMockEmail();
  });
  after(async () => {
    await mock.close();
    await db.close();
  });
  beforeEach(async () => {
    mock.requests.length = 0;
    mock.failNext = 0;
    await db.admin('DELETE FROM email_unsubscribes');
    await db.admin('DELETE FROM notification_deliveries');
  });

  function make({ emails = 'boss@example.com', env: extra = {}, limits } = {}) {
    const env = { APP_SECRET: SECRET, EMAIL_API_BASE: mock.url, EMAIL_API_KEY: 're_test', EMAIL_FROM: 'alerts@example.com', ...extra };
    const store = new Map([['notify_emails', emails]]);
    const settings = { get: async (k) => store.get(k) ?? null };
    const { notify } = createNotify({ db, env, now: () => new Date('2026-11-04T08:00:00Z'), fetch });
    const sender = createEmailSender({ env, fetch });
    const alerts = createEmailAlerts({ db, settings, notify, sender, limits, env, workspaceId: WS_A, appUrl: APP });
    const inWs = (fn) => db.withWorkspace(WS_A, fn);
    return { alerts, notify, inWs };
  }
  const deliveries = () => db.admin("SELECT kind, date, status, target_host, http_status, error_code FROM notification_deliveries ORDER BY kind");

  test('same (kind, date) twice → mock server gets 1 POST; recorded as `<kind>:email`', async () => {
    const { alerts, inWs } = make();
    const first = await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'daily:2026-11-04:a' }));
    assert.equal(first.sent, true);
    assert.equal(first.to, 1);
    const second = await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'daily:2026-11-04:b' }));
    assert.deepEqual(second, { sent: false, reason: 'already_delivered' });
    assert.equal(mock.requests.length, 1);
    const rows = (await deliveries()).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'bids:email');
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].target_host, new URL(mock.url).host);
    // 다른 날은 따로 보낸다
    assert.equal((await inWs(() => alerts.deliver({ payload: { ...PAYLOAD, date: '2026-11-05' }, runId: 'r' }))).sent, true);
    assert.equal(mock.requests.length, 2);
  });

  test('unsubscribed address is excluded from recipients and from sending', async () => {
    const { alerts, inWs } = make({ emails: 'boss@example.com,staff@example.com' });
    await alerts.unsubscribe('Staff@Example.com');
    await alerts.unsubscribe('staff@example.com');
    assert.deepEqual(await alerts.recipients(), ['boss@example.com']);
    const r = await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'r1' }));
    assert.equal(r.sent, true);
    assert.equal(r.to, 1);
    assert.deepEqual(mock.requests.map((q) => q.body.to), [['boss@example.com']]);
    // 모두 수신거부 → no_target, 기록 없음
    await alerts.unsubscribe('boss@example.com');
    assert.deepEqual(await inWs(() => alerts.deliver({ payload: { ...PAYLOAD, date: '2026-11-06' }, runId: 'r2' })), { sent: false, reason: 'no_target' });
    assert.equal((await deliveries()).rows.length, 1);
  });

  test('one mail per recipient with its own unsubscribe link and List-Unsubscribe header', async () => {
    const { alerts, inWs } = make({ emails: 'boss@example.com, staff@example.com' });
    await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'r' }));
    assert.equal(mock.requests.length, 2);
    for (const q of mock.requests) {
      const [email] = q.body.to;
      assert.equal(q.body.subject, '[입찰 레이더] 11/04 맞는 공고 1건');
      const m = /^<(.+)>$/.exec(q.body.headers['List-Unsubscribe']);
      assert.ok(m);
      const u = new URL(m[1]);
      assert.equal(u.origin + u.pathname, `${APP}/unsubscribe`);
      assert.equal(u.searchParams.get('ws'), WS_A);
      assert.equal(u.searchParams.get('e'), email);
      assert.equal(verifyUnsubscribeToken(SECRET, WS_A, email, u.searchParams.get('t')), true);
      assert.ok(q.body.text.endsWith(`수신거부: ${m[1]}`));
    }
  });

  test('send failure → failed record, retry sends again', async () => {
    const { alerts, inWs } = make();
    mock.failNext = 1;
    assert.deepEqual(await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'r1' })), { sent: false, reason: 'failed', status: 500 });
    let rows = (await deliveries()).rows;
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].error_code, 'http_500');
    assert.equal((await inWs(() => alerts.deliver({ payload: PAYLOAD, runId: 'r2' }))).sent, true);
    rows = (await deliveries()).rows;
    assert.equal(rows[0].status, 'sent');
    assert.equal(mock.requests.length, 2);
  });

  test('sender disabled or no addresses → no_target without POST or record', async () => {
    const off = make({ env: { EMAIL_API_KEY: '' } });
    assert.deepEqual(await off.inWs(() => off.alerts.deliver({ payload: PAYLOAD, runId: 'r' })), { sent: false, reason: 'no_target' });
    const none = make({ emails: '' });
    assert.deepEqual(await none.inWs(() => none.alerts.deliver({ payload: PAYLOAD, runId: 'r' })), { sent: false, reason: 'no_target' });
    assert.equal(mock.requests.length, 0);
    assert.equal((await deliveries()).rows.length, 0);
  });

  test('recipients are capped at the plan maximum', async () => {
    const limits = { max: async (kind) => (kind === 'emails' ? 2 : 0), check: async () => ({ ok: true, max: 2 }) };
    const { alerts } = make({ emails: 'a@example.com,b@example.com,c@example.com', limits });
    assert.deepEqual(await alerts.recipients(), ['a@example.com', 'b@example.com']);
  });

  test('notify.deliverVia: empty targetHost → no_target without record; thrown send → failed', async () => {
    const { notify, inWs } = make();
    let called = 0;
    const send = async () => {
      called += 1;
      return { ok: true };
    };
    assert.deepEqual(await inWs(() => notify.deliverVia({ kind: 'x:email', date: '2026-11-04', runId: 'r', targetHost: '', send })), { sent: false, reason: 'no_target' });
    assert.deepEqual(await inWs(() => notify.deliverVia({ kind: 'x:email', date: '2026-11-04', runId: 'r', targetHost: null, send })), { sent: false, reason: 'no_target' });
    assert.equal(called, 0);
    assert.equal((await deliveries()).rows.length, 0);
    const boom = async () => {
      throw Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
    };
    assert.deepEqual(await inWs(() => notify.deliverVia({ kind: 'y:email', date: '2026-11-04', runId: 'r', targetHost: 'h.test', send: boom })), { sent: false, reason: 'failed' });
    assert.equal((await deliveries()).rows[0].error_code, 'ETIMEDOUT');
    assert.deepEqual(await inWs(() => notify.deliverVia({ kind: 'y:email', date: '2026-11-04', runId: 'r', targetHost: 'h.test', send })), { sent: true });
  });
});

describe('settings screen: notify emails', () => {
  const tmp = [];
  const runtimes = [];
  after(async () => {
    for (const r of runtimes) await r.close();
    for (const d of tmp) rmSync(d, { recursive: true, force: true });
  });

  async function rt(env = {}) {
    const modulesDir = mkdtempSync(path.join(tmpdir(), 'br-email-'));
    tmp.push(modulesDir);
    symlinkSync(path.join(ROOT, 'app/modules/settings'), path.join(modulesDir, 'settings'), 'dir');
    const r = await createRuntime({
      dbPath: ':memory:',
      modulesDir,
      secret: 'x',
      jobToken: 't',
      env: { NARA_API_KEY: 'dummy-key', NARA_API_BASE: 'http://nara.test/svc', ...env },
      fetchImpl: async () => new Response('{}'),
      fakeNow: '2026-11-04',
    });
    runtimes.push(r);
    return r;
  }
  const req = (r, url, init = {}) => r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
  async function login(r) {
    const res = await req(r, '/setup', { method: 'POST', body: new URLSearchParams({ company: '테스트 조경', name: '대표' }) });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  }
  const form = (notifyEmails) =>
    new URLSearchParams({ keywords: '조경', regions: '', excludeKeywords: '', budgetMin: '0', budgetMax: '500000000', webhookUrl: '', notifyEmails });

  test('page shows the email field, plan hint and "not ready" note when EMAIL_API_KEY is empty', async () => {
    const r = await rt();
    const cookie = await login(r);
    const html = await (await req(r, '/settings', { headers: { cookie } })).text();
    assert.match(html, /<input id="notifyEmails" name="notifyEmails"/);
    assert.ok(html.includes('알림 받을 이메일'));
    assert.ok(html.includes('요금제에 따라 5개까지'));
    assert.ok(html.includes('이메일 발송이 준비되지 않았습니다(운영자 설정 필요)'));
    const ready = await rt({ EMAIL_API_KEY: 're_test' });
    const html2 = await (await req(ready, '/settings', { headers: { cookie: await login(ready) } })).text();
    assert.ok(!html2.includes('이메일 발송이 준비되지 않았습니다'));
  });

  test('saving stores lowercase deduped list and shows it again', async () => {
    const r = await rt();
    const cookie = await login(r);
    const res = await req(r, '/settings', { method: 'POST', headers: { cookie }, body: form('Boss@Example.com, staff@example.com, boss@example.com') });
    assert.equal(res.status, 303);
    assert.equal(await r.ctx.settings.get('notify_emails'), 'boss@example.com,staff@example.com');
    const html = await (await req(r, '/settings', { headers: { cookie } })).text();
    assert.match(html, /id="notifyEmails"[^>]*value="boss@example.com, staff@example.com"/);
  });

  test('emails over the plan limit → 400 with the PLAN_LIMIT message, nothing saved', async () => {
    const r = await rt();
    const cookie = await login(r);
    const message = '알림 이메일은(는) 무료 체험 요금제에서 2개까지입니다. 요금제를 올리면 더 쓸 수 있습니다.';
    const checks = [];
    r.ctx.limits = {
      check: async (kind, n) => {
        checks.push([kind, n]);
        return n > 2 ? { ok: false, code: 'PLAN_LIMIT', kind, max: 2, plan: 'trial', message } : { ok: true, max: 2 };
      },
      max: async () => 2,
    };
    const res = await req(r, '/settings', { method: 'POST', headers: { cookie }, body: form('a@example.com,b@example.com,c@example.com') });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.ok(html.includes(message));
    assert.match(html, /id="notifyEmails"[^>]*aria-invalid="true"/);
    assert.ok(html.includes('요금제에 따라 2개까지'));
    assert.deepEqual(checks, [['emails', 3]]);
    assert.equal(await r.ctx.settings.get('notify_emails'), null);
    // 한도 안이면 저장
    assert.equal((await req(r, '/settings', { method: 'POST', headers: { cookie }, body: form('a@example.com,b@example.com') })).status, 303);
    assert.equal(await r.ctx.settings.get('notify_emails'), 'a@example.com,b@example.com');
  });

  test('without plan limits the cap is 5 addresses', async () => {
    const r = await rt();
    const cookie = await login(r);
    const six = Array.from({ length: 6 }, (_, i) => `u${i}@example.com`).join(',');
    const res = await req(r, '/settings', { method: 'POST', headers: { cookie }, body: form(six) });
    assert.equal(res.status, 400);
    assert.ok((await res.text()).includes('알림 이메일은 5개까지입니다.'));
    assert.equal(await r.ctx.settings.get('notify_emails'), null);
  });
});
