// GET /settings/mail-preview: 오늘 보낼 알림 메일 3종을 보내지 않고 보여 준다
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { startMockEmail } from './helpers/mock-email.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoots = [];

function modulesDir(names) {
  const d = mkdtempSync(path.join(tmpdir(), 'br-mailpv-'));
  tmpRoots.push(d);
  for (const n of names) symlinkSync(path.join(ROOT, 'app/modules', n), path.join(d, n), 'dir');
  return d;
}

let fetchCalls = 0;
const noNetwork = async () => {
  fetchCalls += 1;
  throw new Error('network is not allowed in unit tests');
};

const BIDS_PAYLOAD = {
  kind: 'bids',
  date: '2026-11-04',
  count: 1,
  items: [{ bidId: 'B-1', title: '공원 <조경> 공사', deadline: '2026-11-10 18:00', budget: 50000000, reasons: ['키워드 조경'], url: 'https://example.com/b/1' }],
  maybe: null,
};

describe('settings mail preview', () => {
  let mock;
  before(async () => {
    mock = await startMockEmail();
  });
  after(async () => {
    await mock.close();
    for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
  });
  beforeEach(() => {
    mock.requests.length = 0;
    fetchCalls = 0;
  });

  async function rt() {
    const env = { APP_BASE_URL: 'https://app.example.com', EMAIL_API_BASE: mock.url, EMAIL_API_KEY: 're_test', EMAIL_FROM: 'alerts@example.com' };
    const r = await createRuntime({
      dbPath: ':memory:',
      modulesDir: modulesDir(['settings', 'interest']),
      secret: 'x',
      jobToken: 't',
      env,
      fetchImpl: noNetwork,
      fakeNow: '2026-11-04',
    });
    let deliverCalls = 0;
    const deliver = r.ctx.emailAlerts.deliver;
    r.ctx.emailAlerts.deliver = async (...a) => {
      deliverCalls += 1;
      return deliver(...a);
    };
    return { r, deliverCalls: () => deliverCalls };
  }
  const req = (r, url, init = {}) => r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
  async function setup(r) {
    const res = await req(r, '/setup', { method: 'POST', body: new URLSearchParams({ company: '테스트 조경', name: '대표' }) });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  }
  const get = (r, url, cookie) => req(r, url, { headers: { cookie } });
  const deliveries = async (r) => Number((await r.ctx.db.get('SELECT COUNT(*) AS n FROM notification_deliveries')).n);
  const notifications = async (r) => Number((await r.ctx.db.get('SELECT COUNT(*) AS n FROM notifications')).n);

  test('needs sign-in', async () => {
    const { r } = await rt();
    try {
      const res = await req(r, '/settings/mail-preview');
      assert.notEqual(res.status, 200);
    } finally {
      await r.close?.();
    }
  });

  test('three sections with real jobs (dry): nothing sent, nothing recorded', async () => {
    const { r, deliverCalls } = await rt();
    try {
      const cookie = await setup(r);
      await r.ctx.settings.set('notify_emails', 'boss@example.com,staff@example.com');
      const res = await get(r, '/settings/mail-preview', cookie);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('<title>오늘 보낼 메일 미리보기'), 'page title');
      for (const label of ['오늘의 공고', '마감 알림', '지원사업']) assert.ok(html.includes(label), label);
      assert.equal((html.match(/<section class="mail-preview[ "]/g) || []).length, 3);
      assert.ok(html.includes('boss@example.com'));
      assert.ok(html.includes('staff@example.com'));
      assert.equal(mock.requests.length, 0, 'no mail request');
      assert.equal(deliverCalls(), 0, 'no deliver call');
      assert.equal(await deliveries(r), 0, 'no notification_deliveries row');
      assert.equal(await notifications(r), 0, 'no notification recorded');
      assert.equal(fetchCalls, 0, 'no network');
    } finally {
      await r.close?.();
    }
  });

  test('payload → subject and sandboxed iframe; empty and failing jobs → nothing to send', async () => {
    const { r, deliverCalls } = await rt();
    try {
      const cookie = await setup(r);
      const seen = [];
      r.ctx.jobs.runDaily = async (o) => {
        seen.push(['daily', o]);
        return BIDS_PAYLOAD;
      };
      r.ctx.jobs.runReminders = async (o) => {
        seen.push(['reminders', o]);
        return null;
      };
      r.ctx.jobs.runSupport = async (o) => {
        seen.push(['support', o]);
        throw new Error('boom');
      };
      const res = await get(r, '/settings/mail-preview', cookie);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.deepEqual(seen, [
        ['daily', { date: '2026-11-04', dry: true }],
        ['reminders', { date: '2026-11-04', dry: true }],
        ['support', { date: '2026-11-04', dry: true }],
      ]);
      assert.ok(html.includes('[입찰 레이더] 11/04 맞는 공고 1건'), 'subject');
      const frames = html.match(/<iframe [^>]*>/g) || [];
      assert.equal(frames.length, 1);
      assert.match(frames[0], /sandbox=""/);
      assert.match(frames[0], /srcdoc="[^"]*공원 &amp;lt;조경&amp;gt; 공사/);
      assert.ok(!frames[0].includes('<조경>'));
      assert.equal((html.match(/보낼 내용 없음/g) || []).length, 2);
      assert.ok(html.includes('받는 사람이 없습니다'));
      assert.equal(mock.requests.length, 0);
      assert.equal(deliverCalls(), 0);
      assert.equal(await deliveries(r), 0);
    } finally {
      await r.close?.();
    }
  });

  test('zero-count payload counts as nothing to send', async () => {
    const { r } = await rt();
    try {
      const cookie = await setup(r);
      r.ctx.jobs.runDaily = async () => ({ ...BIDS_PAYLOAD, count: 0, items: [] });
      const html = await (await get(r, '/settings/mail-preview', cookie)).text();
      assert.equal((html.match(/<iframe /g) || []).length, 0);
      assert.ok((html.match(/보낼 내용 없음/g) || []).length >= 1);
    } finally {
      await r.close?.();
    }
  });

  test('settings page links to the mail preview', async () => {
    const { r } = await rt();
    try {
      const cookie = await setup(r);
      const html = await (await get(r, '/settings', cookie)).text();
      assert.match(html, /<a [^>]*href="\/settings\/mail-preview"[^>]*>오늘 보낼 메일 미리보기<\/a>/);
    } finally {
      await r.close?.();
    }
  });
});
