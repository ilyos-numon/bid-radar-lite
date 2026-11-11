import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = readFileSync(path.join(ROOT, 'tests/fixtures/nara-bids.json'), 'utf8');
const DEFAULT_CRITERIA = JSON.parse(readFileSync(path.join(ROOT, 'config/criteria.json'), 'utf8'));
const NARA_ENV = { NARA_API_KEY: 'dummy-key', NARA_API_BASE: 'http://nara.test/svc' };
const LLM_ENV = { LLM_API_BASE: 'http://llm.test/v1', LLM_API_KEY: 'sk-test', LLM_MODEL: 'm-test' };

const tmpRoots = [];
const runtimes = [];
after(() => {
  for (const r of runtimes) r.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

function makeDir(files) {
  const root = tmp('br-mod-');
  for (const [rel, src] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, src);
  }
  return root;
}

function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

const naraFetch = () => stubFetch(() => new Response(FIXTURE));

async function rt({ env = NARA_ENV, fetchImpl = naraFetch(), modulesDir } = {}) {
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir: modulesDir ?? tmp('br-mod-'),
    secret: 'x',
    jobToken: 't',
    env,
    fetchImpl,
    fakeNow: '2026-10-29',
  });
  runtimes.push(r);
  return r;
}

function req(r, url, headers = {}) {
  return r.router.fetch(new Request('http://localhost' + url, { headers }));
}

const count = async (r, table) => Number((await r.ctx.db.get(`SELECT COUNT(*) AS n FROM ${table}`)).n);
const EXPECTED_IDS = ['20261029007-000', '20261029001-000', '20261029002-000'];

/** 훅 스텁 모듈 두 개. beta 는 order 가 앞이지만 id 는 뒤 */
function hookModules(key) {
  const g = `globalThis[${JSON.stringify(key)}]`;
  const base = (id, order, extra) => `export default {
  id: '${id}', title: '${id}', group: '더 넓게', order: ${order}, path: '/${id}', help: 'h',
  routes() {},
  ${extra}
};
`;
  return makeDir({
    'alpha/manifest.mjs': base(
      'alpha',
      50,
      `async afterMatch(ctx, a) { (${g} ||= []).push('afterMatch:alpha:' + a.matched.length + ':' + a.candidates.length + ':' + a.dry); throw new Error('boom'); },
  notifyLines(ctx, bidId, date) { (${g} ||= []).push('notifyLines:alpha:' + bidId); return ['자격: 참가 가능 — ' + bidId]; },`,
    ),
    'beta/manifest.mjs': base(
      'beta',
      10,
      `decorate() { (${g} ||= []).push('decorate:beta'); return null; },
  pickMaybe(ctx, a) {
    (${g} ||= []).push('pickMaybe:' + a.unmatched.map((b) => b.bidNtceNo + '-' + b.bidNtceOrd).join(','));
    const b = a.unmatched[0];
    return { bidId: b.bidNtceNo + '-' + b.bidNtceOrd, title: b.bidNtceNm, org: b.dminsttNm, deadline: b.bidClseDt, budget: 90000000, url: b.bidNtceDtlUrl, reasons: ['비슷한 말 가로수'] };
  },
  async afterMatch(ctx, a) { (${g} ||= []).push('afterMatch:beta:' + (a.maybe ? a.maybe.bidId : 'none')); },
  notifyLines(ctx, bidId) { (${g} ||= []).push('notifyLines:beta:' + bidId); throw new Error('nope'); },`,
    ),
  });
}

