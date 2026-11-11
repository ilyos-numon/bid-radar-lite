// 예약 실행을 끈 운영(APP_SCHEDULER_OFF=1)의 `?` 안내: 메뉴 노트·설정·지원사업·요금제 4곳, 끄면 0개
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHtml, tip, SCHEDULE_OFF_TIP } from '../../app/core/html.mjs';
import { settingsBody, TEXT as SETTINGS_TEXT } from '../../app/modules/settings/view.mjs';
import { supportBody, TEXT as SUPPORT_TEXT } from '../../app/modules/support/view.mjs';
import { billingBody, TEXT as BILLING_TEXT } from '../../app/modules/billing/view.mjs';
import { TEXT as TODAY_TEXT } from '../../app/modules/today/view.mjs';
import { DEMO_TEXT } from '../../app/core/demo/fixture.mjs';
import { CREDITS_TEXT } from '../../app/core/billing/credits.mjs';

const OFF = { APP_SCHEDULER_OFF: '1' };
const OWNER = { id: 1, name: '김대표', role: 'owner' };
const MENUS = [{ id: 'today', title: '오늘의 공고', group: '매일', order: 10, path: '/today' }];

function html(env = {}) {
  return createHtml({ menus: () => MENUS, env });
}

const tips = (s) => (s.match(/class="tip"/g) || []).length;

function settings(h) {
  return settingsBody(h, {
    values: { keywords: '조경', regions: '', budgetMin: '', budgetMax: '', webhook: '' },
    canEdit: true,
    first: false,
    saved: false,
  });
}

function support(h) {
  return supportBody(h, { hasKey: true, today: '2026-11-03', total: 0, items: [], keywords: [], regions: [] });
}

function billing(h, status = 'trialing') {
  return billingBody(h, {
    sub: { status, plan: 'basic', nextDate: '2026-12-01', periodDate: '2026-12-01', cancelAtPeriodEnd: false, cardSummary: null },
    access: { active: true, trialDaysLeft: 7 },
    payments: [],
    tossReady: false,
    canEdit: true,
    ymd: (v) => String(v ?? ''),
  });
}

describe('scheduleNote / tip', () => {
  test('tip: ? icon, keyboard focusable, escaped data-tip', () => {
    assert.equal(
      tip('a<b'),
      '<span class="tip" tabindex="0" role="note" aria-label="a&lt;b" data-tip="a&lt;b">?</span>',
    );
    assert.equal(html().tip('x'), tip('x'));
  });

  test('schedulerOff only when APP_SCHEDULER_OFF is exactly 1', () => {
    assert.equal(html(OFF).schedulerOff, true);
    assert.equal(html({}).schedulerOff, false);
    assert.equal(html({ APP_SCHEDULER_OFF: '0' }).schedulerOff, false);
  });

  test('scheduleNote: off → off text + tip with the approved wording; on → on text only', () => {
    const off = html(OFF).scheduleNote('켜짐 <문구>', '꺼짐 <문구>');
    assert.ok(off.startsWith('꺼짐 &lt;문구&gt; <span class="tip"'));
    assert.ok(off.includes(`data-tip="${SCHEDULE_OFF_TIP}"`));
    assert.match(off, /data-tip="[^"]*예약 실행을 꺼 두었습니다[^"]*"/);
    assert.equal(html({}).scheduleNote('켜짐 <문구>', '꺼짐'), '켜짐 &lt;문구&gt;');
    assert.equal(
      SCHEDULE_OFF_TIP,
      '비용 절감을 위해 예약 실행을 꺼 두었습니다. 공고는 하루 첫 방문 때 가져오고, 알림과 자동 결제는 보내지 않습니다.',
    );
  });
});

describe('views: one tip per place when off, none when on', () => {
  test('menu note', async () => {
    const on = await (await html({}).layout({ title: 't', body: '', member: OWNER, active: 'today' })).text();
    const off = await (await html(OFF).layout({ title: 't', body: '', member: OWNER, active: 'today' })).text();
    assert.match(on, /<p class="menu-note">알림은 매일 아침 8시쯤 갑니다\.<\/p>/);
    assert.equal(tips(on), 0);
    assert.match(off, /<p class="menu-note">알림 예약 실행이 꺼져 있습니다\. <span class="tip"[^>]*data-tip="[^"]*예약 실행을 꺼 두었습니다[^"]*">\?<\/span><\/p>/);
    assert.equal(tips(off), 1);
  });

  test('settings: alert time line', async () => {
    const on = settings(html({}));
    const off = settings(html(OFF));
    assert.ok(on.includes(SETTINGS_TEXT.fixedTime));
    assert.equal(tips(on), 0);
    assert.ok(off.includes(SETTINGS_TEXT.fixedTimeOff));
    assert.ok(!off.includes(SETTINGS_TEXT.fixedTime));
    assert.equal(tips(off), 1);
    assert.match(off, /data-tip="[^"]*예약 실행을 꺼 두었습니다/);
  });

  test('settings page off: body note suppresses the menu note (no duplicate)', async () => {
    const h = html(OFF);
    const s = await (await h.layout({ title: 't', body: settings(h), member: OWNER, active: 'today' })).text();
    assert.doesNotMatch(s, /class="menu-note"/);
    assert.equal(tips(s), 1);
  });

  test('support: notice line', () => {
    const on = support(html({}));
    const off = support(html(OFF));
    assert.ok(on.includes(SUPPORT_TEXT.note));
    assert.equal(tips(on), 0);
    assert.ok(off.includes(SUPPORT_TEXT.noteOff));
    assert.equal(tips(off), 1);
  });

  test('billing: trialAfter line and next charge line keep their text and get a tip', () => {
    for (const status of ['trialing', 'active']) {
      const on = billing(html({}), status);
      const off = billing(html(OFF), status);
      assert.equal(tips(on), 0, status);
      assert.equal(tips(off), 1, status);
      assert.ok(off.includes(`data-tip="${BILLING_TEXT.autoChargeOff}"`), status);
    }
    assert.ok(billing(html(OFF), 'trialing').includes(BILLING_TEXT.trialAfter));
    assert.ok(billing(html(OFF), 'active').includes(BILLING_TEXT.active('2026-12-01')));
  });

  test('billing: plain h without schedulerOff stays unchanged', () => {
    const h = html({});
    assert.equal(billing({ ...h, schedulerOff: undefined }, 'active'), billing(h, 'active'));
  });
});

describe('copy', () => {
  test('today credit wording matches the shared credit wording letter for letter', () => {
    for (const n of [0, 1, 5]) {
      assert.equal(TODAY_TEXT.creditsLeft(n), CREDITS_TEXT.left(n));
      assert.equal(TODAY_TEXT.creditsNone(n), CREDITS_TEXT.none(n));
    }
    assert.equal(TODAY_TEXT.creditsNoneNext, CREDITS_TEXT.noneNext);
    assert.equal(TODAY_TEXT.creditsPlans, CREDITS_TEXT.plans);
  });

  test('demo banner off wording', () => {
    assert.equal(DEMO_TEXT.bannerOff, '예시 데이터로 둘러보는 중입니다 · 매일 첫 방문 때 초기화 · 결제 화면은 테스트 모드라 실제 결제가 일어나지 않습니다');
    assert.match(DEMO_TEXT.banner, /매일 04:00 초기화/);
  });
});
