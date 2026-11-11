// Shared shell helpers: chips, dates, badges, layout options, tabs DOM, no external URLs.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { todayBody, budgetText } from '../../app/modules/today/view.mjs';
import { formatBudget } from '../../src/match.js';
import { createHtml, dday, ddayChip, dateTime, shortDate, openingText, kindChip, flowLine, badge, icon, notice, avatar, count, error, empty } from '../../app/core/html.mjs';

const MENUS = [
  { id: 'today', title: '오늘의 공고', group: '매일', order: 10, path: '/today', help: '오늘 도움말' },
  { id: 'interest', title: '관심 공고', group: '매일', order: 20, path: '/interest', help: '관심 도움말' },
  { id: 'assign', title: '업무 분배', group: '매일', order: 30, path: '/assign', help: '분배 도움말' },
  { id: 'summary', title: '공고 요약', group: '공고 더 알기', order: 10, path: '/summary', help: '요약 도움말' },
  { id: 'company', title: '내 회사', group: '공고 더 알기', order: 20, path: '/company', help: '회사 도움말' },
  { id: 'support', title: '지원사업', group: '더 넓게', order: 10, path: '/support', help: '지원 도움말' },
  { id: 'keywords', title: '추천 키워드', group: '더 넓게', order: 20, path: '/keywords', help: '키워드 도움말' },
  { id: 'sources', title: '공고 소스', group: '더 넓게', order: 30, path: '/sources', help: '소스 도움말' },
  { id: 'settings', title: '알림 설정', group: '설정', order: 10, path: '/settings', help: '설정 도움말' },
];
const OWNER = { id: 1, name: '김대표', role: 'owner' };

function h(company = '테스트 조경') {
  return createHtml({ menus: () => MENUS, companyName: () => company });
}

async function render(opts, html = h()) {
  return (await html.layout(opts)).text();
}

describe('html: ddayChip', () => {
  test('soon for 0..3 days, plain for later, skip prefix for reading', () => {
    assert.equal(ddayChip('2026-11-02 10:00:00', '2026-10-30'), '<span class="dday soon"><span class="skip">마감 </span>D-3 10:00</span>');
    assert.equal(ddayChip('2026-10-30 18:00', '2026-10-30'), '<span class="dday soon"><span class="skip">마감 </span>D-0 18:00</span>');
    assert.equal(ddayChip('2026-11-04 18:00:00', '2026-10-30'), '<span class="dday"><span class="skip">마감 </span>D-5 18:00</span>');
    assert.equal(ddayChip('2026-11-02', '2026-10-30'), '<span class="dday soon"><span class="skip">마감 </span>D-3</span>');
  });

  test('past and unknown', () => {
    assert.equal(ddayChip('2026-10-29 23:59:59', '2026-10-30'), '<span class="dday past">마감 지남</span>');
    assert.equal(ddayChip('', '2026-10-30'), '<span class="dday unknown">마감 미확인</span>');
    assert.equal(ddayChip('9999-12-31 00:00:00', '2026-10-30'), '<span class="dday unknown">마감 미확인</span>');
  });

  test('prefix makes the word visible', () => {
    assert.equal(ddayChip('2026-11-11', '2026-10-30', { prefix: '신청 ' }), '<span class="dday">신청 마감 D-12</span>');
  });
});

describe('html: dday with deadline time (S8)', () => {
  test('time is shown when the deadline has one', () => {
    assert.equal(dday('2026-11-01 10:00:00', '2026-10-29'), 'D-3 10:00');
    assert.equal(dday('2026-11-01T09:30', '2026-10-29'), 'D-3 09:30');
    assert.equal(dday('2026-11-01', '2026-10-29'), 'D-3');
    assert.equal(dday('2026-10-29 07:00:00', '2026-10-29'), 'D-0 07:00');
    assert.equal(dday('2026-10-28 23:59:59', '2026-10-29'), '마감 지남');
    assert.equal(dday('', '2026-10-29'), '마감 미확인');
  });

  test('openingText', () => {
    assert.equal(openingText('2026-11-08 11:00:00'), '개찰 11/08(일) 11:00');
    assert.equal(openingText('2026-11-08'), '개찰 11/08(일)');
    assert.equal(openingText(''), '');
    assert.equal(openingText(null), '');
    assert.equal(openingText('9999-12-31 00:00:00'), '');
  });

  test('kindChip', () => {
    const want = { changed: '변경', cancelled: '취소', rebid: '재공고', postponed: '연기', prestd: '사전규격' };
    for (const [k, label] of Object.entries(want)) {
      assert.equal(kindChip(k), `<span class="kind-chip kind-${k}">${label}</span>`);
    }
    for (const k of ['normal', '', null, undefined, 'toString']) assert.equal(kindChip(k), '');
  });
});