describe('daily job', () => {
  test('daily job: shared fixture → count 3, bidId order, kind bids, maybe null, one notification row', async () => {
    const r = await rt();
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-29' });
    assert.equal(n.kind, 'bids');
    assert.equal(n.count, 3);
    assert.equal(n.date, '2026-10-29');
    assert.deepEqual(n.items.map((i) => i.bidId), EXPECTED_IDS);
    assert.equal(n.maybe, null);
    assert.equal(n.appUrl, 'http://localhost:8820');
    assert.ok(n.text.startsWith('입찰 레이더 · 10/29 새 공고 3건'));
    assert.equal(n.items[0].source, 'nara-cnstwk');
    const rows = await r.ctx.db.all('SELECT kind, date, payload FROM notifications');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'bids');
    assert.equal(rows[0].date, '2026-10-29');
    assert.equal(JSON.parse(rows[0].payload).count, 3);
    assert.deepEqual((await r.ctx.matches.forDate('2026-10-29')).matched.map((m) => m.bidId), EXPECTED_IDS);
  });

  test('daily job: since is the previous day 00:00 KST', async () => {
    const r = await rt();
    const seen = [];
    const orig = r.ctx.sources.fetchAll.bind(r.ctx.sources);
    r.ctx.sources.fetchAll = (since) => {
      seen.push(since);
      return orig(since);
    };
    await r.ctx.jobs.runDaily({ date: '2026-10-29', dry: true });
    assert.equal(seen[0].toISOString(), '2026-10-27T15:00:00.000Z');
  });

  test('daily job: dry=true records nothing', async () => {
    const r = await rt();
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-29', dry: true });
    assert.equal(n.count, 3);
    assert.equal(await count(r, 'notifications'), 0);
    assert.equal(await count(r, 'matches'), 0);
  });

  test('daily job: maxItems=2 — bid pushed out by the limit is not a maybe candidate', async () => {
    const key = '__br_s6_max';
    const r = await rt({ modulesDir: hookModules(key) });
    assert.deepEqual(await r.ctx.criteria.set({ ...DEFAULT_CRITERIA, maxItems: 2 }), []);
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-29', dry: true });
    assert.deepEqual(n.items.map((i) => i.bidId), EXPECTED_IDS.slice(0, 2));
    const pick = globalThis[key].find((s) => s.startsWith('pickMaybe:'));
    const ids = pick.slice('pickMaybe:'.length).split(',');
    assert.ok(!ids.includes('20261029002-000'), 'limit-dropped bid must not be offered');
    assert.ok(!ids.includes('20261029001-000'));
    assert.ok(ids.includes('20261029003-000'));
    assert.ok(ids.includes('20261029005-000'));
  });

  test('daily job: hook order, error isolation, extras placement', async () => {
    const key = '__br_s6_hooks';
    const r = await rt({ modulesDir: hookModules(key) });
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-29' });
    const calls = globalThis[key];
    assert.ok(!calls.some((c) => c.startsWith('decorate')), 'decorate is not called by the daily job');
    assert.equal(calls[0], 'pickMaybe:20261029003-000,20261029004-000,20261029005-000');
    assert.equal(calls[1], 'afterMatch:alpha:3:6:false');
    assert.equal(calls[2], 'afterMatch:beta:20261029003-000');
    assert.deepEqual(calls.slice(3, 5), ['notifyLines:beta:20261029007-000', 'notifyLines:alpha:20261029007-000']);
    assert.equal(calls.length, 3 + 2 * 3);
    assert.equal(n.count, 3);
    assert.equal(n.maybe.bidId, '20261029003-000');
    assert.deepEqual(n.items[0].extras, ['자격: 참가 가능 — 20261029007-000']);
    const lines = n.text.split('\n');
    const why = lines.findIndex((l) => l.startsWith('   왜 추천:'));
    assert.equal(lines[why + 1], '   자격: 참가 가능 — 20261029007-000');
    assert.ok(lines[why + 2].startsWith('   http'));
    assert.ok(n.text.includes('─ 관련 가능성 있음 ─'));
    const saved = await r.ctx.matches.forDate('2026-10-29');
    assert.equal(saved.maybe.bidId, '20261029003-000');
    assert.equal(await count(r, 'notifications'), 1);
  });

  test('daily job: every source fails → no throw, count 0', async () => {
    const r = await rt({ env: {}, fetchImpl: stubFetch(() => { throw new Error('offline'); }) });
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-29' });
    assert.equal(n.kind, 'bids');
    assert.equal(n.count, 0);
    assert.deepEqual(n.items, []);
    assert.deepEqual(n.warnings, ['나라장터 인증키가 없습니다. 운영자가 인증키를 넣어야 합니다.']);
    assert.equal(
      n.text,
      '입찰 레이더 · 10/29 오늘은 조건에 맞는 새 공고가 없습니다\n─ 수집 알림 ─\n나라장터 인증키가 없습니다. 운영자가 인증키를 넣어야 합니다.\n설정 바꾸기: http://localhost:8820/settings',
    );
  });
});

