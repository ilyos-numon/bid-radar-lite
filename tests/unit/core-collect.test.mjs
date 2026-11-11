import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { normalizeBid } from '../../app/core/normalize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NARA_DIR = path.join(ROOT, 'tests/fixtures/nara');
const fx = (name) => readFileSync(path.join(NARA_DIR, name), 'utf8');
const P1 = fx('list-cnstwk-p1.json');
const P2 = fx('list-cnstwk-p2.json');
const CHANGED = fx('list-cnstwk-changed.json');
const LICENSE = fx('license-limit.json');
const REGION = fx('region-limit.json');
const BASE_AMOUNT = fx('base-amount.json');
const PRESTD = fx('prestd-cnstwk.json');
const ERR22 = fx('error-22.json');
const ERR30 = fx('error-30.json');
const EMPTY = JSON.stringify({ response: { header: { resultCode: '00', resultMsg: '정상' }, body: { items: [], numOfRows: 500, pageNo: 1, totalCount: 0 } } });
const QUOTA_MSG = '공고를 가져오지 못했습니다 (오늘 조회 한도를 넘었습니다). 내일 다시 시도하거나 운영자에게 알려 주세요.';

const ENV = { NARA_API_KEY: 'dummy-key', NARA_API_BASE: 'http://nara.test/svc', NARA_PRESTD_BASE: 'http://nara.test/prestd' };
const SINCE = new Date('2026-11-01T00:00:00+09:00');

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

/** handler({op, div, page, url}) → Response | Error(throw) */
function stubFetch(handler) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(String(url));
    const call = {
      url: String(url),
      op: u.pathname.split('/').pop(),
      div: u.searchParams.get('inqryDiv'),
      page: u.searchParams.get('pageNo'),
      rows: u.searchParams.get('numOfRows'),
    };
    calls.push(call);
    const out = handler(call);
    if (out instanceof Error) throw out;
    return out;
  };
  fn.calls = calls;
  return fn;
}

const json = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/json' } });

/** 공사 목록 p1/p2 + 변경 목록 + 보조 3개 */
function fullRoutes({ changed = CHANGED } = {}) {
  return ({ op, div, page }) => {
    if (op === 'getBidPblancListInfoCnstwk') {
      if (div === '3') return json(changed);
      return json(page === '2' ? P2 : P1);
    }
    if (op === 'getBidPblancListInfoLicenseLimit') return json(LICENSE);
    if (op === 'getBidPblancListInfoPrtcptPsblRgn') return json(REGION);
    if (op === 'getBidPblancListInfoCnstwkBsisAmount') return json(BASE_AMOUNT);
    if (op === 'getPublicPrcureThngInfoCnstwk') return json(PRESTD);
    return new Response('not found', { status: 404 });
  };
}

async function rt({ env = ENV, fetchImpl, fakeNow = '2026-11-02' } = {}) {
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir: tmp('br-mod-'),
    secret: 'x',
    jobToken: 't',
    env,
    fetchImpl,
    fakeNow,
  });
  runtimes.push(r);
  return r;
}

const nara = (r) => r.ctx.sources.adapters().find((a) => a.type === 'nara');
const fetchCnstwk = (r, f, env = r.ctx.env) =>
  nara(r).fetch({ operation: 'getBidPblancListInfoCnstwk' }, { since: SINCE, fetchImpl: f, env });

