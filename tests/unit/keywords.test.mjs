import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import manifest from '../../app/modules/keywords/manifest.mjs';
import { pickMaybe, validateSuggestions, listSynonyms, MAYBE_SETTING } from '../../app/modules/keywords/service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = readFileSync(path.join(ROOT, 'tests/fixtures/nara-bids.json'), 'utf8');
const DEFAULT_CRITERIA = JSON.parse(readFileSync(path.join(ROOT, 'config/criteria.json'), 'utf8'));
const NARA_ENV = { NARA_API_KEY: 'dummy-key', NARA_API_BASE: 'http://nara.test/svc' };
const LLM_ENV = { LLM_API_BASE: 'http://llm.test/v1', LLM_API_KEY: 'sk-test', LLM_MODEL: 'm-test' };

const tmpRoots = [];
const runtimes = [];
after(async () => {
  for (const r of runtimes) await r.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** 이 모듈 하나만 든 모듈 디렉토리 (다른 모듈과 격리) */
function onlyKeywords() {
  const d = mkdtempSync(path.join(tmpdir(), 'br-kw-'));
  tmpRoots.push(d);
  symlinkSync(path.join(ROOT, 'app/modules/keywords'), path.join(d, 'keywords'), 'dir');
  return d;
}

function llmReply(content, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] }), { status });
}

/** llm: (calls) => Response. nara 주소는 공유 픽스처 */
function stubFetch(llm) {
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.startsWith('http://llm.test')) return llm ? llm(init) : new Response('nope', { status: 500 });
    if (u.startsWith('http://nara.test')) return new Response(FIXTURE);
    throw new Error('unexpected fetch ' + u);
  };
  fn.calls = calls;
  return fn;
}

async function rt({ env = { ...NARA_ENV, ...LLM_ENV }, llm } = {}) {
  const fetchImpl = stubFetch(llm);
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir: onlyKeywords(),
    secret: 'x',
    jobToken: 't',
    env,
    fetchImpl,
    fakeNow: '2026-10-29',
  });
  r.fetchCalls = fetchImpl.calls;
  runtimes.push(r);
  return r;
}

function req(r, url, init = {}) {
  return r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
}