describe('daily job backfill and changes', () => {
  /** 공유 fixture 를 돌려주되 items 를 바꿀 수 있는 스텁 */
  function mutableNara() {
    const state = { items: JSON.parse(FIXTURE).response.body.items };
    const body = () => JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'NORMAL SERVICE.' }, body: { items: state.items, totalCount: state.items.length } } });
    return { state, fetchImpl: stubFetch(() => new Response(body())) };
  }

  function watchSince(r) {
    const seen = [];
    const orig = r.ctx.sources.fetchAll.bind(r.ctx.sources);
    r.ctx.sources.fetchAll = (since, until) => {
      seen.push([since.toISOString(), until.toISOString()]);
      return orig(since, until);
    };
    return seen;
  }

  const okDay = async (r, day) =>
    await r.ctx.db.run("INSERT INTO collect_days (source_id, day, ok, pages, count, truncated, ran_at) VALUES ('nara-cnstwk', $1, 1, 1, 7, 0, '2026-01-01T00:00:00.000Z')", [day]);

  test('backfill: lastOk=10-26, date=10-29 → 3 windows, collect_days 3 rows, result unchanged', async () => {
    const r = await rt();
    await okDay(r, '2026-10-26');
    const seen = watchSince(r);
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-29' });
    assert.deepEqual(seen, [
      ['2026-10-25T15:00:00.000Z', '2026-10-26T15:00:00.000Z'],
      ['2026-10-26T15:00:00.000Z', '2026-10-27T15:00:00.000Z'],
      ['2026-10-27T15:00:00.000Z', '2026-10-28T15:00:00.000Z'],
    ]);
    const days = await r.ctx.db.all("SELECT day, ok, count FROM collect_days WHERE source_id = 'nara-cnstwk' AND day > '2026-10-26' ORDER BY day");
    assert.deepEqual(days.map((d) => [d.day, Number(d.ok), Number(d.count)]), [['2026-10-27', 1, 6], ['2026-10-28', 1, 6], ['2026-10-29', 1, 6]]);
    assert.equal(n.count, 3);
    assert.deepEqual(n.items.map((i) => i.bidId), EXPECTED_IDS);
    assert.deepEqual(n.warnings, []);
  });

  test('backfill: 30-day gap with NARA_BACKFILL_MAX_DAYS 7 → 7 windows (most recent)', async () => {
    const r = await rt({ env: { ...NARA_ENV, NARA_BACKFILL_MAX_DAYS: '7' } });
    await okDay(r, '2026-09-29');
    const seen = watchSince(r);
    await r.ctx.jobs.runDaily({ date: '2026-10-29' });
    assert.equal(seen.length, 7);
    assert.equal(seen[0][0], '2026-10-21T15:00:00.000Z');
    assert.equal(seen[6][0], '2026-10-27T15:00:00.000Z');
    const n = Number((await r.ctx.db.get("SELECT COUNT(*) AS n FROM collect_days WHERE source_id = 'nara-cnstwk' AND day > '2026-09-29'")).n);
    assert.equal(n, 7);
  });

  test('backfill: default max is 7 days; dry run records no collect_days', async () => {
    const r = await rt();
    await okDay(r, '2026-09-01');
    const seen = watchSince(r);
    await r.ctx.jobs.runDaily({ date: '2026-10-29', dry: true });
    assert.equal(seen.length, 7);
    assert.equal(await count(r, 'collect_days'), 1);
  });

  test('change: deadline change and cancellation → bid_changes, payload.changes and text block', async () => {
    const { state, fetchImpl } = mutableNara();
    const r = await rt({ fetchImpl });
    const first = await r.ctx.jobs.runDaily({ date: '2026-10-29' });
    assert.deepEqual(first.changes, []);
    assert.ok(!first.text.includes('─ 변경된 공고 ─'));

    state.items = state.items.map((it) => {
      if (it.bidNtceNo === '20261029001') return { ...it, bidClseDt: '2026-11-10 10:00:00' };
      if (it.bidNtceNo === '20261029002') return { ...it, ntceKindNm: '취소공고' };
      return it;
    });
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-30' });
    const rows = await r.ctx.db.all("SELECT bid_id, field, old, new FROM bid_changes WHERE bid_id = '20261029001-000'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].field, 'deadline');
    assert.equal(rows[0].new, '2026-11-10 10:00:00');
    const dl = n.changes.find((c) => c.bidId === '20261029001-000');
    assert.deepEqual(Object.keys(dl).sort(), ['bidId', 'field', 'new', 'old', 'title']);
    assert.equal(dl.field, 'deadline');
    assert.ok(n.changes.some((c) => c.bidId === '20261029002-000' && c.field === 'kind' && c.new === 'cancelled'));
    const lines = n.text.split('\n');
    const head = lines.indexOf('─ 변경된 공고 ─');
    assert.ok(head > 0, n.text);
    assert.ok(lines.some((l) => l.endsWith('· 마감 2026-11-07 10:00:00 → 2026-11-10 10:00:00') && l.startsWith('경기도 수원시')), n.text);
    assert.ok(n.text.includes('→ 2026-11-10 10:00:00'));
    assert.ok(lines.some((l) => l.endsWith(' · 취소됨')), n.text);
    assert.equal(lines[lines.length - 1], '설정 바꾸기: http://localhost:8820/settings');
  });

  test('change: changes on bids never recommended are not notified', async () => {
    const { state, fetchImpl } = mutableNara();
    const r = await rt({ fetchImpl });
    await r.ctx.jobs.runDaily({ date: '2026-10-29' });
    state.items = state.items.map((it) => (it.bidNtceNo === '20261029005' ? { ...it, bidClseDt: '2026-11-20 10:00:00' } : it));
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-30' });
    assert.equal(await count(r, 'bid_changes'), 1);
    assert.deepEqual(n.changes, []);
  });
});