describe('collect paging', () => {
  test('paging: totalCount 650 / rows 500 → pageNo=2 requested, 650 unique bids', async () => {
    const f = stubFetch(fullRoutes({ changed: EMPTY }));
    const r = await rt({ fetchImpl: f });
    const out = await fetchCnstwk(r, f);
    const list = f.calls.filter((c) => c.op === 'getBidPblancListInfoCnstwk' && c.div === '1');
    assert.deepEqual(list.map((c) => c.page), ['1', '2']);
    assert.ok(list.every((c) => c.rows === '500'));
    assert.equal(out.length, 650);
    assert.equal(new Set(out.map((b) => `${b.bidNtceNo}-${b.bidNtceOrd}`)).size, 650);
    assert.equal(out.pages, 3); // 목록 2페이지 + 변경일시 1페이지
    assert.equal(out.truncated, false);
  });

  test('paging: NARA_MAX_PAGES=2 with NARA_ROWS=300 → truncated, collect_days truncated=1, partial message', async () => {
    const env = { ...ENV, NARA_MAX_PAGES: '2', NARA_ROWS: '300' };
    const f = stubFetch(fullRoutes({ changed: EMPTY }));
    const r = await rt({ env, fetchImpl: f });
    await r.ctx.sources.update('nara-prestd', { enabled: false });
    const n = await r.ctx.jobs.runDaily({ date: '2026-11-02' });
    const list = f.calls.filter((c) => c.op === 'getBidPblancListInfoCnstwk' && c.div === '1');
    assert.deepEqual(list.map((c) => c.page), ['1', '2']);
    const day = await r.ctx.db.get("SELECT * FROM collect_days WHERE source_id = 'nara-cnstwk'");
    assert.equal(day.day, '2026-11-02');
    assert.equal(Number(day.ok), 1);
    assert.equal(Number(day.truncated), 1);
    assert.equal(Number(day.pages), 3);
    assert.equal(Number(day.count), 650);
    const msg = '공고가 많아 일부만 가져왔습니다 (3페이지). 운영자에게 알려 주세요.';
    assert.deepEqual(n.warnings, [msg]);
    assert.ok(n.text.includes(`─ 수집 알림 ─\n${msg}`));
    const [run] = await r.ctx.sources.runs('nara-cnstwk', 1);
    assert.equal(run.ok, true);
    assert.equal(run.error, msg);
  });

  test('paging: request cap is 5 * NARA_MAX_PAGES per run', async () => {
    const env = { ...ENV, NARA_MAX_PAGES: '1', NARA_ROWS: '1' };
    const big = JSON.stringify({
      response: { header: { resultCode: '00', resultMsg: '정상' }, body: { items: [JSON.parse(P1).response.body.items[0]], numOfRows: 1, pageNo: 1, totalCount: 999 } },
    });
    const f = stubFetch(() => json(big));
    const r = await rt({ env, fetchImpl: f });
    const out = await fetchCnstwk(r, f);
    assert.equal(f.calls.length, 5);
    assert.equal(out.truncated, true);
  });
});

