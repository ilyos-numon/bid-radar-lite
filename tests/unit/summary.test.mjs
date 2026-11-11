// summary module: states, hooks, schema check, pages (isolated runtime, no network)
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { validateSummary } from '../../app/modules/summary/service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODULE_DIR = path.join(ROOT, 'app', 'modules', 'summary');
const DATE = '2026-10-29';

const TEXT = '본 사업은 수원시 가로수 전정 및 보호 사업입니다. 참가자격은 조경식재공사업 등록 업체입니다. 제출서류는 입찰참가신청서와 사업자등록증 사본입니다.';
const GOOD = {
  what: '수원시 가로수 전정 및 보호 사업',
  qualification: '조경식재공사업 등록 업체',
  documents: '입찰참가신청서, 사업자등록증 사본',
  evidence: [
    { field: 'what', quote: '수원시 가로수 전정 및 보호 사업' },
    { field: 'qualification', quote: '조경식재공사업 등록 업체' },
    { field: 'documents', quote: '입찰참가신청서와  사업자등록증 사본' },
  ],
};

const tmpRoots = [];
const runtimes = [];
after(async () => {
  for (const r of runtimes) await r.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function modulesDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'br-summary-'));
  tmpRoots.push(d);
  symlinkSync(MODULE_DIR, path.join(d, 'summary'), 'dir');
  return d;
}

/** responses: bidId → data object | {status, body} | Error */
function llmStub(responses) {
  const calls = [];
  const fn = async (url, init) => {
    const u = String(url);
    if (!u.endsWith('/chat/completions')) throw new Error('unexpected url ' + u);
    const body = JSON.parse(init.body);
    const input = JSON.parse(body.messages[1].content);
    calls.push({ task: body.messages[0].content.split('\n')[0], bidId: input.bidId, input });
    const r = responses[input.bidId];
    if (r instanceof Error) throw r;
    if (r && r.status) return new Response(r.body ?? 'err', { status: r.status });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(r ?? GOOD) } }] }));
  };
  fn.calls = calls;
  return fn;
}

async function rt(responses = {}, env = { LLM_API_BASE: 'x', LLM_API_KEY: 'x', LLM_MODEL: 'm' }) {
  const fetchImpl = llmStub(responses);
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir: modulesDir(),
    secret: 'x',
    jobToken: 't',
    env,
    fetchImpl,
    fakeNow: DATE,
  });
  runtimes.push(r);
  r.calls = fetchImpl.calls;
  r.summary = r.modules.find((m) => m.id === 'summary');
  return r;
}

async function addBid(r, no, { text = TEXT, status = 'ok' } = {}) {
  await r.ctx.bids.upsert(
    { bidNtceNo: no, bidNtceOrd: '000', bidNtceNm: `공고 ${no}`, dminsttNm: '경기도 수원시', bidClseDt: '2026-11-07 10:00:00', bidNtceDtlUrl: `https://www.g2b.go.kr/link/${no}` },
    'nara-cnstwk',
  );
  if (status !== null) {
    await r.ctx.db.run('INSERT INTO bid_texts (bid_id, status, text, fetched_at) VALUES ($1, $2, $3, $4)', [
      `${no}-000`,
      status,
      status === 'ok' ? text : '',
      r.ctx.now().toISOString(),
    ]);
  }
  return { bidId: `${no}-000`, title: `공고 ${no}`, org: '경기도 수원시', deadline: '2026-11-07 10:00:00', budget: null, url: '', reasons: ['키워드 일치'] };
}

const statusOf = async (r, bidId) => {
  const row = await r.ctx.db.get('SELECT status FROM summary_items WHERE bid_id = $1', [bidId]);
  return row ? row.status : null;
};

const run = (r, matched, maybe = null, dry = false) => r.summary.afterMatch(r.ctx, { date: DATE, matched, maybe, candidates: [], dry });

function req(r, url, init = {}) {
  return r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
}