async function login(r) {
  const res = await req(r, '/setup', { method: 'POST', body: new URLSearchParams({ company: '테스트 조경', name: '대표' }) });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const post = (r, url, cookie, body = {}) => req(r, url, { method: 'POST', headers: { cookie }, body: new URLSearchParams(body) });
const get = (r, url, cookie) => req(r, url, { headers: cookie ? { cookie } : {} });

async function insert(r, word, forKeyword, status) {
  await r.ctx.db.run('INSERT INTO keywords_synonyms (word, for_keyword, why, status, created_at) VALUES ($1, $2, $3, $4, $5)', [
    word,
    forKeyword,
    '이유',
    status,
    '2026-10-29T00:00:00.000Z',
  ]);
}

const ENGLISH_CODES = /NO_KEY|BAD_JSON|SCHEMA|HTTP_\d|TIMEOUT|NETWORK|UNKNOWN/;

const SUGGESTIONS = {
  suggestions: [
    { word: '시설물', forKeyword: '공원', why: '공원 시설물 보수 공고에 자주 쓰임' },
    { word: '조경', forKeyword: '수목', why: '이미 지금 키워드' },
    { word: '녹지', forKeyword: '조경', why: '녹지 조성 공고' },
    { word: '녹지', forKeyword: '공원', why: '같은 응답 안 중복' },
    { word: '식재', forKeyword: '수목', why: '이미 표에 있음' },
  ],
};

const BID_PARK = {
  bidNtceNo: '20261029101',
  bidNtceOrd: '000',
  bidNtceNm: '공원 시설물 보수 공사',
  ntceInsttNm: '경기도 성남시',
  dminsttNm: '경기도 성남시',
  bidNtceDt: '2026-10-29 09:00:00',
  bidClseDt: '2026-11-10 10:00:00',
  presmptPrce: '',
  asignBdgtAmt: '80000000',
  bidNtceDtlUrl: 'https://example.org/bid/101',
};

describe('keywords manifest', () => {
  test('keywords: manifest fields match the menu table', () => {
    assert.equal(manifest.id, 'keywords');
    assert.equal(manifest.title, '추천 키워드');
    assert.equal(manifest.group, '더 넓게');
    assert.equal(manifest.order, 31);
    assert.equal(manifest.path, '/keywords');
    assert.equal(manifest.help, '지금 키워드와 비슷한 말을 제안하고, 채택한 말로 관련 가능성 있는 공고를 1건까지 더 찾습니다.');
    assert.equal(typeof manifest.pickMaybe, 'function');
  });
});

describe('keywords suggest', () => {
  test('keywords: suggest stores new words as suggested and skips duplicates', async () => {
    const r = await rt({ llm: () => llmReply(SUGGESTIONS) });
    await insert(r, '식재', '수목', 'rejected');
    const cookie = await login(r);
    const res = await post(r, '/keywords/suggest', cookie);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/keywords?added=2');

    const rows = await listSynonyms(r.ctx.db);
    assert.deepEqual(rows.map((x) => [x.word, x.status]).sort(), [['녹지', 'suggested'], ['시설물', 'suggested'], ['식재', 'rejected']]);
    assert.equal(rows.find((x) => x.word === '시설물').forKeyword, '공원');

    const call = r.fetchCalls.find((c) => c.url === 'http://llm.test/v1/chat/completions');
    const body = JSON.parse(call.init.body);
    assert.ok(body.messages[0].content.startsWith('[task:synonyms]\n'));
    assert.deepEqual(JSON.parse(body.messages[1].content), { keywords: DEFAULT_CRITERIA.keywords });

    const page = await (await get(r, '/keywords?added=2', cookie)).text();
    assert.ok(page.includes('비슷한 키워드 2개를 새로 받았습니다'));
    assert.ok(page.includes('시설물'));
    assert.ok(page.includes('공원 의 비슷한 말'));
  });

  test('keywords: accept and reject change status', async () => {
    const r = await rt();
    await insert(r, '시설물', '공원', 'suggested');
    await insert(r, '녹지', '조경', 'suggested');
    const cookie = await login(r);
    let res = await post(r, `/keywords/${encodeURIComponent('시설물')}/accept`, cookie);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/keywords');
    res = await post(r, `/keywords/${encodeURIComponent('녹지')}/reject`, cookie);
    assert.equal(res.status, 303);
    const status = Object.fromEntries((await listSynonyms(r.ctx.db)).map((x) => [x.word, x.status]));
    assert.deepEqual(status, { 시설물: 'accepted', 녹지: 'rejected' });

    const page = await (await get(r, '/keywords', cookie)).text();
    const accepted = page.slice(page.indexOf('쓰는 중'));
    assert.ok(accepted.includes('시설물'));
    assert.ok(accepted.includes('공원 의 비슷한 말'));

    // 다시 거절 → 채택 목록에서 빠진다
    await post(r, `/keywords/${encodeURIComponent('시설물')}/reject`, cookie);
    assert.equal((await listSynonyms(r.ctx.db, 'accepted')).length, 0);
  });

  test('keywords: empty state shows message and find action', async () => {
    const r = await rt();
    const cookie = await login(r);
    const res = await get(r, '/keywords', cookie);
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.ok(page.includes('제안받은 키워드가 없습니다.'));
    assert.ok(page.includes('<button type="submit">비슷한 키워드 찾기</button>'));
    assert.ok(page.includes('action="/keywords/suggest"'));
  });

  const failures = [
    ['schema error: more than 10 suggestions', () => llmReply({ suggestions: Array.from({ length: 11 }, (_, i) => ({ word: `말${i}`, forKeyword: '공원', why: 'x' })) })],
    ['schema error: word longer than 20 chars', () => llmReply({ suggestions: [{ word: '가'.repeat(21), forKeyword: '공원', why: 'x' }] })],
    ['schema error: empty word', () => llmReply({ suggestions: [{ word: '  ', forKeyword: '공원', why: 'x' }] })],
    ['BAD_JSON', () => llmReply('제안할 말이 없습니다')],
    ['HTTP 500', () => new Response('boom', { status: 500 })],
  ];
  for (const [name, llm] of failures) {
    test(`keywords: ${name} keeps existing rows and shows a plain error`, async () => {
      const r = await rt({ llm });
      await insert(r, '시설물', '공원', 'accepted');
      await insert(r, '녹지', '조경', 'suggested');
      const before = await listSynonyms(r.ctx.db);
      const cookie = await login(r);
      const res = await post(r, '/keywords/suggest', cookie);
      assert.equal(res.status, 200);
      const page = await res.text();
      assert.ok(page.includes('추천 키워드를 가져오지 못했습니다. 잠시 후 다시 눌러 주세요.'));
      assert.ok(!ENGLISH_CODES.test(page.slice(page.indexOf('<main'))));
      assert.ok(page.includes('시설물') && page.includes('녹지'));
      assert.deepEqual(await listSynonyms(r.ctx.db), before);
    });
  }

  test('keywords: NO_KEY keeps rows and says suggestions are not ready', async () => {
    const r = await rt({ env: { ...NARA_ENV } });
    await insert(r, '시설물', '공원', 'accepted');
    const before = await listSynonyms(r.ctx.db);
    const cookie = await login(r);
    const res = await post(r, '/keywords/suggest', cookie);
    const page = await res.text();
    assert.ok(page.includes('비슷한 키워드 찾기 준비가 안 됐습니다.'));
    assert.ok(!ENGLISH_CODES.test(page.slice(page.indexOf('<main'))));
    assert.deepEqual(await listSynonyms(r.ctx.db), before);
    assert.equal(r.fetchCalls.filter((c) => c.url.startsWith('http://llm.test')).length, 0);
  });

  test('keywords: validateSuggestions limits count and word length', () => {
    const ok = (n, len = 2) => ({ suggestions: Array.from({ length: n }, (_, i) => ({ word: String(i).padStart(len, '가'), forKeyword: '공원', why: '' })) });
    assert.deepEqual(validateSuggestions(ok(10)), []);
    assert.deepEqual(validateSuggestions(ok(0)), []);
    assert.ok(validateSuggestions(ok(11)).length > 0);
    assert.deepEqual(validateSuggestions(ok(1, 20)), []);
    assert.ok(validateSuggestions(ok(1, 21)).length > 0);
    assert.ok(validateSuggestions({}).length > 0);
    assert.ok(validateSuggestions({ suggestions: [{ word: '녹지', forKeyword: 3, why: '' }] }).length > 0);
  });
});

describe('keywords pickMaybe', () => {
  test('keywords: accepted word picks one maybe with rewritten reasons', async () => {
    const r = await rt();
    await insert(r, '시설물', '공원', 'accepted');
    await insert(r, '녹지', '조경', 'suggested');
    const other = { ...BID_PARK, bidNtceNo: '20261029102', bidNtceNm: '성남 시설물 점검', bidClseDt: '2026-11-20 10:00:00' };
    const m = await pickMaybe(r.ctx, { date: '2026-10-29', unmatched: [other, BID_PARK], criteria: DEFAULT_CRITERIA });
    assert.equal(m.bidId, '20261029101-000');
    assert.equal(m.title, '공원 시설물 보수 공사');
    assert.equal(m.budget, 80000000);
    assert.deepEqual(m.reasons, ['키워드 직접 일치 없음', "유사어 '시설물' 포함 (키워드 '공원' 의 비슷한 말)", '지역 제한 없음', '예산 범위 안 (배정예산 8000만, 부가세 표기 없음)']);
  });

  test('keywords: maybe off returns null', async () => {
    const r = await rt();
    await insert(r, '시설물', '공원', 'accepted');
    const cookie = await login(r);
    const res = await post(r, '/keywords/maybe', cookie, { enabled: 'false' });
    assert.equal(res.status, 303);
    assert.equal(await r.ctx.settings.get(MAYBE_SETTING), 'false');
    assert.equal(await pickMaybe(r.ctx, { date: '2026-10-29', unmatched: [BID_PARK], criteria: DEFAULT_CRITERIA }), null);
    await post(r, '/keywords/maybe', cookie, { enabled: 'true' });
    assert.equal(await r.ctx.settings.get(MAYBE_SETTING), 'true');
    assert.ok(await pickMaybe(r.ctx, { date: '2026-10-29', unmatched: [BID_PARK], criteria: DEFAULT_CRITERIA }));
  });

  test('keywords: no accepted word returns null', async () => {
    const r = await rt();
    await insert(r, '시설물', '공원', 'suggested');
    await insert(r, '녹지', '조경', 'rejected');
    assert.equal(await pickMaybe(r.ctx, { date: '2026-10-29', unmatched: [BID_PARK], criteria: DEFAULT_CRITERIA }), null);
  });

  test('keywords: daily job puts the maybe in the notification', async () => {
    const r = await rt();
    assert.deepEqual(await r.ctx.criteria.set({ keywords: ['수목', '공원'], regions: ['경기', '서울'], budgetMin: 30000000, budgetMax: 2000000000, maxItems: 5 }), []);
    await insert(r, '시설', '조경', 'accepted');
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-29', dry: true });
    assert.deepEqual(n.items.map((i) => i.bidId), ['20261029007-000', '20261029002-000']);
    assert.equal(n.maybe.bidId, '20261029004-000');
    assert.deepEqual(n.maybe.reasons.slice(0, 2), ['키워드 직접 일치 없음', "유사어 '시설' 포함 (키워드 '조경' 의 비슷한 말)"]);

    await r.ctx.settings.set(MAYBE_SETTING, 'false');
    const off = await r.ctx.jobs.runDaily({ date: '2026-10-29', dry: true });
    assert.equal(off.maybe, null);
  });
});

describe('keywords auth', () => {
  test('keywords: not logged in goes to /welcome', async () => {
    const r = await rt();
    await login(r);
    for (const [method, url] of [
      ['GET', '/keywords'],
      ['POST', '/keywords/suggest'],
      ['POST', '/keywords/maybe'],
      ['POST', `/keywords/${encodeURIComponent('시설물')}/accept`],
    ]) {
      const res = await req(r, url, { method });
      assert.equal(res.status, 302, `${method} ${url}`);
      assert.equal(new URL(res.headers.get('location'), 'http://localhost').pathname, '/welcome');
    }
  });
});