describe('notify render', () => {
  const item = (over = {}) => ({
    bidId: 'A-000', title: '공원 정비', org: '경기도', deadline: '2026-11-07 10:00:00', budget: 120000000, url: 'https://x.test/a', reasons: ['키워드 \'공원\' 일치', '예산 범위 안'], ...over,
  });

  test('bids: extras, maybe block, settings line, unknown deadline', async () => {
    const r = await rt({ env: { APP_BASE_URL: 'http://app.test' } });
    const text = r.ctx.notify.render({
      kind: 'bids', date: '2026-10-29', count: 2, appUrl: 'http://app.test',
      items: [item({ extras: ['자격: 참가 가능 — 조경식재공사업 등록 (공고문 근거)'] }), item({ bidId: 'B-000', title: '가로수', deadline: '9999-12-31 00:00:00', budget: null })],
      maybe: item({ bidId: 'C-000', title: '수목 관리' }),
    });
    assert.equal(
      text,
      [
        '입찰 레이더 · 10/29 새 공고 2건',
        '1. 공원 정비',
        '   마감 2026-11-07 10:00:00 · 예산 1.2억',
        '   왜 추천: 키워드 \'공원\' 일치 · 예산 범위 안',
        '   자격: 참가 가능 — 조경식재공사업 등록 (공고문 근거)',
        '   https://x.test/a',
        '2. 가로수',
        '   마감 미확인 · 예산 미공개',
        '   왜 추천: 키워드 \'공원\' 일치 · 예산 범위 안',
        '   https://x.test/a',
        '─ 관련 가능성 있음 ─',
        '1. 수목 관리',
        '   마감 2026-11-07 10:00:00 · 예산 1.2억',
        '   왜 추천: 키워드 \'공원\' 일치 · 예산 범위 안',
        '   https://x.test/a',
        '설정 바꾸기: http://app.test/settings',
      ].join('\n'),
    );
  });

  test('bids: change and collection notice blocks before the settings line', async () => {
    const r = await rt();
    const text = r.ctx.notify.render({
      kind: 'bids', date: '2026-10-29', count: 1, appUrl: 'http://app.test',
      items: [item()],
      maybe: null,
      changes: [
        { bidId: 'A-000', title: '공원 정비', field: 'deadline', old: '2026-11-07 10:00:00', new: '2026-11-10 10:00:00' },
        { bidId: 'B-000', title: '가로수', field: 'kind', old: 'new', new: 'cancelled' },
        { bidId: 'C-000', title: '수목', field: 'budget', old: '1', new: '2' },
      ],
      warnings: ['공고가 많아 일부만 가져왔습니다 (20페이지). 운영자에게 알려 주세요.'],
    });
    assert.deepEqual(text.split('\n').slice(5), [
      '─ 변경된 공고 ─',
      '공원 정비 · 마감 2026-11-07 10:00:00 → 2026-11-10 10:00:00',
      '가로수 · 취소됨',
      '─ 수집 알림 ─',
      '공고가 많아 일부만 가져왔습니다 (20페이지). 운영자에게 알려 주세요.',
      '설정 바꾸기: http://app.test/settings',
    ]);
  });

  test('bids: count 0 keeps the one line plus settings line', async () => {
    const r = await rt({ env: { APP_PORT: '9000' } });
    const text = r.ctx.notify.render({ kind: 'bids', date: '2026-10-29', count: 0, items: [], maybe: null });
    assert.equal(text, '입찰 레이더 · 10/29 오늘은 조건에 맞는 새 공고가 없습니다\n설정 바꾸기: http://localhost:9000/settings');
  });

  test('reminder format', async () => {
    const r = await rt();
    const text = r.ctx.notify.render({
      kind: 'reminder', date: '2026-10-29', count: 2, appUrl: 'http://app.test',
      items: [item({ dday: 'D-3', assignee: '담당A', checklist: ['서류 준비', '현장 설명회'] }), item({ dday: 'D-1', title: '가로수' })],
    });
    assert.equal(
      text,
      [
        '입찰 레이더 · 10/29 마감 임박 2건',
        '1. D-3 · 공원 정비 · 마감 2026-11-07 10:00:00 · 담당 담당A',
        '   확인 항목: 서류 준비 · 현장 설명회',
        '   http://app.test/interest',
        '2. D-1 · 가로수 · 마감 2026-11-07 10:00:00 · 담당 미정',
        '   http://app.test/interest',
      ].join('\n'),
    );
  });

  test('support head line and item lines', async () => {
    const r = await rt();
    const text = r.ctx.notify.render({
      kind: 'support', date: '2026-10-29', count: 1, appUrl: 'http://app.test',
      items: [{ bidId: 's1', title: '소상공인 지원', org: '경기도', deadline: '2026-11-30', url: 'https://s.test/1', reasons: ['키워드 일치'] }],
    });
    const lines = text.split('\n');
    assert.equal(lines[0], '지원사업 레이더 · 10/29 새 지원사업 1건');
    assert.deepEqual(lines.slice(1), ['1. 소상공인 지원', '   신청 마감 2026-11-30 · 경기도', '   왜 추천: 키워드 일치', '   https://s.test/1']);
  });

  test('record inserts one notifications row', async () => {
    const r = await rt();
    await r.ctx.notify.record('support', '2026-10-29', { kind: 'support', count: 1 });
    const row = await r.ctx.db.get('SELECT kind, date, payload FROM notifications');
    assert.equal(row.kind, 'support');
    assert.equal(JSON.parse(row.payload).count, 1);
  });
});