describe('collect merge', () => {
  test('change: inqryDiv 1 + 3 merged by bidId (changed / cancelled / rebid kept once)', async () => {
    const f = stubFetch(fullRoutes());
    const r = await rt({ fetchImpl: f });
    const out = await fetchCnstwk(r, f);
    assert.deepEqual(f.calls.filter((c) => c.op === 'getBidPblancListInfoCnstwk').map((c) => c.div), ['1', '1', '3']);
    assert.equal(out.length, 653);
    const kinds = out.map((b) => normalizeBid(b, 'nara-cnstwk')).filter((n) => n.kind !== 'new').map((n) => [n.bidId, n.kind]);
    assert.deepEqual(kinds, [
      ['R26BK01900002-001', 'changed'],
      ['R26BK01900003-001', 'cancelled'],
      ['R26BK01900660-000', 'rebid'],
    ]);
    const twice = stubFetch(({ op, div }) => (op === 'getBidPblancListInfoCnstwk' ? json(div === '3' ? P1 : P1) : json(EMPTY)));
    const dup = await fetchCnstwk(r, twice);
    assert.equal(dup.length, 500);
  });

  test('auxiliary operations: licence, region, base amount merged on bidNtceNo+bidNtceOrd', async () => {
    const f = stubFetch(fullRoutes());
    const r = await rt({ fetchImpl: f });
    const out = await fetchCnstwk(r, f);
    const ops = new Set(f.calls.map((c) => c.op));
    for (const op of ['getBidPblancListInfoLicenseLimit', 'getBidPblancListInfoPrtcptPsblRgn', 'getBidPblancListInfoCnstwkBsisAmount']) assert.ok(ops.has(op), op);
    const byId = new Map(out.map((b) => [`${b.bidNtceNo}-${b.bidNtceOrd}`, b]));
    const b2 = byId.get('R26BK01900002-000');
    assert.deepEqual(b2.lcnsLmtList.map((x) => x.lcnsLmtNm), ['조경식재공사업/4993', '조경시설물설치공사업/4994']);
    assert.deepEqual(b2.prtcptPsblRgnList.map((x) => x.prtcptPsblRgnNm), ['서울특별시', '경기도']);
    assert.equal(b2.bssamt, '418000000');
    const n2 = normalizeBid(b2, 'nara-cnstwk');
    assert.deepEqual(n2.limits.regions, ['서울', '경기']);
    assert.deepEqual(n2.limits.licenses, [
      { name: '조경식재공사업', code: '4993' },
      { name: '조경시설물설치공사업', code: '4994' },
    ]);
    assert.equal(n2.amounts.base, 418000000);
    const plain = byId.get('R26BK01900100-000');
    assert.equal(plain.lcnsLmtList, undefined);
    assert.equal(plain.prtcptPsblRgnList, undefined);
  });

  test('auxiliary failure does not fail the list', async () => {
    const routes = fullRoutes();
    const f = stubFetch((c) => (c.op === 'getBidPblancListInfoLicenseLimit' ? json(ERR30) : routes(c)));
    const r = await rt({ fetchImpl: f });
    const out = await fetchCnstwk(r, f);
    assert.equal(out.length, 653);
    const b2 = out.find((b) => b.bidNtceNo === 'R26BK01900002' && b.bidNtceOrd === '000');
    assert.equal(b2.lcnsLmtList, undefined);
    assert.equal(b2.prtcptPsblRgnList.length, 2);
  });
});

describe('collect retry', () => {
  test('retry: network failure once then success → ok=1', async () => {
    let failed = false;
    const routes = fullRoutes({ changed: EMPTY });
    const f = stubFetch((c) => {
      if (!failed) {
        failed = true;
        return new TypeError('fetch failed');
      }
      return routes(c);
    });
    const r = await rt({ fetchImpl: f });
    await r.ctx.sources.update('nara-prestd', { enabled: false });
    const res = await r.ctx.sources.fetchNow('nara-cnstwk');
    assert.deepEqual(res, { ok: true, count: 650, error: null });
    const [run] = await r.ctx.sources.runs('nara-cnstwk', 1);
    assert.equal(run.ok, true);
    assert.equal(f.calls[0].page, '1');
    assert.equal(f.calls[1].page, '1');
  });

  test('retry: resultCode 22 → one request, quota message (no retry)', async () => {
    const f = stubFetch(() => json(ERR22));
    const r = await rt({ fetchImpl: f });
    await r.ctx.sources.update('nara-prestd', { enabled: false });
    const res = await r.ctx.sources.fetchNow('nara-cnstwk');
    assert.equal(f.calls.length, 1);
    assert.equal(res.ok, false);
    assert.equal(res.error, QUOTA_MSG);
    assert.ok(res.error.includes('오늘 조회 한도'));
    assert.equal((await r.ctx.sources.runs('nara-cnstwk', 1))[0].error, QUOTA_MSG);
  });

  test('retry: gateway 22 as HTTP 429 + OpenAPI_ServiceResponse XML → one request, quota message', async () => {
    const xml =
      '<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg><returnAuthMsg>LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR</returnAuthMsg><returnReasonCode>22</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>';
    const f = stubFetch(() => new Response(xml, { status: 429, headers: { 'content-type': 'text/xml' } }));
    const r = await rt({ fetchImpl: f });
    await assert.rejects(fetchCnstwk(r, f), (e) => e.message.startsWith('SOURCE_ERROR: NARA_API_ERROR: 22'));
    assert.equal(f.calls.length, 1);
  });

  test('retry: gateway 30 as HTTP 401 + OpenAPI_ServiceResponse JSON → one request, code 30 message', async () => {
    const body = JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: 'SERVICE ERROR', returnAuthMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', returnReasonCode: '30' } } });
    const f = stubFetch(() => json(body, 401));
    const r = await rt({ fetchImpl: f });
    await r.ctx.sources.update('nara-prestd', { enabled: false });
    const res = await r.ctx.sources.fetchNow('nara-cnstwk');
    assert.equal(f.calls.length, 1);
    assert.equal(res.ok, false);
    assert.ok(res.error.includes('나라장터 응답 오류 30'), res.error);
  });

  test('retry: HTTP 503 retried NARA_RETRY times then fails; HTTP 404 not retried', async () => {
    const f = stubFetch(() => new Response('busy', { status: 503 }));
    const r = await rt({ env: { ...ENV, NARA_RETRY: '1' }, fetchImpl: f });
    await assert.rejects(fetchCnstwk(r, f), (e) => e.message === 'SOURCE_ERROR: NARA_API_ERROR: 503');
    assert.equal(f.calls.length, 2);
    const g = stubFetch(() => new Response('nope', { status: 404 }));
    await assert.rejects(fetchCnstwk(r, g), (e) => e.message === 'SOURCE_ERROR: NARA_API_ERROR: 404');
    assert.equal(g.calls.length, 1);
  });
});

