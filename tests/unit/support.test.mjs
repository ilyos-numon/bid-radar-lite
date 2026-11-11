import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { normalizeResponse, parseApplyEnd, matchItem } from '../../app/modules/support/service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NARA_FIXTURE = readFileSync(path.join(ROOT, 'tests/fixtures/nara-bids.json'), 'utf8');
const SECRET_KEY = 'sup-secret-key-123';
const SUPPORT_ENV = { SUPPORT_API_BASE: 'https://api.example/support', SUPPORT_API_KEY: SECRET_KEY };
const NARA_ENV = { NARA_API_KEY: 'dummy-key', NARA_API_BASE: 'http://nara.test/svc' };

const tmpRoots = [];
const runtimes = [];
after(async () => {
  for (const r of runtimes) await r.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function modulesDir(ids) {
  const d = mkdtempSync(path.join(tmpdir(), 'br-sup-'));
  tmpRoots.push(d);
  for (const id of ids) symlinkSync(path.join(ROOT, 'app/modules', id), path.join(d, id), 'dir');
  return d;
}

const item = (id, title, extra = {}) => ({
  pblancId: id,
  pblancNm: title,
  jrsdInsttNm: '중소벤처기업부',
  reqstBeginEndDe: '20261001 ~ 20261130',
  pblancUrl: `https://api.example/view/${id}`,
  bsnsSumryCn: '',
  trgetNm: '전국',
  ...extra,
});

/** body 는 함수(호출 순번) 또는 값. 나라장터 주소는 공유 픽스처 */
function stubFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith('http://nara.test')) return new Response(NARA_FIXTURE);
    const b = typeof body === 'function' ? body(calls.filter((c) => !c.startsWith('http://nara.test')).length) : body;
    return new Response(typeof b === 'string' ? b : JSON.stringify(b), { status });
  };
  fn.calls = calls;
  fn.supportCalls = () => calls.filter((c) => c.startsWith('https://api.example'));
  return fn;
}

async function rt({ env = SUPPORT_ENV, fetchImpl = stubFetch([]), ids = ['support'], fakeNow = '2026-10-29' } = {}) {
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir: modulesDir(ids),
    secret: 'x',
    jobToken: 't',
    env,
    fetchImpl,
    fakeNow,
  });
  runtimes.push(r);
  return r;
}

function req(r, url, init = {}) {
  return r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
}
const form = (obj, cookie) => ({ method: 'POST', body: new URLSearchParams(obj), headers: cookie ? { cookie } : {} });