async function login(r) {
  const res = await req(r, '/setup', { method: 'POST', body: new URLSearchParams({ company: '테스트 조경', name: '대표' }) });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

describe('summary states', () => {
  test('summary: ready when every quote is in the text', async () => {
    const r = await rt();
    const a = await addBid(r, '1001');
    await run(r, [a]);
    assert.equal(await statusOf(r, a.bidId), 'ready');
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].task, '[task:summary]');
    assert.equal(r.calls[0].input.text, TEXT);
    assert.equal(r.calls[0].input.title, '공고 1001');
  });

  test('summary: unverified when a quote is not in the text', async () => {
    const bad = { ...GOOD, evidence: [...GOOD.evidence, { field: 'documents', quote: '원문에 없는 구절' }] };
    const r = await rt({ '1002-000': bad });
    const a = await addBid(r, '1002');
    await run(r, [a]);
    assert.equal(await statusOf(r, a.bidId), 'unverified');
    const ev = JSON.parse((await r.ctx.db.get('SELECT evidence FROM summary_items WHERE bid_id = $1', [a.bidId])).evidence);
    assert.equal(ev.find((e) => e.quote === '원문에 없는 구절').found, false);
    assert.equal(ev[0].found, true);
  });

  test('summary: no_text without any call when text is none or failed', async () => {
    const r = await rt();
    const a = await addBid(r, '1003', { status: 'none' });
    const b = await addBid(r, '1004', { status: 'failed' });
    await run(r, [a, b]);
    assert.equal(await statusOf(r, a.bidId), 'no_text');
    assert.equal(await statusOf(r, b.bidId), 'no_text');
    assert.equal(r.calls.length, 0);
  });

  test('summary: failed on no key, http error, schema error', async () => {
    const r = await rt({ '1006-000': { status: 500 }, '1007-000': { what: 'x' } });
    const b = await addBid(r, '1006');
    const c = await addBid(r, '1007');
    await run(r, [b, c]);
    assert.equal(await statusOf(r, b.bidId), 'failed');
    assert.equal(await statusOf(r, c.bidId), 'failed');

    const nk = await rt({}, { LLM_API_BASE: '', LLM_API_KEY: '' });
    const a = await addBid(nk, '1005');
    await run(nk, [a]);
    assert.equal(await statusOf(nk, a.bidId), 'failed');
    assert.equal((await nk.ctx.db.get('SELECT error FROM summary_items WHERE bid_id = $1', [a.bidId])).error, 'NO_KEY');
    assert.equal(nk.calls.length, 0);
  });

  test('summary: ready is not requested again, others are retried', async () => {
    const r = await rt({ '1009-000': { status: 500 } });
    const a = await addBid(r, '1008');
    const b = await addBid(r, '1009');
    await run(r, [a, b]);
    await run(r, [a, b]);
    assert.equal(r.calls.filter((c) => c.bidId === a.bidId).length, 1);
    assert.equal(r.calls.filter((c) => c.bidId === b.bidId).length, 2);
  });

  test('summary: dry run calls and stores nothing', async () => {
    const r = await rt();
    const a = await addBid(r, '1010');
    await run(r, [a], null, true);
    assert.equal(r.calls.length, 0);
    assert.equal(await statusOf(r, a.bidId), null);
  });

  test('summary: one failing bid does not block the others, maybe included', async () => {
    const r = await rt({ '1011-000': new Error('offline') });
    const a = await addBid(r, '1011');
    const b = await addBid(r, '1012');
    const m = await addBid(r, '1013');
    const orig = r.ctx.bidText.get;
    r.ctx.bidText.get = async (id) => {
      if (id === b.bidId) throw new Error('boom');
      return orig(id);
    };
    await run(r, [a, b], m);
    assert.equal(await statusOf(r, a.bidId), 'failed');
    assert.equal(await statusOf(r, b.bidId), 'failed');
    assert.equal(await statusOf(r, m.bidId), 'ready');
  });
});

describe('summary hooks', () => {
  test('summary: badge text and extras only when ready', async () => {
    const bad = { ...GOOD, evidence: [{ field: 'what', quote: '없는 구절' }] };
    const r = await rt({ '2002-000': bad });
    const a = await addBid(r, '2001');
    const b = await addBid(r, '2002');
    const c = await addBid(r, '2003', { status: 'none' });
    const d = await addBid(r, '2004', { status: null });
    await run(r, [a, b, c]);
    assert.deepEqual(await r.summary.decorate(r.ctx, a.bidId, null), { label: '요약 보기', href: '/summary/2001-000' });
    assert.deepEqual(await r.summary.decorate(r.ctx, b.bidId, null), { label: '요약 확인 필요', href: '/summary/2002-000' });
    assert.equal(await r.summary.decorate(r.ctx, c.bidId, null), null);
    assert.equal(await r.summary.decorate(r.ctx, d.bidId, null), null);
    assert.deepEqual(await r.summary.notifyLines(r.ctx, a.bidId, DATE), ['요약: ' + GOOD.what]);
    assert.deepEqual(await r.summary.notifyLines(r.ctx, b.bidId, DATE), []);
    assert.deepEqual(await r.summary.notifyLines(r.ctx, c.bidId, DATE), []);
    assert.deepEqual(await r.summary.notifyLines(r.ctx, d.bidId, DATE), []);
  });
});

describe('summary schema check', () => {
  test('summary: valid data passes', () => {
    assert.deepEqual(validateSummary(GOOD), []);
  });
  test('summary: missing field, over 200 chars, no evidence, bad field fail', () => {
    const { what, ...noWhat } = GOOD;
    assert.ok(what);
    assert.ok(validateSummary(noWhat).length > 0);
    assert.ok(validateSummary({ ...GOOD, documents: '가'.repeat(201) }).length > 0);
    assert.deepEqual(validateSummary({ ...GOOD, documents: '가'.repeat(200) }), []);
    assert.ok(validateSummary({ ...GOOD, evidence: [] }).length > 0);
    assert.ok(validateSummary({ ...GOOD, evidence: undefined }).length > 0);
    assert.ok(validateSummary({ ...GOOD, evidence: [{ field: 'other', quote: 'a' }] }).length > 0);
    assert.ok(validateSummary(null).length > 0);
  });
});