describe('html: dates', () => {
  test('dateTime', () => {
    assert.equal(dateTime('2026-11-04 18:00:00'), '11/04(수) 18:00');
    assert.equal(dateTime('2026-11-02 10:00'), '11/02(월) 10:00');
    assert.equal(dateTime(''), '');
    assert.equal(dateTime(null), '');
    assert.equal(dateTime('9999-12-31 00:00:00'), '');
  });

  test('shortDate', () => {
    assert.equal(shortDate('2026-10-30'), '10/30(금)');
    assert.equal(shortDate('2026-11-01'), '11/01(일)');
    assert.equal(shortDate('곧'), '');
  });
});

describe('html: badge, icon, notice, small helpers', () => {
  test('badge kind mapping', () => {
    const map = {
      interest: 'icon-bookmark"',
      'interest-on': 'icon-bookmark-fill"',
      assign: 'icon-user-plus"',
      'assign-set': 'icon-users"',
      summary: 'icon-file"',
      ok: 'icon-check-circle"',
      check: 'icon-alert-circle"',
      no: 'icon-x-circle"',
    };
    for (const [kind, cls] of Object.entries(map)) {
      const out = badge({ label: '라벨', href: '/x?a=1&b=2', kind });
      assert.match(out, new RegExp(`^<a class="badge kind-${kind}" href="/x\\?a=1&amp;b=2"><svg `), kind);
      assert.ok(out.includes(cls), `${kind} icon`);
      assert.ok(out.endsWith('라벨</a>'), kind);
    }
    assert.equal(badge({ label: '<담당>', href: '/assign' }), '<a class="badge" href="/assign">&lt;담당&gt;</a>');
    assert.equal(badge({ label: '요약', href: '/summary', kind: 'weird' }), '<a class="badge" href="/summary">요약</a>');
  });

  test('icon names', () => {
    assert.equal(icon('nope'), '');
    const s = icon('calendar', { size: 20 });
    assert.match(s, /^<svg [^>]*aria-hidden="true"[^>]*width="20" height="20" viewBox="0 0 24 24"/);
    for (const n of ['radar', 'bookmark', 'bookmark-fill', 'users', 'user-plus', 'file', 'building', 'leaf', 'tag', 'rss', 'bell', 'check-circle', 'alert-circle', 'x-circle', 'info', 'refresh', 'search', 'spinner', 'clock', 'grid', 'chevron-left']) {
      assert.ok(icon(n).startsWith('<svg '), n);
    }
  });

  test('notice, avatar, count, error, empty structure', () => {
    assert.match(notice('저장했습니다.', { kind: 'success', role: 'status' }), /^<div class="notice success" role="status"><p><svg [^>]*icon-check-circle[^>]*>.*<\/svg>저장했습니다\.<\/p><\/div>$/);
    assert.match(notice('<b>', {}), /^<div class="notice info"><p><svg .*<\/svg>&lt;b&gt;<\/p><\/div>$/);
    assert.match(notice('<b>굵게</b>', { html: true, kind: 'warn' }), /<\/svg><b>굵게<\/b><\/p>/);
    assert.equal(avatar('김대표'), '<span class="avatar" aria-hidden="true">김</span>');
    assert.equal(count(3, '건'), '<span class="count">3건</span>');
    assert.match(error('안 됐습니다', '다시 해 주세요'), /^<div class="error" role="alert"><p><svg .*<\/svg>안 됐습니다\. 다시 해 주세요\.<\/p><\/div>$/);
    assert.match(empty('없습니다', { href: '/today', label: '오늘의 공고에서 고르기' }), /href="\/today"[^>]*>오늘의 공고에서 고르기</);
  });

  test('createHtml exposes every helper', () => {
    const x = h();
    for (const k of ['layout', 'page', 'redirect', 'esc', 'reasons', 'dday', 'empty', 'error', 'icon', 'ddayChip', 'dateTime', 'shortDate', 'openingText', 'kindChip', 'badge', 'notice', 'avatar', 'count']) {
      assert.equal(typeof x[k], 'function', k);
    }
  });
});