describe('notify deliver', () => {
  const HOOK = 'https://hooks.test/abc';
  const D = { kind: 'bids', date: '2026-10-29', runId: 'daily:2026-10-29:w', url: HOOK, payload: { kind: 'bids', count: 1, runId: 'daily:2026-10-29:w' } };
  const deliveries = (r) => r.ctx.db.all('SELECT kind, date, run_id, target_host, status, http_status, error_code, sent_at FROM notification_deliveries');

  test('deliver posts once; second call → already_delivered', async () => {
    const f = stubFetch(() => new Response('ok', { status: 200 }));
    const r = await rt({ fetchImpl: f });
    assert.deepEqual(await r.ctx.notify.deliver(D), { sent: true, status: 200 });
    assert.deepEqual(await r.ctx.notify.deliver({ ...D, runId: 'other' }), { sent: false, reason: 'already_delivered' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, HOOK);
    assert.equal(f.calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(f.calls[0].init.body), D.payload);
    const rows = await deliveries(r);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].target_host, 'hooks.test');
    assert.equal(rows[0].http_status, 200);
    assert.equal(rows[0].run_id, D.runId);
    assert.ok(rows[0].sent_at);
    // 다른 종류·다른 날은 따로 보낸다
    assert.equal((await r.ctx.notify.deliver({ ...D, kind: 'reminder' })).sent, true);
    assert.equal((await r.ctx.notify.deliver({ ...D, date: '2026-10-30' })).sent, true);
    assert.equal(f.calls.length, 3);
  });

  test('deliver failure is recorded and can be retried', async () => {
    let status = 500;
    const f = stubFetch(() => new Response('no', { status }));
    const r = await rt({ fetchImpl: f });
    assert.deepEqual(await r.ctx.notify.deliver(D), { sent: false, reason: 'failed', status: 500 });
    let rows = await deliveries(r);
    assert.equal(rows[0].status, 'failed');
    assert.equal(rows[0].error_code, 'http_500');
    status = 202;
    assert.deepEqual(await r.ctx.notify.deliver(D), { sent: true, status: 202 });
    assert.deepEqual(await r.ctx.notify.deliver(D), { sent: false, reason: 'already_delivered' });
    rows = await deliveries(r);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].error_code, null);
    assert.equal(f.calls.length, 2);
  });

  test('deliver: stale sending (process died) is re-claimed once; recent sending is not', async () => {
    const f = stubFetch(() => new Response('ok', { status: 200 }));
    const r = await rt({ fetchImpl: f });
    assert.equal((await r.ctx.notify.deliver(D)).sent, true);
    const old = new Date(r.ctx.now().getTime() - 11 * 60 * 1000).toISOString();
    await r.ctx.db.run("UPDATE notification_deliveries SET status = 'sending', sent_at = NULL, created_at = $1", [old]);
    assert.deepEqual(await r.ctx.notify.deliver({ ...D, runId: 'retry' }), { sent: true, status: 200 });
    assert.deepEqual(await r.ctx.notify.deliver(D), { sent: false, reason: 'already_delivered' });
    assert.equal(f.calls.length, 2);
    const recent = new Date(r.ctx.now().getTime() - 60 * 1000).toISOString();
    await r.ctx.db.run("UPDATE notification_deliveries SET status = 'sending', sent_at = NULL, created_at = $1", [recent]);
    assert.deepEqual(await r.ctx.notify.deliver(D), { sent: false, reason: 'already_delivered' });
    assert.equal(f.calls.length, 2);
    const rows = await deliveries(r);
    assert.equal(rows.length, 1);
  });

  test('deliver network error → failed with code only', async () => {
    const f = stubFetch(() => {
      throw Object.assign(new Error('blocked secret'), { code: 'SSRF_BLOCKED' });
    });
    const r = await rt({ fetchImpl: f });
    assert.deepEqual(await r.ctx.notify.deliver(D), { sent: false, reason: 'failed' });
    const [row] = await deliveries(r);
    assert.equal(row.status, 'failed');
    assert.equal(row.error_code, 'SSRF_BLOCKED');
  });

  test('deliver without url → no_url, nothing recorded', async () => {
    const f = stubFetch(() => new Response('ok'));
    const r = await rt({ fetchImpl: f });
    assert.deepEqual(await r.ctx.notify.deliver({ ...D, url: '  ' }), { sent: false, reason: 'no_url' });
    assert.deepEqual(await r.ctx.notify.deliver({ ...D, url: null }), { sent: false, reason: 'no_url' });
    assert.equal(f.calls.length, 0);
    assert.equal((await deliveries(r)).length, 0);
  });
});