describe('prestd source', () => {
  test('nara-prestd: reads prestd service, items become kind prestd with PS bidId', async () => {
    const f = stubFetch(fullRoutes({ changed: EMPTY }));
    const r = await rt({ fetchImpl: f });
    await r.ctx.sources.update('nara-cnstwk', { enabled: false });
    const res = await r.ctx.sources.fetchNow('nara-prestd');
    assert.deepEqual(res, { ok: true, count: 3, error: null });
    assert.equal(f.calls.length, 1);
    const u = new URL(f.calls[0].url);
    assert.equal(u.pathname, '/prestd/getPublicPrcureThngInfoCnstwk');
    assert.equal(u.searchParams.get('inqryDiv'), '1');
    const b = await r.ctx.bids.get('PSR26BD00900001-000');
    assert.ok(b);
    assert.equal(b.kind, 'prestd');
    assert.equal(b.title, '수원시 공원 조경 정비공사');
    assert.equal(b.sourceId, 'nara-prestd');
  });

  test('nara-prestd: default base is the ao/ service address', async () => {
    const f = stubFetch(() => json(EMPTY));
    const r = await rt({ env: { NARA_API_KEY: 'k' }, fetchImpl: f });
    await nara(r).fetch((await r.ctx.sources.get('nara-prestd')).config, { since: SINCE, fetchImpl: f, env: r.ctx.env });
    assert.ok(f.calls[0].url.startsWith('https://apis.data.go.kr/1230000/ao/HrcspSsstndrdInfoService/getPublicPrcureThngInfoCnstwk?'));
  });

  test('until is used as the window end; default is since + 24h', async () => {
    const f = stubFetch(() => json(EMPTY));
    const r = await rt({ fetchImpl: f });
    await nara(r).fetch({ operation: 'getBidPblancListInfoServc' }, { since: SINCE, until: new Date('2026-11-01T12:00:00+09:00'), fetchImpl: f, env: r.ctx.env });
    const u = new URL(f.calls[0].url);
    assert.equal(u.searchParams.get('inqryBgnDt'), '202611010000');
    assert.equal(u.searchParams.get('inqryEndDt'), '202611011200');
    await nara(r).fetch({ operation: 'getBidPblancListInfoServc' }, { since: SINCE, fetchImpl: f, env: r.ctx.env });
    assert.equal(new URL(f.calls[2].url).searchParams.get('inqryEndDt'), '202611020000');
  });
});