describe('html: layout', () => {
  test('eyebrow defaults to group, false hides, string overrides; heading overrides h1', async () => {
    const a = await render({ title: '공고 요약', help: '요약 도움말', body: '<p>b</p>', member: OWNER, active: 'summary' });
    assert.match(a, /<p class="eyebrow">공고 더 알기<\/p><h1>공고 요약<\/h1><p class="help">요약 도움말<\/p>/);
    const b = await render({ title: '내 정보', help: 'x', body: '', member: OWNER, active: null, eyebrow: false });
    assert.doesNotMatch(b, /class="eyebrow"/);
    assert.doesNotMatch(b.replace(/<style>[\s\S]*?<\/style>/, ''), /aria-current/);
    const c = await render({ title: '공고 요약', heading: '공원 정비공사', eyebrow: '공고 요약', help: '', body: '', member: OWNER, active: 'summary' });
    assert.match(c, /<p class="eyebrow">공고 요약<\/p><h1>공원 정비공사<\/h1><\/div>/);
    assert.match(c, /<title>공고 요약 · 입찰 레이더<\/title>/);
    assert.doesNotMatch(c, /<p class="help">/);
  });

  test('header: brand, company, avatar link to /me, role chip, logout', async () => {
    const s = await render({ title: 't', body: '', member: OWNER, active: 'today' });
    assert.match(s, /<header class="top"><a class="brand" href="\/">/);
    assert.match(s, /<span class="sep" aria-hidden="true"><\/span><span class="company">테스트 조경<\/span>/);
    assert.match(s, /<a class="me" href="\/me" aria-label="내 정보 · 김대표"><span class="avatar" aria-hidden="true">김<\/span><span class="member">김대표<\/span><span class="role">대표<\/span><\/a>/);
    assert.match(s, /<a class="logout" href="\/logout">나가기<\/a>/);
    const staff = await render({ title: 't', body: '', member: { id: 2, name: '이직원', role: 'staff' }, active: 'today' });
    assert.match(staff, /<span class="role">구성원<\/span>/);
  });

  test('header sign-out: legacy link unchanged, logoutPost renders a POST form button', async () => {
    const legacy = await render({ title: 't', body: '', member: OWNER, active: 'today' });
    assert.ok(legacy.includes('<span class="dot" aria-hidden="true">·</span><a class="logout" href="/logout">나가기</a></div>'));
    assert.doesNotMatch(legacy, /<form class="logout-form"/);
    const post = createHtml({ menus: () => MENUS, companyName: () => '테스트 조경', logoutPost: true });
    const s = await render({ title: 't', body: '', member: OWNER, active: 'today' }, post);
    assert.ok(s.includes('<span class="dot" aria-hidden="true">·</span><form class="logout-form" method="post" action="/logout"><button type="submit" class="logout">나가기</button></form></div>'));
    assert.doesNotMatch(s, /<a class="logout"/);
    const header = s.slice(s.indexOf('<header'), s.indexOf('</header>'));
    assert.match(header, /logout-form/);
    assert.ok(s.indexOf('<main') > s.indexOf('</header>'));
  });

  test('header sign-out: button looks like the link and hides on mobile', async () => {
    const s = await render({ title: 't', body: '', member: OWNER, active: 'today' });
    assert.match(s, /\.who button\.logout,\.who button\.logout:hover\{[^}]*background:none;border:0;[^}]*color:var\(--ink-2\)|\.who button\.logout,\.who button\.logout:hover\{[^}]*color:var\(--ink-2\);background:none;border:0;/);
    const mobile = s.slice(s.indexOf('@media (max-width:899px)'));
    assert.match(mobile, /\.who \.member,\.who \.role,\.who \.dot,\.who a\.logout,\.who \.logout-form\{display:none\}/);
  });

  test('sidebar keeps the plain link text, current page, menu note, actions and wide', async () => {
    const s = await render({ title: '오늘의 공고', body: '', member: OWNER, active: 'today', actions: '<button>가져오기</button>', wide: true });
    assert.match(s, /<a href="\/today" title="오늘 도움말" aria-current="page">오늘의 공고<\/a>/);
    assert.match(s, /<p class="menu-note">알림은 매일 아침 8시쯤 갑니다\.<\/p><\/nav>/);
    assert.match(s, /<div class="actions"><button>가져오기<\/button><\/div>/);
    assert.match(s, /<main id="main" class="wide">/);
    const nav = s.slice(s.indexOf('<nav class="menu"'), s.indexOf('</nav>') + 6);
    assert.equal((nav.match(/<svg /g) || []).length, 9);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
  });

  test('bare: no header, menu or tabs; centered card', async () => {
    const s = await render({ title: '처음 시작하기', help: '도움말', body: '<form></form>', member: null, chrome: 'bare' });
    assert.match(s, /<main id="main" class="bare">/);
    assert.doesNotMatch(s, /<header/);
    assert.doesNotMatch(s, /<nav/);
    assert.match(s, /<h1>처음 시작하기<\/h1><p class="help">도움말<\/p>/);
    const logged = await render({ title: 'x', body: '', member: OWNER, active: 'today', chrome: 'bare' });
    assert.doesNotMatch(logged, /<nav|<header|class="eyebrow"/);
  });

  test('mobile tabs: 3 links, details.more, 6 links in panel by group', async () => {
    const s = await render({ title: '공고 요약', body: '', member: OWNER, active: 'summary' });
    const start = s.indexOf('<nav class="tabs" aria-label="빠른 메뉴">');
    assert.ok(start > 0, 'tabs present');
    const tabs = s.slice(start, s.indexOf('</nav>', start) + 6);
    const moreAt = tabs.indexOf('<details class="more">');
    assert.ok(moreAt > 0, 'details.more');
    const before = tabs.slice(0, moreAt);
    const panel = tabs.slice(tabs.indexOf('<div class="more-panel">'));
    assert.deepEqual([...before.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), ['/today', '/interest', '/assign']);
    assert.deepEqual([...panel.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), ['/summary', '/company', '/support', '/keywords', '/sources', '/settings']);
    assert.deepEqual([...panel.matchAll(/<p class="group-name">([^<]+)<\/p>/g)].map((m) => m[1]), ['공고 더 알기', '더 넓게', '설정']);
    assert.match(tabs, /<summary class="on">/);
    assert.match(panel, /<a href="\/summary" aria-current="page">/);
    const today = await render({ title: '오늘의 공고', body: '', member: OWNER, active: 'today' });
    assert.match(today, /<nav class="tabs" aria-label="빠른 메뉴"><a href="\/today" aria-current="page"><svg /);
    assert.match(today, /<summary><svg /);
    const anon = await render({ title: '어서 오세요', body: '', member: null });
    assert.doesNotMatch(anon, /<nav/);
  });

  test('no external addresses in style, script or svg', async () => {
    const s = await render({ title: '오늘의 공고', body: '', member: OWNER, active: 'today' });
    const blocks = [
      ...s.matchAll(/<style>[\s\S]*?<\/style>/g),
      ...s.matchAll(/<script>[\s\S]*?<\/script>/g),
      ...s.matchAll(/<svg[\s\S]*?<\/svg>/g),
    ].map((m) => m[0]);
    assert.ok(blocks.length > 10, 'found blocks');
    for (const b of blocks) assert.doesNotMatch(b, /https?:\/\//);
    assert.equal((s.match(/<script>/g) || []).length, 1);
    assert.match(s, /aria-busy/);
    assert.match(s, /data-amount-hint/);
    const src = readFileSync(new URL('../../app/core/html.mjs', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /https?:\/\//);
    assert.doesNotMatch(src, /<link /);
  });
});

describe('today card: deadline time, opening, budget basis, kind chip, deadline change', () => {
  const card = (bid, changes) => todayBody(h(), { date: '2026-11-02', today: '2026-11-02', items: [{ bid, badges: [] }], maybe: null, changes });
  const base = { bidId: 'T-1', title: '공원 조경 공사', org: '테스트 기관', deadline: '2026-11-07 10:00:00', budget: 120000000, url: '' };

  test('facts line and kind chip', () => {
    const html = card({ ...base, kind: 'changed', openingAt: '2026-11-08 11:00:00', budgetBasis: 'estimated', amounts: { estimated: 120000000, base: 130000000, assigned: 132000000 } });
    const facts = /<p class="facts"[^>]*>([\s\S]*?)<\/p>/.exec(html)[1].replace(/<[^>]+>/g, '');
    assert.equal(facts, '마감 11/07(토) 10:00·개찰 11/08(일) 11:00·추정가격 1.2억 (부가세 제외)');
    assert.ok(html.includes('<span class="kind-chip kind-changed">변경</span>'));
    assert.ok(html.includes('D-5 10:00'));
    assert.ok(!html.includes('마감 변경됨'));
  });

  test('budget labels by basis', () => {
    assert.equal(budgetText({ budget: 1, budgetBasis: 'base', amounts: { base: 130000000 } }), '기초금액 1.3억 (부가세 포함)');
    assert.equal(budgetText({ budget: 132000000, budgetBasis: 'assigned', amounts: { assigned: null } }), `배정예산 ${formatBudget(132000000)} (부가세 포함)`);
    assert.equal(budgetText({ budget: 120000000 }), `예산 ${formatBudget(120000000)}`);
  });

  test('deadline changed in recent changes', () => {
    const html = card(base, [{ bidId: 'T-1', field: 'deadline', old: '2026-11-05 10:00:00', new: '2026-11-07 10:00:00' }]);
    assert.ok(html.includes('마감 변경됨'));
    assert.ok(!card(base, [{ bidId: 'T-1', field: 'budget' }]).includes('마감 변경됨'));
    assert.ok(!card(base, [{ bidId: 'X-9', field: 'deadline' }]).includes('마감 변경됨'));
    const plain = card(base);
    assert.ok(!plain.includes('kind-chip'));
    assert.ok(!plain.includes('개찰'));
  });
});

describe('html: flowLine (prestd ↔ notice)', () => {
  const ps = { bidId: 'PSR26BD00900005-000', noticeNo: 'R26BD00900005', title: '사전 공원 조경', kind: 'prestd', deadline: '2026-11-06 18:00:00', postedAt: null, url: null, stored: true };
  const nt = (o = {}) => ({ bidId: 'R26BK01900005-001', noticeNo: 'R26BK01900005', title: '공원 <조경> 공사', kind: null, deadline: null, postedAt: null, url: 'https://example.com/n', stored: true, ...o });

  test('notice side: with and without opinion deadline', () => {
    assert.equal(flowLine({ prestd: ps, notices: [] }), '<p class="flow">사전규격 있었음 · 의견마감 11/06(금) 18:00</p>');
    assert.equal(flowLine({ prestd: { ...ps, deadline: null }, notices: [] }), '<p class="flow">사전규격 있었음</p>');
    assert.equal(flowLine({ prestd: { ...ps, stored: false, title: '', deadline: '2026-11-06 18:00:00' }, notices: [] }), '<p class="flow">사전규격 있었음</p>');
  });

  test('prestd side: stored notice with changed chip and more count', () => {
    const html = flowLine({ prestd: null, notices: [nt({ kind: 'changed' }), nt({ bidId: 'R26BK02-000', noticeNo: 'R26BK02' })] });
    assert.equal(
      html,
      '<p class="flow">본공고 나옴 → <a href="https://example.com/n" target="_blank" rel="noopener">공원 &lt;조경&gt; 공사</a> <span class="kind-chip kind-changed">변경</span> 외 1건</p>',
    );
    assert.equal(html.replace(/<[^>]+>/g, ''), '본공고 나옴 → 공원 &lt;조경&gt; 공사 변경 외 1건');
  });

  test('prestd side: stored notice without safe url, plain kind', () => {
    assert.equal(flowLine({ prestd: null, notices: [nt({ url: 'javascript:alert(1)', kind: 'prestd' })] }), '<p class="flow">본공고 나옴 → 공원 &lt;조경&gt; 공사</p>');
  });

  test('prestd side: notice not stored shows notice number', () => {
    const n = { bidId: 'R26BK01900005-000', noticeNo: 'R26BK01900005', title: '', kind: null, deadline: null, postedAt: null, url: null, stored: false };
    assert.equal(flowLine({ prestd: null, notices: [n] }), '<p class="flow">본공고 나옴 → 공고번호 R26BK01900005</p>');
  });

  test('empty flow and bad input give empty string', () => {
    assert.equal(flowLine({ prestd: null, notices: [] }), '');
    assert.equal(flowLine(null), '');
    assert.equal(flowLine(undefined), '');
  });

  test('CSS: flow line and awarded/top chips', async () => {
    const page = await render({ title: 'x', body: '' });
    assert.ok(page.includes('.flow{margin:0;font-size:14px;color:var(--ink-2)}'));
    const src = readFileSync(new URL('../../app/core/html.mjs', import.meta.url), 'utf8');
    assert.ok(src.includes('.flow{margin:0;font-size:14px;color:var(--ink-2)}'));
    assert.ok(src.includes('.kind-chip.kind-awarded{background:var(--ok-bg);color:var(--ok);border-color:var(--ok-line)}'));
    assert.ok(src.includes('.kind-chip.kind-top{'));
  });

  test('today card: flow line after kind line, before facts; none without links', () => {
    const base = { bidId: 'R26BK01900005-000', title: '공원 조경 공사', org: '기관', deadline: '2026-11-07 10:00:00', budget: 1, url: '', kind: 'changed' };
    const html = todayBody(h(), { date: '2026-11-02', today: '2026-11-02', items: [{ bid: base, badges: [], flow: { prestd: ps, notices: [] } }], maybe: null });
    const iKind = html.indexOf('class="kinds"');
    const iFlow = html.indexOf('class="flow"');
    const iFacts = html.indexOf('class="facts"');
    assert.ok(iKind > -1 && iKind < iFlow && iFlow < iFacts, 'kinds < flow < facts');
    assert.ok(html.includes('사전규격 있었음 · 의견마감 11/06(금) 18:00'));
    const plain = todayBody(h(), { date: '2026-11-02', today: '2026-11-02', items: [{ bid: base, badges: [] }], maybe: null });
    assert.ok(!plain.includes('class="flow"'));
  });
});

describe('html: legal footer', () => {
  test('normal page: footer inside .page right before </div></main>, shows BUSINESS_NAME', async () => {
    const html = createHtml({ menus: () => MENUS, companyName: () => '테스트 조경', env: { BUSINESS_NAME: '예시상호' } });
    const out = await render({ title: 't', body: '<p>본문</p>', member: OWNER, active: 'today' }, html);
    assert.match(out, /<p>본문<\/p>\n<footer class="legal">.*<\/footer>\n<\/div><\/main>/s);
    assert.ok(out.includes('상호 예시상호'));
    assert.ok(out.includes('<a href="/terms">이용약관</a>'));
  });

  test('bare page: footer right before </main>; empty env → 사업자 정보 미설정', async () => {
    const html = createHtml({ menus: () => [], env: {} });
    const out = await render({ title: 't', body: '<p>본문</p>', chrome: 'bare' }, html);
    assert.match(out, /<footer class="legal">.*<\/footer>\n<\/main>/s);
    assert.ok(out.includes('사업자 정보 미설정'));
  });

  test('CSS has footer.legal rules incl. mobile stacking', () => {
    const src = readFileSync(new URL('../../app/core/html.mjs', import.meta.url), 'utf8');
    assert.match(src, /footer\.legal\{/);
    assert.match(src, /footer\.legal p\.biz\{flex-direction:column\}/);
  });
});

describe('html: demo banner and example chip', () => {
  test('banner() empty → no banner in shell or bare pages', async () => {
    const shell = await render({ title: 't', body: '<p>b</p>', member: OWNER, active: 'today' });
    assert.doesNotMatch(shell, /class="banner demo"/);
    const bare = await render({ title: 't', body: '', chrome: 'bare' });
    assert.doesNotMatch(bare, /class="banner demo"/);
    for (const v of [null, undefined, '']) {
      const x = createHtml({ menus: () => MENUS, banner: () => v });
      assert.doesNotMatch(await render({ title: 't', body: '', member: OWNER, active: 'today' }, x), /class="banner demo"/);
    }
  });

  test('shell: banner right after </header>, raw html kept', async () => {
    const x = createHtml({ menus: () => MENUS, companyName: () => '테스트 조경', banner: () => '예시 데이터입니다 <a href="/signup">가입</a>' });
    const s = await render({ title: 't', body: '', member: OWNER, active: 'today' }, x);
    assert.ok(s.includes('</header>\n<div class="banner demo" role="note">예시 데이터입니다 <a href="/signup">가입</a></div>\n<div class="shell'));
  });

  test('bare: banner right after brand-row', async () => {
    const x = createHtml({ menus: () => [], banner: () => '안내' });
    const s = await render({ title: 't', body: '', chrome: 'bare' }, x);
    assert.match(s, /<div class="brand-row">.*?<\/div>\n<div class="banner demo" role="note">안내<\/div>\n<div class="page-head">/s);
  });

  test('exampleChip: named export and html method', async () => {
    const { exampleChip } = await import('../../app/core/html.mjs');
    assert.equal(exampleChip(), '<span class="chip example">예시 데이터</span>');
    assert.equal(h().exampleChip(), exampleChip());
  });

  test('CSS: banner, example chip, explain block rules', () => {
    const src = readFileSync(new URL('../../app/core/html.mjs', import.meta.url), 'utf8');
    assert.match(src, /\.banner\.demo\{/);
    assert.match(src, /\.chip\.example\{/);
    assert.match(src, /details\.explain\{/);
    assert.match(src, /\.explain li\[data-ok="false"\]/);
  });
});

describe('tip and schedule note', () => {
  test('CSS: tip icon shows its text on hover and keyboard focus', () => {
    const src = readFileSync(new URL('../../app/core/html.mjs', import.meta.url), 'utf8');
    assert.match(src, /\.tip\{display:inline-flex;width:18px;height:18px;border-radius:50%;[^}]*cursor:help;position:relative/);
    assert.match(src, /\.tip:hover::after,\.tip:focus::after\{content:attr\(data-tip\);/);
    assert.match(src, /\.chip\.credits\{/);
  });

  test('html object exposes schedulerOff, scheduleNote and tip', () => {
    const on = h();
    assert.equal(typeof on.scheduleNote, 'function');
    assert.equal(typeof on.tip, 'function');
    const off = createHtml({ menus: () => MENUS, env: { APP_SCHEDULER_OFF: '1' } });
    assert.equal(off.schedulerOff, true);
    assert.match(off.scheduleNote('a', 'b'), /^b <span class="tip" tabindex="0" role="note"/);
  });

  test('menu note off: tip inside the note; on: no tip anywhere', async () => {
    const off = createHtml({ menus: () => MENUS, env: { APP_SCHEDULER_OFF: '1' } });
    const s = await render({ title: 't', body: '', member: OWNER, active: 'today' }, off);
    assert.match(s, /<p class="menu-note">알림 예약 실행이 꺼져 있습니다\. <span class="tip"[^>]*>\?<\/span><\/p><\/nav>/);
    const plain = await render({ title: 't', body: '', member: OWNER, active: 'today' });
    assert.doesNotMatch(plain, /class="tip"/);
  });

  test('menu note is dropped when the body already shows the off note', async () => {
    const off = createHtml({ menus: () => MENUS, env: { APP_SCHEDULER_OFF: '1' } });
    const s = await render({ title: 't', body: '<p>알림 예약 실행이 꺼져 있습니다.</p>', member: OWNER, active: 'today' }, off);
    assert.doesNotMatch(s, /class="menu-note"/);
  });
});