describe('llm complete', () => {
  const TEXT = '입찰 참가 자격은  조경식재공사업\n등록 업체입니다. 제출 서류는 사업자등록증.';
  const schema = (d) => (typeof d.what === 'string' ? [] : ['what missing']);
  const reply = (content, status = 200) => () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
  const opts = (over = {}) => ({ task: 'summary', system: 'S', input: { bidId: 'X', title: 't' }, schema, textForEvidence: TEXT, ...over });

  test('ok and verified; request body shape', async () => {
    const f = stubFetch(reply('설명 {"what":"조경","evidence":[{"field":"what","quote":"조경식재공사업 등록"}]} 끝'));
    const r = await rt({ env: LLM_ENV, fetchImpl: f });
    const res = await r.ctx.llm.complete(opts());
    assert.equal(res.ok, true);
    assert.equal(res.verified, true);
    assert.deepEqual(res.missingQuotes, []);
    assert.equal(res.data.what, '조경');
    const call = f.calls.find((c) => c.url.startsWith('http://llm.test'));
    assert.equal(call.url, 'http://llm.test/v1/chat/completions');
    assert.equal(call.init.method, 'POST');
    assert.equal(new Headers(call.init.headers).get('authorization'), 'Bearer sk-test');
    const body = JSON.parse(call.init.body);
    assert.equal(body.temperature, 0);
    assert.equal(body.model, 'm-test');
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[0].content.split('\n')[0], '[task:summary]');
    assert.deepEqual(JSON.parse(body.messages[1].content), { bidId: 'X', title: 't' });
  });

  test('default model when LLM_MODEL is empty', async () => {
    const f = stubFetch(reply('{"what":"a","evidence":[]}'));
    const r = await rt({ env: { ...LLM_ENV, LLM_MODEL: '' }, fetchImpl: f });
    await r.ctx.llm.complete(opts({ textForEvidence: null }));
    assert.equal(JSON.parse(f.calls.at(-1).init.body).model, 'qwen3.7-flash');
  });

  test('missing quote → verified false with missingQuotes', async () => {
    const f = stubFetch(reply('{"what":"x","evidence":[{"field":"what","quote":"조경식재공사업 등록"},{"field":"documents","quote":"없는 문장"}]}'));
    const r = await rt({ env: LLM_ENV, fetchImpl: f });
    const res = await r.ctx.llm.complete(opts());
    assert.equal(res.ok, true);
    assert.equal(res.verified, false);
    assert.deepEqual(res.missingQuotes, ['없는 문장']);
  });

  test('non JSON → BAD_JSON', async () => {
    const r = await rt({ env: LLM_ENV, fetchImpl: stubFetch(reply('그냥 문장입니다')) });
    const res = await r.ctx.llm.complete(opts());
    assert.equal(res.ok, false);
    assert.equal(res.error, 'BAD_JSON');
  });

  test('no key → NO_KEY without calling out', async () => {
    const f = stubFetch(reply('{}'));
    const r = await rt({ env: { LLM_API_BASE: 'http://llm.test/v1' }, fetchImpl: f });
    const before = f.calls.length;
    const res = await r.ctx.llm.complete(opts());
    assert.deepEqual(res, { ok: false, error: 'NO_KEY' });
    assert.equal(f.calls.length, before);
    const r2 = await rt({ env: { LLM_API_KEY: 'k' }, fetchImpl: f });
    assert.equal((await r2.ctx.llm.complete(opts())).error, 'NO_KEY');
    assert.equal(f.calls.length, before);
  });

  test('schema errors → SCHEMA', async () => {
    const r = await rt({ env: LLM_ENV, fetchImpl: stubFetch(reply('{"nope":1}')) });
    const res = await r.ctx.llm.complete(opts());
    assert.equal(res.ok, false);
    assert.equal(res.error, 'SCHEMA');
  });

  test('HTTP 500 → HTTP_500', async () => {
    const r = await rt({ env: LLM_ENV, fetchImpl: stubFetch(() => new Response('err', { status: 500 })) });
    const res = await r.ctx.llm.complete(opts());
    assert.equal(res.ok, false);
    assert.equal(res.error, 'HTTP_500');
  });

  test('network error → NETWORK', async () => {
    const r = await rt({ env: LLM_ENV, fetchImpl: stubFetch(() => { throw new TypeError('fetch failed'); }) });
    assert.equal((await r.ctx.llm.complete(opts())).error, 'NETWORK');
  });

  test('timeout → TIMEOUT (LLM_TIMEOUT_MS override)', async () => {
    const hang = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    const r = await rt({ env: { ...LLM_ENV, LLM_TIMEOUT_MS: '50' }, fetchImpl: stubFetch(hang) });
    const started = Date.now();
    const res = await r.ctx.llm.complete(opts());
    assert.equal(res.error, 'TIMEOUT');
    assert.ok(Date.now() - started < 5000);
  });
});