describe('summary pages', () => {
  test('summary: login required → /welcome', async () => {
    const r = await rt();
    await addBid(r, '3001');
    for (const url of ['/summary', '/summary/3001-000']) {
      const res = await req(r, url);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/welcome');
    }
    const post = await req(r, '/summary/3001-000/regenerate', { method: 'POST' });
    assert.equal(post.status, 302);
    assert.equal(r.calls.length, 0);
  });

  test('summary: empty list shows empty state with link to today', async () => {
    const r = await rt();
    const cookie = await login(r);
    const res = await req(r, '/summary', { headers: { cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(html.includes('요약할 공고가 아직 없습니다.'));
    assert.ok(html.includes('href="/today"'));
    assert.ok(html.includes('오늘의 공고 보기'));
  });

  test('summary: list shows latest matched bids with links', async () => {
    const r = await rt();
    const cookie = await login(r);
    const a = await addBid(r, '3002');
    await r.ctx.matches.save(DATE, [a], null);
    await run(r, [a]);
    const html = await (await req(r, '/summary', { headers: { cookie } })).text();
    assert.ok(html.includes('href="/summary/3002-000"'));
    assert.ok(html.includes(GOOD.what));
  });

  test('summary: detail pages for each state and one primary button', async () => {
    const bad = { ...GOOD, evidence: [{ field: 'what', quote: '없는 구절' }] };
    const r = await rt({ '3004-000': bad, '3006-000': { status: 500 } });
    const cookie = await login(r);
    const ready = await addBid(r, '3003');
    const unv = await addBid(r, '3004');
    const none = await addBid(r, '3005', { status: 'none' });
    const fail = await addBid(r, '3006');
    await run(r, [ready, unv, none, fail]);
    const page = async (id) => {
      const res = await req(r, '/summary/' + id, { headers: { cookie } });
      assert.equal(res.status, 200);
      return res.text();
    };
    const h1 = await page(ready.bidId);
    assert.ok(h1.includes('근거 보기'));
    assert.ok(h1.includes(GOOD.qualification));
    assert.ok(h1.includes('조경식재공사업 등록 업체'));
    assert.equal((h1.match(/<button/g) || []).length, 1);
    assert.ok(h1.includes('요약 다시 만들기'));
    assert.ok(!h1.includes('role="alert"'));

    const h2 = await page(unv.bidId);
    assert.ok(h2.includes('근거를 원문에서 찾지 못했습니다. 원문을 직접 확인해 주세요.'));
    assert.ok(h2.indexOf('근거를 원문에서') < h2.indexOf(GOOD.what));

    const h3 = await page(none.bidId);
    assert.ok(h3.includes('공고문 첨부를 읽지 못했습니다. 원문 보기에서 직접 확인해 주세요.'));
    assert.ok(h3.includes('href="https://www.g2b.go.kr/link/3005"'));

    const h4 = await page(fail.bidId);
    assert.ok(h4.includes('자동 요약을 만들지 못했습니다.'));
    assert.ok(!/HTTP_|NO_KEY|SCHEMA/.test(h4));
    assert.equal((h4.match(/role="alert"/g) || []).length, 1);
  });

  test('summary: no key detail message', async () => {
    const r = await rt({}, { LLM_API_BASE: '', LLM_API_KEY: '' });
    const cookie = await login(r);
    const a = await addBid(r, '3007');
    await run(r, [a]);
    const html = await (await req(r, '/summary/' + a.bidId, { headers: { cookie } })).text();
    assert.ok(html.includes('자동 요약이 아직 준비되지 않았습니다. 원문 보기로 확인하세요.'));
  });

  test('summary: regenerate re-runs even when ready and redirects 303', async () => {
    const r = await rt();
    const cookie = await login(r);
    const a = await addBid(r, '3008');
    await run(r, [a]);
    const res = await req(r, '/summary/3008-000/regenerate', { method: 'POST', headers: { cookie } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/summary/3008-000');
    assert.equal(r.calls.length, 2);
    assert.equal(await statusOf(r, a.bidId), 'ready');
  });

  test('summary: unknown bid is a Korean 404 page', async () => {
    const r = await rt();
    const cookie = await login(r);
    const res = await req(r, '/summary/nope-000', { headers: { cookie } });
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.ok(html.includes('찾는 공고가 없습니다.'));
    const post = await req(r, '/summary/nope-000/regenerate', { method: 'POST', headers: { cookie } });
    assert.equal(post.status, 404);
    assert.equal(r.calls.length, 0);
  });
});
