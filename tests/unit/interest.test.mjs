import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { CHECKLIST } from '../../app/modules/interest/view.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** interest 모듈 하나만 있는 모듈 디렉토리 (다른 모듈이 없는 환경) */
function modulesDir(names = ['interest']) {
  const d = mkdtempSync(path.join(tmpdir(), 'br-interest-'));
  tmpRoots.push(d);
  for (const n of names) symlinkSync(path.join(ROOT, 'app/modules', n), path.join(d, n), 'dir');
  return d;
}

let fetchCalls = 0;
const noNetwork = async () => {
  fetchCalls += 1;
  throw new Error('network is not allowed in unit tests');
};

async function rt(fakeNow = '2026-10-29', names) {
  return createRuntime({ dbPath: ':memory:', modulesDir: modulesDir(names), secret: 'x', jobToken: 't', env: {}, fetchImpl: noNetwork, fakeNow });
}

function req(r, url, init = {}) {
  return r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
}
const form = (obj) => ({ method: 'POST', body: new URLSearchParams(obj) });

async function setup(r) {
  const res = await req(r, '/setup', form({ company: '테스트 조경', name: '대표' }));
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
const post = (r, url, cookie, obj = {}) => req(r, url, { ...form(obj), headers: { cookie } });
const get = (r, url, cookie) => req(r, url, { headers: { cookie } });

async function seed(r, no, deadline, title = `공고 ${no}`) {
  await r.ctx.bids.upsert(
    { bidNtceNo: no, bidNtceOrd: '000', bidNtceNm: title, dminsttNm: '테스트 기관', bidClseDt: deadline, bidNtceDtlUrl: `https://example.com/${no}` },
    'nara-cnstwk',
  );
  return `${no}-000`;
}

const jobFn = (r) => r.hooks.jobs.reminders.find((j) => j.id === 'interest').fn;
const decorateFn = (r) => r.hooks.decorate.find((j) => j.id === 'interest').fn;

describe('interest module', () => {
  test('manifest: menu entry and hooks registered', async () => {
    const r = await rt();
    try {
      const m = r.modules.find((x) => x.id === 'interest');
      assert.equal(m.title, '관심 공고');
      assert.equal(m.group, '매일');
      assert.equal(m.order, 11);
      assert.equal(m.path, '/interest');
      assert.equal(m.help, '관심 표시한 공고의 마감 D-day 와 입찰 전 확인 항목입니다.');
      assert.equal(CHECKLIST.length, 5);
      assert.ok(r.hooks.jobs.reminders.some((j) => j.id === 'interest'));
    } finally {
      await r.close();
    }
  });

  test('login required: /interest and add page redirect to /welcome', async () => {
    const r = await rt();
    try {
      const id = await seed(r, '1001', '2026-11-07 10:00:00');
      for (const url of ['/interest', `/interest/add/${id}`]) {
        const res = await req(r, url);
        assert.equal(res.status, 302, url);
        assert.equal(res.headers.get('location'), '/welcome');
      }
      const p = await req(r, `/interest/add/${id}`, form({}));
      assert.equal(p.status, 302);
      assert.equal(p.headers.get('location'), '/welcome');
    } finally {
      await r.close();
    }
  });

  test('empty state text and link', async () => {
    const r = await rt();
    try {
      const cookie = await setup(r);
      const html = await (await get(r, '/interest', cookie)).text();
      assert.match(html, /관심 표시한 공고가 없습니다\./);
      assert.match(html, /href="\/today"[^>]*>오늘의 공고에서 고르기</);
    } finally {
      await r.close();
    }
  });

  test('add: confirm page, POST 303, duplicate add keeps one row, decorate badge', async () => {
    const r = await rt();
    try {
      const cookie = await setup(r);
      const id = await seed(r, '1001', '2026-11-07 10:00:00', '공원 조경 공사');
      assert.deepEqual(await decorateFn(r)(r.ctx, id, null), { label: '관심', href: `/interest/add/${id}` });

      const page = await get(r, `/interest/add/${id}`, cookie);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /공원 조경 공사/);
      assert.equal((html.match(/<button type="submit">관심 공고에 담기<\/button>/g) || []).length, 1);

      const res = await post(r, `/interest/add/${id}`, cookie);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/interest');
      const again = await post(r, `/interest/add/${id}`, cookie);
      assert.equal(again.status, 303);
      assert.equal((await r.ctx.db.get('SELECT COUNT(*) AS n FROM interest_items')).n, 1);

      const second = await (await get(r, `/interest/add/${id}`, cookie)).text();
      assert.match(second, /이미 관심 공고에 담겨 있습니다/);
      assert.doesNotMatch(second, /<button type="submit">관심 공고에 담기/);
      assert.deepEqual(await decorateFn(r)(r.ctx, id, null), { label: '관심 중', href: '/interest' });

      const list = await (await get(r, '/interest', cookie)).text();
      assert.match(list, /공원 조경 공사/);
      assert.match(list, /D-9/);
      assert.match(list, /관심 해제/);
      assert.match(list, /https:\/\/example\.com\/1001/);
      for (const c of CHECKLIST) assert.ok(list.includes(r.ctx.html.esc(c)), c);
    } finally {
      await r.close();
    }
  });

  test('unknown bid is 404 Korean page without code names', async () => {
    const r = await rt();
    try {
      const cookie = await setup(r);
      for (const res of [await get(r, '/interest/add/nope-000', cookie), await post(r, '/interest/add/nope-000', cookie)]) {
        assert.equal(res.status, 404);
        const html = await res.text();
        assert.match(html, /찾는 공고가 없습니다/);
        assert.match(html, /공고를 찾지 못했습니다\. 오늘의 공고에서 다시 선택해 주세요\./);
        assert.doesNotMatch(html, /Not Found|NOT_FOUND|Error/);
      }
      assert.equal((await r.ctx.db.get('SELECT COUNT(*) AS n FROM interest_items')).n, 0);
    } finally {
      await r.close();
    }
  });

  test('dday labels: D-0, past, unknown deadline, sorted by deadline', async () => {
    const r = await rt();
    try {
      const cookie = await setup(r);
      const ids = [
        await seed(r, '2001', '9999-12-31 00:00:00', '미확인 공고'),
        await seed(r, '2002', '2026-10-28 10:00:00', '지난 공고'),
        await seed(r, '2003', '2026-11-07 10:00:00', '나중 공고'),
        await seed(r, '2004', '2026-10-29 18:00:00', '오늘 공고'),
      ];
      for (const id of ids) await post(r, `/interest/add/${id}`, cookie);
      const html = await (await get(r, '/interest', cookie)).text();
      const pos = ['오늘 공고', '나중 공고', '미확인 공고', '지난 공고'].map((t) => html.indexOf(t));
      assert.ok(pos.every((p) => p > 0), String(pos));
      assert.deepEqual([...pos].sort((a, b) => a - b), pos);
      assert.match(html, /D-0/);
      assert.match(html, /마감 지남/);
      assert.match(html, /마감 미확인/);
      assert.doesNotMatch(html, /9999-/);
      assert.equal(r.ctx.html.dday('2026-10-20 10:00:00', '2026-10-29'), '마감 지남');
    } finally {
      await r.close();
    }
  });

  test('checklist toggle persists after reload', async () => {
    const r = await rt();
    try {
      const cookie = await setup(r);
      const id = await seed(r, '3001', '2026-11-07 10:00:00');
      await post(r, `/interest/add/${id}`, cookie);
      const res = await post(r, `/interest/${id}/check`, cookie, { item: '1', checked: '1' });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/interest');
      const html = await (await get(r, '/interest', cookie)).text();
      assert.equal((html.match(/aria-pressed="true"/g) || []).length, 1);
      assert.equal((html.match(/aria-pressed="false"/g) || []).length, 4);
      assert.match(html, /aria-pressed="true" data-item="1"/);

      await post(r, `/interest/${id}/check`, cookie, { item: '1', checked: '0' });
      const html2 = await (await get(r, '/interest', cookie)).text();
      assert.equal((html2.match(/aria-pressed="true"/g) || []).length, 0);

      const bad = await post(r, `/interest/${id}/check`, cookie, { item: '9', checked: '1' });
      assert.equal(bad.status, 400);
    } finally {
      await r.close();
    }
  });

  test('remove deletes item and checks', async () => {
    const r = await rt();
    try {
      const cookie = await setup(r);
      const id = await seed(r, '3101', '2026-11-07 10:00:00');
      await post(r, `/interest/add/${id}`, cookie);
      await post(r, `/interest/${id}/check`, cookie, { item: '2', checked: '1' });
      const res = await post(r, `/interest/${id}/remove`, cookie);
      assert.equal(res.status, 303);
      assert.equal((await r.ctx.db.get('SELECT COUNT(*) AS n FROM interest_items')).n, 0);
      assert.equal((await r.ctx.db.get('SELECT COUNT(*) AS n FROM interest_checks')).n, 0);
    } finally {
      await r.close();
    }
  });

  test('reminders: D-7/3/1 only, past and unknown excluded, once per (bid, day), dry records nothing', async () => {
    const r = await rt();
    try {
      const cookie = await setup(r);
      const d3 = await seed(r, '4001', '2026-11-01 10:00:00', '삼일 공고');
      const d7 = await seed(r, '4002', '2026-11-05 10:00:00', '칠일 공고');
      const d1 = await seed(r, '4003', '2026-10-30 10:00:00', '하루 공고');
      const d2 = await seed(r, '4004', '2026-10-31 10:00:00', '이틀 공고');
      const past = await seed(r, '4005', '2026-10-20 10:00:00', '지난 공고');
      const unk = await seed(r, '4006', '9999-12-31 00:00:00', '미확인 공고');
      await seed(r, '4007', '2026-11-01 10:00:00', '담지 않은 공고');
      for (const id of [d3, d7, d1, d2, past, unk]) await post(r, `/interest/add/${id}`, cookie);
      await post(r, `/interest/${d3}/check`, cookie, { item: '1', checked: '1' });

      const job = jobFn(r);
      const dry = await job(r.ctx, { date: '2026-10-29', dry: true });
      assert.equal(dry.kind, 'reminder');
      assert.equal(dry.count, 3);
      assert.equal((await r.ctx.db.get('SELECT COUNT(*) AS n FROM interest_reminders')).n, 0);

      const n = await job(r.ctx, { date: '2026-10-29', dry: false });
      assert.equal(n.kind, 'reminder');
      assert.equal(n.date, '2026-10-29');
      assert.deepEqual(n.items.map((i) => [i.bidId, i.dday]), [[d1, 'D-1 10:00'], [d3, 'D-3 10:00'], [d7, 'D-7 10:00']]);
      const three = n.items.find((i) => i.bidId === d3);
      assert.equal(three.title, '삼일 공고');
      assert.equal(three.deadline, '2026-11-01 10:00:00');
      assert.equal(three.assignee, '미정');
      assert.deepEqual(three.reasons, []);
      assert.deepEqual(three.checklist, CHECKLIST.slice(1));
      assert.equal((await r.ctx.db.get('SELECT COUNT(*) AS n FROM interest_reminders')).n, 3);

      assert.equal(await job(r.ctx, { date: '2026-10-29', dry: false }), null);

      // 코어 잡: 같은 날 두 번째는 null, 다른 날짜의 D-3 은 따로 한 번
      const coreFirst = await r.ctx.jobs.runReminders({ date: '2026-10-29' });
      assert.equal(coreFirst, null);
      const later = await r.ctx.jobs.runReminders({ date: '2026-11-02' });
      assert.equal(later.count, 1);
      assert.equal(later.items[0].bidId, d7);
      assert.equal(later.items[0].dday, 'D-3 10:00');
      assert.match(later.text, /^입찰 레이더 · 11\/02 마감 임박 1건/);
      assert.match(later.text, /1\. D-3 10:00 · 칠일 공고 · 마감 2026-11-05 10:00:00 · 담당 미정/);
      assert.equal(await r.ctx.jobs.runReminders({ date: '2026-11-02' }), null);
      assert.equal(fetchCalls, 0);
    } finally {
      await r.close();
    }
  });

  test('reminders: D-0 only before the deadline time (Asia/Seoul)', async () => {
    const r = await rt();
    try {
      const cookie = await setup(r);
      const evening = await seed(r, '4101', '2026-10-29 18:00:00', '저녁 마감 공고');
      const morning = await seed(r, '4102', '2026-10-29 07:00:00', '아침 마감 공고');
      for (const id of [evening, morning]) await post(r, `/interest/add/${id}`, cookie);
      r.ctx.now = () => new Date('2026-10-29T08:10:00+09:00');
      const n = await jobFn(r)(r.ctx, { date: '2026-10-29', dry: false });
      assert.deepEqual(n.items.map((i) => [i.bidId, i.dday]), [[evening, 'D-0 18:00']]);
      assert.deepEqual((await r.ctx.db.all('SELECT bid_id, day FROM interest_reminders')).map((x) => [x.bid_id, x.day]), [[evening, 0]]);
      r.ctx.now = () => new Date('2026-10-29T18:00:00+09:00');
      await seed(r, '4103', '2026-10-29 18:00:00', '정각 공고');
      await post(r, '/interest/add/4103-000', cookie);
      assert.equal(await jobFn(r)(r.ctx, { date: '2026-10-29', dry: true }), null);
    } finally {
      await r.close();
    }
  });

  test('ddayNumber reads timed labels', async () => {
    const { ddayNumber, REMINDER_DAYS } = await import('../../app/modules/interest/service.mjs');
    assert.equal(ddayNumber('D-3 10:00'), 3);
    assert.equal(ddayNumber('D-0'), 0);
    assert.equal(ddayNumber('마감 지남'), null);
    assert.deepEqual(REMINDER_DAYS, [7, 3, 1, 0]);
  });

  test('reminders: no interest items → null', async () => {
    const r = await rt();
    try {
      assert.equal(await jobFn(r)(r.ctx, { date: '2026-10-29' }), null);
    } finally {
      await r.close();
    }
  });

  test('assignee: name from assign_items when the assign module and row exist', async () => {
    const r = await rt('2026-10-29', ['interest', 'assign']);
    try {
      const cookie = await setup(r);
      const id = await seed(r, '5001', '2026-11-01 10:00:00');
      const other = await seed(r, '5002', '2026-11-01 11:00:00');
      await post(r, `/interest/add/${id}`, cookie);
      await post(r, `/interest/add/${other}`, cookie);
      const { member } = await r.ctx.members.create({ name: '담당이', role: 'staff' });
      await r.ctx.db.run("INSERT INTO assign_items (bid_id, assignee_id, status, updated_at) VALUES ($1, $2, 'review', 'x')", [id, member.id]);
      const n = await jobFn(r)(r.ctx, { date: '2026-10-29', dry: true });
      assert.equal(n.items.find((i) => i.bidId === id).assignee, '담당이');
      assert.equal(n.items.find((i) => i.bidId === other).assignee, '미정');
    } finally {
      await r.close();
    }
  });

  test('flow line: prestd mark on linked notice, none on plain, linksFor throwing still 200', async () => {
    const r = await rt();
    try {
      const cookie = await setup(r);
      await r.ctx.bids.upsert(
        { bidNtceNo: 'R26BK01900005', bidNtceOrd: '000', bidNtceNm: '연결 공고', dminsttNm: '테스트 기관', bidClseDt: '2026-11-07 10:00:00', bfSpecRgstNo: 'R26BD00900005' },
        'nara-cnstwk',
      );
      const linked = 'R26BK01900005-000';
      const plain = await seed(r, '1001', '2026-11-08 10:00:00', '일반 공고');
      await post(r, `/interest/add/${linked}`, cookie);
      await post(r, `/interest/add/${plain}`, cookie);
      const html = await (await get(r, '/interest', cookie)).text();
      assert.match(html, /<p class="flow">사전규격 있었음<\/p>/);
      const cardOf = (id) => new RegExp(`<li class="card" data-bid="${id}"[\\s\\S]*?</li>`).exec(html)[0];
      assert.match(cardOf(linked), /class="flow"/);
      assert.doesNotMatch(cardOf(plain), /class="flow"/);
      const facts = cardOf(linked).indexOf('class="facts"');
      assert.ok(facts > -1 && facts < cardOf(linked).indexOf('class="flow"'), 'flow after facts');

      const logs = [];
      const origLog = r.ctx.log;
      r.ctx.log = (...a) => logs.push(a);
      r.ctx.bids.linksFor = () => {
        throw new Error('boom');
      };
      const res = await get(r, '/interest', cookie);
      assert.equal(res.status, 200);
      const html2 = await res.text();
      assert.match(html2, /연결 공고/);
      assert.doesNotMatch(html2, /class="flow"/);
      assert.ok(logs.some((a) => a[0] === 'interest' && /boom/.test(a.slice(1).join(' '))));
      r.ctx.log = origLog;
    } finally {
      await r.close();
    }
  });
});