describe('job routes', () => {
  test('no token → 403 forbidden', async () => {
    const r = await rt();
    for (const name of ['daily', 'reminders', 'support']) {
      const res = await req(r, `/api/jobs/${name}`);
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: 'forbidden' });
    }
    const wrong = await req(r, '/api/jobs/daily', { 'x-job-token': 'nope' });
    assert.equal(wrong.status, 403);
  });

  test('bad date → 400 bad_date', async () => {
    const r = await rt();
    for (const d of ['2026-1-01', 'yesterday', '2026-02-30']) {
      const res = await req(r, `/api/jobs/daily?date=${d}`, { 'x-job-token': 't' });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'bad_date' });
    }
  });

  test('daily → 200 notification, dry=1 records nothing', async () => {
    const r = await rt();
    const res = await req(r, '/api/jobs/daily?date=2026-10-29&dry=1', { 'x-job-token': 't' });
    assert.equal(res.status, 200);
    const n = await res.json();
    assert.equal(n.kind, 'bids');
    assert.deepEqual(n.items.map((i) => i.bidId), EXPECTED_IDS);
    assert.equal(await count(r, 'notifications'), 0);
    const res2 = await req(r, '/api/jobs/daily', { 'x-job-token': 't' });
    assert.equal(res2.status, 200);
    assert.equal((await res2.json()).date, '2026-10-29');
    assert.equal(await count(r, 'notifications'), 1);
  });

  test('sync run upserts job_runs (job, date) and the response carries runId; dry=1 records no run', async () => {
    const r = await rt();
    const dry = await (await req(r, '/api/jobs/daily?date=2026-10-29&dry=1', { 'x-job-token': 't' })).json();
    assert.equal(dry.runId, 'daily:2026-10-29:00000000-0000-0000-0000-000000000001');
    assert.equal(await count(r, 'job_runs'), 0);
    for (let i = 0; i < 2; i++) {
      const n = await (await req(r, '/api/jobs/daily?date=2026-10-29', { 'x-job-token': 't' })).json();
      assert.equal(n.runId, 'daily:2026-10-29:00000000-0000-0000-0000-000000000001');
    }
    assert.equal((await req(r, '/api/jobs/support?date=2026-10-29', { 'x-job-token': 't' })).status, 204);
    const rows = await r.ctx.db.all('SELECT job, date, run_id, status, attempt, error_code FROM job_runs ORDER BY job');
    assert.deepEqual(rows, [
      { job: 'daily', date: '2026-10-29', run_id: 'daily:2026-10-29:00000000-0000-0000-0000-000000000001', status: 'done', attempt: 2, error_code: null },
      { job: 'support', date: '2026-10-29', run_id: 'support:2026-10-29:00000000-0000-0000-0000-000000000001', status: 'done', attempt: 1, error_code: null },
    ]);
  });

  test('GET /api/jobs/<name>/runs lists the run of that date', async () => {
    const r = await rt();
    const H = { 'x-job-token': 't' };
    assert.equal((await req(r, '/api/jobs/daily/runs?date=2026-10-29')).status, 403);
    assert.equal((await req(r, '/api/jobs/daily/runs?date=2026-13-01', H)).status, 400);
    assert.deepEqual(await (await req(r, '/api/jobs/daily/runs', H)).json(), []);
    await req(r, '/api/jobs/daily?date=2026-10-29', H);
    const runs = await (await req(r, '/api/jobs/daily/runs', H)).json();
    assert.equal(runs.length, 1);
    const { startedAt, finishedAt, ...rest } = runs[0];
    assert.deepEqual(rest, {
      workspaceId: '00000000-0000-0000-0000-000000000001',
      runId: 'daily:2026-10-29:00000000-0000-0000-0000-000000000001',
      status: 'done',
      attempt: 1,
      errorCode: null,
    });
    assert.ok(startedAt && finishedAt);
    assert.deepEqual(await (await req(r, '/api/jobs/support/runs?date=2026-10-29', H)).json(), []);
  });

  test('reminders/support without modules → 204', async () => {
    const r = await rt();
    for (const name of ['reminders', 'support']) {
      const res = await req(r, `/api/jobs/${name}?date=2026-10-29`, { 'x-job-token': 't' });
      assert.equal(res.status, 204);
    }
  });

  test('reminders from a module job → 200 with rendered text and a record', async () => {
    const dir = makeDir({
      'remind/manifest.mjs': `export default { id: 'remind', title: 'r', group: '더 넓게', order: 1, path: '/remind', help: 'h', routes() {},
  jobs: { reminders(ctx, { date }) { return { kind: 'reminder', date, count: 1, items: [{ bidId: 'A', title: '공원', deadline: '2026-11-01', dday: 'D-3', checklist: [] }] }; } } };`,
    });
    const r = await rt({ modulesDir: dir });
    const res = await req(r, '/api/jobs/reminders?date=2026-10-29', { 'x-job-token': 't' });
    assert.equal(res.status, 200);
    const n = await res.json();
    assert.ok(n.text.startsWith('입찰 레이더 · 10/29 마감 임박 1건'));
    assert.equal(await count(r, 'notifications'), 1);
  });

  test('daily response carries notifyUrl from settings (trimmed), record payload does not', async () => {
    const r = await rt();
    await r.ctx.settings.set('notify_webhook_url', '  https://hook.example/daily  ');
    const res = await req(r, '/api/jobs/daily?date=2026-10-29', { 'x-job-token': 't' });
    assert.equal(res.status, 200);
    const n = await res.json();
    assert.equal(n.notifyUrl, 'https://hook.example/daily');
    assert.equal(n.kind, 'bids');
    assert.equal(n.count, 3);
    for (const k of ['kind', 'date', 'count', 'text', 'appUrl', 'items', 'maybe']) assert.ok(k in n, `missing ${k}`);
    const rows = await r.ctx.db.all('SELECT * FROM notifications');
    assert.equal(rows.length, 1);
    for (const row of rows) {
      for (const v of Object.values(row)) {
        if (typeof v === 'string') {
          assert.ok(!v.includes('notifyUrl'), 'payload must not carry notifyUrl');
          assert.ok(!v.includes('hook.example'), 'payload must not carry the address');
        }
      }
    }
  });

  test('daily response notifyUrl is null when not set or blank', async () => {
    const r = await rt();
    const res = await req(r, '/api/jobs/daily?date=2026-10-29&dry=1', { 'x-job-token': 't' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).notifyUrl, null);
    await r.ctx.settings.set('notify_webhook_url', '   ');
    const res2 = await req(r, '/api/jobs/daily?date=2026-10-29&dry=1', { 'x-job-token': 't' });
    assert.equal((await res2.json()).notifyUrl, null);
  });

  test('reminders/support 200 carry notifyUrl; 204 stays empty', async () => {
    const dir = makeDir({
      'remind/manifest.mjs': `export default { id: 'remind', title: 'r', group: '더 넓게', order: 1, path: '/remind', help: 'h', routes() {},
  jobs: {
    reminders(ctx, { date }) { return { kind: 'reminder', date, count: 1, items: [{ bidId: 'A', title: '공원', deadline: '2026-11-01', dday: 'D-3', checklist: [] }] }; },
    support(ctx, { date }) { return { kind: 'support', date, count: 1, items: [{ title: '지원사업', deadline: '2026-11-05', url: 'https://support.example/1' }] }; },
  } };`,
    });
    const r = await rt({ modulesDir: dir });
    await r.ctx.settings.set('notify_webhook_url', 'https://hook.example/team');
    for (const name of ['reminders', 'support']) {
      const res = await req(r, `/api/jobs/${name}?date=2026-10-29`, { 'x-job-token': 't' });
      assert.equal(res.status, 200, name);
      const n = await res.json();
      assert.equal(n.notifyUrl, 'https://hook.example/team', name);
    }
    const rows = await r.ctx.db.all('SELECT * FROM notifications');
    for (const row of rows) for (const v of Object.values(row)) if (typeof v === 'string') assert.ok(!v.includes('notifyUrl'));

    const empty = await rt();
    await empty.ctx.settings.set('notify_webhook_url', 'https://hook.example/team');
    for (const name of ['reminders', 'support']) {
      const res = await req(empty, `/api/jobs/${name}?date=2026-10-29`, { 'x-job-token': 't' });
      assert.equal(res.status, 204);
      assert.equal(await res.text(), '');
    }
  });
});