async function login(r) {
  const res = await req(r, '/setup', form({ company: '테스트 조경', name: '대표' }));
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const rows = (r, table) => r.ctx.db.all(`SELECT * FROM ${table}`);
const job = (r, date, dry = false) => r.hooks.jobs.support[0].fn(r.ctx, { date, dry });

describe('support normalize', () => {
  test('support: applyEnd from text after ~', () => {
    assert.equal(parseApplyEnd('20261001 ~ 20261130'), '2026-11-30');
    assert.equal(parseApplyEnd('20261130'), '');
    assert.equal(parseApplyEnd(''), '');
    assert.equal(parseApplyEnd(undefined), '');
  });

  test('support: field mapping', () => {
    const [it] = normalizeResponse([item('P1', '소상공인 스마트기술 도입 지원', { bsnsSumryCn: '요약', trgetNm: '경기' })]);
    assert.deepEqual(it, {
      id: 'P1',
      title: '소상공인 스마트기술 도입 지원',
      org: '중소벤처기업부',
      applyEnd: '2026-11-30',
      url: 'https://api.example/view/P1',
      summary: '요약',
      region: '경기',
    });
  });

  test('support: response shapes are normalized to arrays', () => {
    const a = item('A', '가');
    const b = item('B', '나');
    assert.equal(normalizeResponse([a, b]).length, 2);
    assert.equal(normalizeResponse(a).length, 1);
    assert.equal(normalizeResponse({ jsonArray: [a, b] }).length, 2);
    assert.equal(normalizeResponse({ jsonArray: a }).length, 1);
    assert.equal(normalizeResponse({ response: { body: { items: { item: [a, b] } } } }).length, 2);
    assert.equal(normalizeResponse({ response: { body: { items: { item: a } } } }).length, 1);
    assert.equal(normalizeResponse({ items: [a] }).length, 1);
    assert.deepEqual(normalizeResponse(null), []);
    assert.deepEqual(normalizeResponse(''), []);
    assert.deepEqual(normalizeResponse({}), []);
    assert.deepEqual(normalizeResponse({ response: { body: { items: '' } } }), []);
  });

  test('support: reasons wording for keyword and region', () => {
    const it = { title: '조경 분야 소상공인 바우처', summary: '', org: '경기도청', region: '' };
    assert.deepEqual(matchItem(it, ['조경'], []), ["키워드 '조경' 일치"]);
    assert.deepEqual(matchItem(it, ['조경'], ['경기']), ["키워드 '조경' 일치", "지역 '경기' 일치"]);
    assert.deepEqual(matchItem({ ...it, title: '바우처', summary: '조경 업체 대상' }, ['조경'], []), ["키워드 '조경' 일치"]);
    assert.equal(matchItem(it, ['조경'], ['부산']), null);
    assert.equal(matchItem(it, ['수목'], []), null);
  });
});

describe('support collect and job', () => {
  test('support: collect stores one row, re-collect updates and keeps first_seen', async () => {
    const f = stubFetch((n) => [item('P1', n === 1 ? '소상공인 스마트기술 도입 지원' : '소상공인 스마트기술 도입 지원 (변경)')]);
    const r = await rt({ fetchImpl: f });
    const cookie = await login(r);
    let res = await req(r, '/support/fetch', form({}, cookie));
    assert.equal(res.status, 303);
    let list = await rows(r, 'support_items');
    assert.equal(list.length, 1);
    assert.equal(list[0].title, '소상공인 스마트기술 도입 지원');
    assert.equal(list[0].apply_end, '2026-11-30');
    assert.equal(list[0].first_seen, '2026-10-29');

    await r.ctx.db.run("UPDATE support_items SET first_seen = '2026-10-01'");
    res = await req(r, '/support/fetch', form({}, cookie));
    list = await rows(r, 'support_items');
    assert.equal(list.length, 1);
    assert.equal(list[0].title, '소상공인 스마트기술 도입 지원 (변경)');
    assert.equal(list[0].first_seen, '2026-10-01');
    assert.equal((await rows(r, 'support_runs')).length, 2);
    const url = new URL(f.supportCalls()[0]);
    assert.equal(url.origin + url.pathname, 'https://api.example/support');
    assert.equal(url.searchParams.get('serviceKey'), SECRET_KEY);
    assert.equal(url.searchParams.get('type'), 'json');
    assert.equal(url.searchParams.get('numOfRows'), '100');
    assert.equal(url.searchParams.get('pageNo'), '1');
    assert.equal((await rows(r, 'bids')).length, 0);
  });

  test('support: job notifies matching item once (same day yes, next day null)', async () => {
    const data = [item('P1', '조경 분야 소상공인 바우처'), item('P2', '수출 바우처'), item('P3', '반도체 장비 지원')];
    const r = await rt({ fetchImpl: stubFetch(data) });
    await r.ctx.settings.set('support.keywords', JSON.stringify(['조경']));
    const n = await job(r, '2026-10-29');
    assert.equal(n.kind, 'support');
    assert.equal(n.count, 1);
    assert.equal(n.date, '2026-10-29');
    assert.deepEqual(n.items[0], {
      bidId: 'P1',
      title: '조경 분야 소상공인 바우처',
      org: '중소벤처기업부',
      deadline: '2026-11-30',
      budget: null,
      url: 'https://api.example/view/P1',
      reasons: ["키워드 '조경' 일치"],
    });
    assert.equal(await job(r, '2026-10-30'), null);
    assert.equal((await rows(r, 'bids')).length, 0);
  });

  test('support: job through core route renders text and next day is 204', async () => {
    const r = await rt({ fetchImpl: stubFetch([item('P1', '조경 분야 소상공인 바우처')]) });
    await r.ctx.settings.set('support.keywords', JSON.stringify(['조경']));
    let res = await req(r, '/api/jobs/support?date=2026-10-29', { headers: { 'x-job-token': 't' } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.match(body.text, /^지원사업 레이더 · 10\/29 새 지원사업 1건\n1\. 조경 분야 소상공인 바우처\n {3}신청 마감 2026-11-30 · 중소벤처기업부\n {3}왜 추천: 키워드 '조경' 일치\n {3}https:\/\/api\.example\/view\/P1$/);
    res = await req(r, '/api/jobs/support?date=2026-10-30', { headers: { 'x-job-token': 't' } });
    assert.equal(res.status, 204);
  });

  test('support: region mismatch is excluded', async () => {
    const data = [item('P1', '조경 바우처', { jrsdInsttNm: '경기도', trgetNm: '' }), item('P2', '조경 지원', { jrsdInsttNm: '부산광역시', trgetNm: '부산' })];
    const r = await rt({ fetchImpl: stubFetch(data) });
    await r.ctx.settings.set('support.keywords', JSON.stringify(['조경']));
    await r.ctx.settings.set('support.regions', JSON.stringify(['경기']));
    const n = await job(r, '2026-10-29');
    assert.equal(n.count, 1);
    assert.equal(n.items[0].bidId, 'P1');
    assert.deepEqual(n.items[0].reasons, ["키워드 '조경' 일치", "지역 '경기' 일치"]);
  });

  test('support: dry run writes nothing', async () => {
    const r = await rt({ fetchImpl: stubFetch([item('P1', '조경 바우처')]) });
    await r.ctx.settings.set('support.keywords', JSON.stringify(['조경']));
    const n = await job(r, '2026-10-29', true);
    assert.equal(n.count, 1);
    assert.equal((await rows(r, 'support_items')).length, 0);
    assert.equal((await rows(r, 'support_runs')).length, 0);
    assert.equal((await rows(r, 'notifications')).length, 0);
  });

  test('support: no key → null, no call, screen message', async () => {
    const f = stubFetch([item('P1', '조경 바우처')]);
    const r = await rt({ env: {}, fetchImpl: f });
    assert.equal(await job(r, '2026-10-29'), null);
    const res = await req(r, '/api/jobs/support?date=2026-10-29', { headers: { 'x-job-token': 't' } });
    assert.equal(res.status, 204);
    const cookie = await login(r);
    const page = await (await req(r, '/support', { headers: { cookie } })).text();
    assert.ok(page.includes('지원사업 인증키가 아직 없습니다. 운영자가 인증키를 넣으면 수집이 시작됩니다.'));
    assert.ok(page.includes('아직 모은 지원사업이 없습니다.'));
    await req(r, '/support/fetch', form({}, cookie));
    assert.equal(f.calls.length, 0);
  });

  test('support: HTTP error shows message without key or code', async () => {
    const r = await rt({ fetchImpl: stubFetch(`bad key ${SECRET_KEY}`, { status: 500 }) });
    const cookie = await login(r);
    const res = await req(r, '/support/fetch', form({}, cookie));
    const page = await res.text();
    assert.ok(page.includes('지원사업을 가져오지 못했습니다 (응답 오류 500). 잠시 뒤 지금 가져오기를 다시 눌러 주세요.'));
    assert.ok(!page.includes(SECRET_KEY));
    assert.ok(!page.includes('HTTP_'));
    const run = (await rows(r, 'support_runs'))[0];
    assert.equal(run.ok, 0);
    assert.ok(!String(run.error).includes(SECRET_KEY));
    assert.equal(await job(r, '2026-10-29'), null);
  });
});

describe('support screen', () => {
  test('support: first visit copies bid keywords', async () => {
    const r = await rt();
    await r.ctx.criteria.set({ keywords: ['정원', '수목'], regions: [], budgetMin: 0, budgetMax: 1000000000, maxItems: 5 });
    assert.equal(await r.ctx.settings.get('support.keywords'), null);
    const cookie = await login(r);
    const page = await (await req(r, '/support', { headers: { cookie } })).text();
    assert.deepEqual(JSON.parse(await r.ctx.settings.get('support.keywords')), ['정원', '수목']);
    assert.ok(page.includes('value="정원, 수목"'));
  });

  test('support: keyword form saves lists', async () => {
    const r = await rt();
    const cookie = await login(r);
    const res = await req(r, '/support/keywords', form({ keywords: '조경, 바우처', regions: '경기' }, cookie));
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/support?saved=1');
    assert.deepEqual(JSON.parse(await r.ctx.settings.get('support.keywords')), ['조경', '바우처']);
    assert.deepEqual(JSON.parse(await r.ctx.settings.get('support.regions')), ['경기']);
  });

  test('support: list sorted by applyEnd with D-day, reasons, link', async () => {
    const data = [
      item('P1', '조경 늦은 지원', { reqstBeginEndDe: '20261001 ~ 20261231' }),
      item('P2', '조경 빠른 지원', { reqstBeginEndDe: '20261001 ~ 20261108' }),
      item('P3', '반도체 지원'),
    ];
    const r = await rt({ fetchImpl: stubFetch(data) });
    await r.ctx.settings.set('support.keywords', JSON.stringify(['조경']));
    const cookie = await login(r);
    await req(r, '/support/fetch', form({}, cookie));
    const page = await (await req(r, '/support', { headers: { cookie } })).text();
    assert.ok(page.indexOf('조경 빠른 지원') < page.indexOf('조경 늦은 지원'));
    assert.ok(page.includes('신청 마감 D-10'));
    assert.ok(page.includes('왜 추천: 키워드 &#39;조경&#39; 일치'));
    assert.ok(page.includes('href="https://api.example/view/P2"'));
    assert.ok(!page.includes('반도체 지원'));
    assert.ok(page.includes('지금 가져오기'));
  });

  test('support: bids stay out of /support and support stays out of /today', async () => {
    const r = await rt({
      env: { ...NARA_ENV, ...SUPPORT_ENV },
      ids: ['support', 'today'],
      fetchImpl: stubFetch([item('P1', '조경 분야 소상공인 바우처')]),
    });
    await r.ctx.settings.set('support.keywords', JSON.stringify(['조경']));
    const cookie = await login(r);
    await r.ctx.jobs.runDaily({ date: '2026-10-29' });
    await req(r, '/support/fetch', form({}, cookie));
    const bidTitle = '경기도 수원시 가로수 전정 및 보호 사업';
    assert.ok((await rows(r, 'bids')).some((b) => b.title === bidTitle));
    assert.ok(!(await rows(r, 'bids')).some((b) => b.title.includes('바우처')));
    const support = await (await req(r, '/support', { headers: { cookie } })).text();
    assert.ok(support.includes('조경 분야 소상공인 바우처'));
    assert.ok(!support.includes(bidTitle));
    const today = await (await req(r, '/today', { headers: { cookie } })).text();
    assert.ok(today.includes(bidTitle));
    assert.ok(!today.includes('조경 분야 소상공인 바우처'));
  });

  test('support: login required', async () => {
    const r = await rt();
    for (const [url, init] of [['/support', {}], ['/support/fetch', { method: 'POST' }], ['/support/keywords', { method: 'POST' }]]) {
      const res = await req(r, url, init);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/welcome');
    }
  });
});
