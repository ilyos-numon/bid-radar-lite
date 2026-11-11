import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { toRow, toAward, mergeAwards, cleanDays, cleanQuery, OPERATION, AWARD_OPERATION } from '../../app/modules/history/service.mjs';
import { DISCLAIMER, LEGEND, BADGE_LABEL, TEXT, ERROR } from '../../app/modules/history/view.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NARA = path.join(ROOT, 'tests/fixtures/nara');
const RESULT = JSON.parse(readFileSync(path.join(NARA, 'openg-result-cnstwk.json'), 'utf8'));
const SCSBID = JSON.parse(readFileSync(path.join(NARA, 'scsbid-list-cnstwk.json'), 'utf8'));
const ERR22 = JSON.parse(readFileSync(path.join(NARA, 'error-22.json'), 'utf8'));
const BIDS = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/nara-bids.json'), 'utf8'));
const ENV = { NARA_API_KEY: 'dummy-key' };

const tmpRoots = [];
const runtimes = [];
after(async () => {
  for (const r of runtimes) await r.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** history 모듈 하나만 든 임시 modules 디렉토리 (심볼릭 링크: p-retry·src 상대 import 가 원래 위치에서 풀리게) */
function historyOnly() {
  const d = mkdtempSync(path.join(tmpdir(), 'br-history-'));
  tmpRoots.push(d);
  symlinkSync(path.join(ROOT, 'app/modules/history'), path.join(d, 'history'), 'dir');
  return d;
}

/** 오퍼레이션 이름(경로 마지막 칸) */
const opOf = (url) => new URL(url).pathname.split('/').pop();

/**
 * 나라장터 스텁. 개찰결과 요청에는 responses 를, 낙찰 목록 요청(경로 끝이 개찰결과 오퍼레이션이 아님)에는 award 를
 * 요청 순서대로 쓰고 마지막 것을 반복한다 (함수면 호출 결과)
 */
function stubWith({ openg = [RESULT], award = [SCSBID] } = {}) {
  const urls = [];
  const opengUrls = [];
  const awardUrls = [];
  const pick = (list, n) => list[Math.min(n - 1, list.length - 1)];
  const fn = async (url) => {
    const u = String(url);
    urls.push(u);
    let r;
    if (opOf(u) === OPERATION) {
      opengUrls.push(u);
      r = pick(openg, opengUrls.length);
    } else {
      awardUrls.push(u);
      r = pick(award, awardUrls.length);
    }
    if (typeof r === 'function') return r(u);
    return Response.json(r);
  };
  fn.urls = urls;
  fn.opengUrls = opengUrls;
  fn.awardUrls = awardUrls;
  return fn;
}

function stub(...responses) {
  return stubWith(responses.length > 0 ? { openg: responses } : {});
}

async function rt(fetchImpl = stub(), env = ENV) {
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir: historyOnly(),
    secret: 'x',
    jobToken: 't',
    env,
    fetchImpl,
    fakeNow: '2026-10-29',
  });
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

const cookies = new WeakMap();
async function page(r, url) {
  if (!cookies.has(r)) cookies.set(r, await login(r));
  const cookie = cookies.get(r);
  const res = await req(r, url, { headers: { cookie } });
  return { status: res.status, html: await res.text() };
}

/** 표의 행 (<tbody> 안 <tr>) 을 [공고명칸, 개찰일시, 참가수, 낙찰자 / 개찰 1순위, 금액, 낙찰률 · 투찰률] 글자로 */
function tableRows(html) {
  const body = /<tbody>([\s\S]*?)<\/tbody>/.exec(html);
  if (!body) return [];
  return [...body[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()),
  );
}

const mod = (r) => r.modules.find((m) => m.id === 'history');

describe('history: module', () => {
  test('menu 지난 개찰 in group 공고 더 알기, order 23, path /history', async () => {
    const r = await rt();
    const m = mod(r);
    assert.ok(m, 'history module loaded');
    assert.equal(m.title, '지난 개찰');
    assert.equal(m.group, '공고 더 알기');
    assert.equal(m.order, 23);
    assert.equal(m.path, '/history');
    assert.ok((await r.ctx.db.get("SELECT to_regclass('history_results') IS NOT NULL AS ok")).ok);
  });

  test('login required', async () => {
    const r = await rt();
    const res = await req(r, '/history?q=수원시');
    assert.ok([302, 303].includes(res.status), `status ${res.status}`);
  });
});

describe('history: search (S9)', () => {
  test('수원시 → 낙찰자 업체E with award amount, rate, disclaimer and legend', async () => {
    const f = stub();
    const r = await rt(f);
    const { status, html } = await page(r, '/history?q=' + encodeURIComponent('수원시'));
    assert.equal(status, 200);
    assert.ok(html.includes(DISCLAIMER), 'disclaimer shown');
    assert.ok(html.includes(LEGEND), 'legend shown');
    assert.ok(html.indexOf(DISCLAIMER) < html.indexOf(LEGEND) && html.indexOf(LEGEND) < html.indexOf('role="search"'), 'disclaimer → legend → form');
    assert.equal(f.urls.length, 2, 'one page each: openings + awards');
    assert.equal(f.opengUrls.length, 1);
    assert.equal(f.awardUrls.length, 1);
    const a = new URL(f.awardUrls[0]);
    assert.equal(a.pathname, `/1230000/as/ScsbidInfoService/${AWARD_OPERATION}`);
    assert.equal(a.searchParams.get('inqryDiv'), '1');
    assert.equal(a.searchParams.get('inqryBgnDt'), '202609290000');
    assert.equal(a.searchParams.get('inqryEndDt'), '202610292359');
    assert.equal(a.searchParams.get('pageNo'), '1');
    const u = new URL(f.opengUrls[0]);
    assert.equal(u.pathname, `/1230000/as/ScsbidInfoService/${OPERATION}`);
    assert.equal(u.searchParams.get('serviceKey'), 'dummy-key');
    assert.equal(u.searchParams.get('pageNo'), '1');
    assert.equal(u.searchParams.get('inqryBgnDt'), '202609290000');
    assert.equal(u.searchParams.get('inqryEndDt'), '202610292359');
    const rows = tableRows(html);
    // fixture 의 수원시 개찰 결과는 1건 (업체E)
    assert.equal(rows.length, 1);
    assert.ok(rows[0][0].includes('수원시 도로 포장 보수공사'));
    assert.ok(rows[0][1].includes('10/25'), rows[0][1]);
    assert.equal(rows[0][2], '97곳');
    assert.equal(rows[0][3], '낙찰자 업체E');
    assert.equal(rows[0][4], '129,800,000원');
    assert.equal(rows[0][5], '86.774%');
    assert.ok(html.includes('<span class="kind-chip kind-awarded">낙찰자</span> 업체E'), 'awarded chip');
    for (const t of Object.values(TEXT.col)) assert.ok(html.includes(`<th scope="col">${t}</th>`), t);
  });

  test('공고명으로 찾기: 군 → 3 rows, latest opening first', async () => {
    const r = await rt();
    const rows = tableRows((await page(r, '/history?q=' + encodeURIComponent('군'))).html);
    assert.deepEqual(rows.map((x) => x[3]), ['개찰 1순위 업체C', '개찰 1순위 업체B', '낙찰자 업체A']);
    const html = (await page(r, '/history?q=' + encodeURIComponent('단양군'))).html;
    assert.ok(html.includes('<span class="kind-chip kind-top">개찰 1순위</span> 업체B'), 'top chip');
    assert.equal(tableRows(html)[0][4], '352,100,000원');
    assert.equal(tableRows(html)[0][5], '86.981%');
  });

  test('awards list fails (404) → guidance, every row 개찰 1순위, not cached', async () => {
    const f = stubWith({ award: [() => new Response('not found', { status: 404 })] });
    const r = await rt(f);
    const { status, html } = await page(r, '/history?q=' + encodeURIComponent('군'));
    assert.equal(status, 200);
    assert.ok(html.includes(TEXT.awardsMissing), 'awardsMissing notice');
    assert.ok(html.indexOf('role="status"') > -1 && html.indexOf('role="status"') < html.indexOf(TEXT.awardsMissing), 'status role');
    const rows = tableRows(html);
    assert.deepEqual(rows.map((x) => x[3]), ['개찰 1순위 업체C', '개찰 1순위 업체B', '개찰 1순위 업체A']);
    assert.equal(f.awardUrls.length, 1, '4xx is not retried');
    assert.equal((await r.ctx.db.get('SELECT COUNT(*) AS n FROM history_results')).n, 0, 'not cached');
    await page(r, '/history?q=' + encodeURIComponent('군'));
    assert.equal(f.opengUrls.length, 2, 'fetched again (no cache)');
  });

  test('openings fail → error, awards not requested', async () => {
    const f = stubWith({ openg: [ERR22] });
    const r = await rt(f);
    const { html } = await page(r, '/history?q=' + encodeURIComponent('수원시'));
    assert.ok(html.includes(ERROR.quota));
    assert.equal(f.awardUrls.length, 0);
  });

  test('no match → empty message, no table', async () => {
    const r = await rt();
    const { html } = await page(r, '/history?q=' + encodeURIComponent('제주시'));
    assert.equal(tableRows(html).length, 0);
    assert.ok(html.includes('와 맞는 개찰 결과가 없습니다'));
  });

  test('empty query → form only, 0 requests', async () => {
    const f = stub();
    const r = await rt(f);
    const { html } = await page(r, '/history');
    assert.equal(f.urls.length, 0);
    assert.ok(html.includes(TEXT.needQuery));
    assert.ok(html.includes(DISCLAIMER));
  });

  test('no key → 0 requests + guidance', async () => {
    const f = stub();
    const r = await rt(f, {});
    const { html } = await page(r, '/history?q=' + encodeURIComponent('수원시'));
    assert.equal(f.urls.length, 0);
    assert.ok(html.includes(TEXT.noKey));
    assert.ok(html.includes(DISCLAIMER));
  });

  test('does not compute any likelihood', async () => {
    const r = await rt();
    const { html } = await page(r, '/history?q=' + encodeURIComponent('공사'));
    for (const w of ['확률', '예측', '추천 투찰', '적정 투찰']) assert.ok(!html.includes(w), w);
  });
});

describe('history: cache', () => {
  test('same query within 24h → cache hit, 0 extra requests', async () => {
    const f = stub();
    const r = await rt(f);
    const url = '/history?q=' + encodeURIComponent('수원시') + '&days=30';
    await page(r, url);
    assert.equal(f.urls.length, 2);
    const { html } = await page(r, url);
    assert.equal(f.urls.length, 2, 'served from cache');
    assert.ok(html.includes(TEXT.cached));
    assert.ok(!html.includes(TEXT.awardsMissing));
    assert.equal(tableRows(html)[0][3], '낙찰자 업체E');
    const row = await r.ctx.db.get('SELECT query_key FROM history_results');
    assert.equal(row.query_key, 'v2|수원시|30');
  });

  test('old v1 cache key is ignored', async () => {
    const f = stub();
    const r = await rt(f);
    await r.ctx.db.run('INSERT INTO history_results (query_key, fetched_at, rows) VALUES ($1, $2, $3)', [
      '수원시|30',
      r.ctx.now().toISOString(),
      JSON.stringify({ rows: [], truncated: 0 }),
    ]);
    const { html } = await page(r, '/history?q=' + encodeURIComponent('수원시') + '&days=30');
    assert.equal(f.opengUrls.length, 1);
    assert.equal(tableRows(html)[0][3], '낙찰자 업체E');
  });

  test('older than 24h → fetch again', async () => {
    const f = stub();
    const r = await rt(f);
    const url = '/history?q=' + encodeURIComponent('수원시');
    await page(r, url);
    await r.ctx.db.run("UPDATE history_results SET fetched_at = '2026-10-27T00:00:00.000Z'");
    await page(r, url);
    assert.equal(f.opengUrls.length, 2);
    assert.equal(f.awardUrls.length, 2);
  });

  test('errors are not cached', async () => {
    const f = stub(ERR22, RESULT);
    const r = await rt(f);
    const url = '/history?q=' + encodeURIComponent('수원시');
    const first = await page(r, url);
    assert.ok(first.html.includes('오늘 조회 한도'));
    assert.equal(f.urls.length, 1, 'quota error is not retried');
    const second = await page(r, url);
    assert.equal(f.opengUrls.length, 2);
    assert.equal(tableRows(second.html).length, 1);
  });
});

describe('history: requests', () => {
  test('paging stops at NARA_MAX_PAGES and says truncated (≤ NARA_MAX_PAGES × 2 requests)', async () => {
    const many = structuredClone(RESULT);
    many.response.body.totalCount = 5000;
    const manyAwards = structuredClone(SCSBID);
    manyAwards.response.body.totalCount = 5000;
    const f = stubWith({ openg: [many], award: [manyAwards] });
    const r = await rt(f, { ...ENV, NARA_MAX_PAGES: '2', NARA_ROWS: '5' });
    const { html } = await page(r, '/history?q=' + encodeURIComponent('수원시'));
    assert.ok(f.urls.length <= 4, `requests ${f.urls.length}`);
    assert.equal(f.opengUrls.length, 2);
    assert.equal(f.awardUrls.length, 2);
    assert.equal(new URL(f.opengUrls[1]).searchParams.get('pageNo'), '2');
    assert.equal(new URL(f.opengUrls[1]).searchParams.get('numOfRows'), '5');
    assert.equal(new URL(f.awardUrls[1]).searchParams.get('pageNo'), '2');
    assert.equal(new URL(f.awardUrls[1]).searchParams.get('numOfRows'), '5');
    assert.ok(html.includes(TEXT.truncated(2)));
  });

  test('retry: network failure once then success', async () => {
    const f = stub(() => {
      throw new TypeError('fetch failed');
    }, RESULT);
    const r = await rt(f);
    const { html } = await page(r, '/history?q=' + encodeURIComponent('수원시'));
    assert.equal(f.opengUrls.length, 2);
    assert.equal(tableRows(html).length, 1);
  });

  test('retry: awards network failure once then success', async () => {
    const f = stubWith({
      award: [
        () => {
          throw new TypeError('fetch failed');
        },
        SCSBID,
      ],
    });
    const r = await rt(f);
    const { html } = await page(r, '/history?q=' + encodeURIComponent('수원시'));
    assert.equal(f.awardUrls.length, 2);
    assert.equal(tableRows(html)[0][3], '낙찰자 업체E');
    assert.ok(!html.includes(TEXT.awardsMissing));
  });

  test('gateway 4xx (OpenAPI_ServiceResponse 30) → not registered message, 1 request', async () => {
    const gw = { OpenAPI_ServiceResponse: { cmmMsgHeader: { errMsg: 'SERVICE ERROR', returnAuthMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', returnReasonCode: '30' } } };
    const f = stub(() => Response.json(gw, { status: 401 }));
    const r = await rt(f);
    const { html } = await page(r, '/history?q=' + encodeURIComponent('수원시'));
    assert.equal(f.urls.length, 1);
    assert.equal(f.awardUrls.length, 0);
    assert.ok(html.includes(ERROR.notRegistered));
  });

  test('NARA_SCSBID_BASE overrides the service address', async () => {
    const f = stub();
    const r = await rt(f, { ...ENV, NARA_SCSBID_BASE: 'http://nara.test/scsbid/' });
    await page(r, '/history?q=' + encodeURIComponent('수원시'));
    assert.ok(f.opengUrls[0].startsWith(`http://nara.test/scsbid/${OPERATION}?`), f.opengUrls[0]);
    assert.ok(f.awardUrls[0].startsWith(`http://nara.test/scsbid/${AWARD_OPERATION}?`), f.awardUrls[0]);
  });

  test('NARA_AWARD_OPERATION overrides the awards operation name', async () => {
    const urls = [];
    const f = async (url) => {
      const u = String(url);
      urls.push(u);
      return Response.json(opOf(u) === OPERATION ? RESULT : SCSBID);
    };
    const r = await rt(f, { ...ENV, NARA_AWARD_OPERATION: 'getOtherAwardList' });
    const { html } = await page(r, '/history?q=' + encodeURIComponent('수원시'));
    assert.equal(urls.length, 2);
    assert.equal(opOf(urls[1]), 'getOtherAwardList');
    assert.equal(tableRows(html)[0][3], '낙찰자 업체E');
  });
});

describe('history: decorate', () => {
  test('badge 지난 개찰 보기 → /history?q=<수요기관>', async () => {
    const r = await rt();
    const item = BIDS.response.body.items[0];
    const stored = await r.ctx.bids.upsert(item, 'nara-cnstwk');
    const b = await mod(r).decorate(r.ctx, stored.bidId);
    assert.deepEqual(b, { label: BADGE_LABEL, href: `/history?q=${encodeURIComponent(stored.org)}` });
  });

  test('unknown bid or no key → null', async () => {
    const r = await rt();
    assert.equal(await mod(r).decorate(r.ctx, 'nope-000'), null);
    const r2 = await rt(stub(), {});
    const stored = await r2.ctx.bids.upsert(BIDS.response.body.items[0], 'nara-cnstwk');
    assert.equal(await mod(r2).decorate(r2.ctx, stored.bidId), null);
  });
});

describe('history: pure', () => {
  test('toRow reads opengCorpInfo first entry as top, award null', () => {
    const row = toRow({ bidNtceNo: 'X1', bidNtceOrd: '000', opengCorpInfo: '업체B^0000000000^대표자^1000^88.1' });
    assert.equal(row.bidId, 'X1-000');
    assert.deepEqual(row.top, { name: '업체B', bizNo: '0000000000', amount: 1000, rate: 88.1 });
    assert.equal(row.award, null);
    assert.equal(toRow({ bidNtceNo: 'X2' }).bidId, 'X2-000');
  });

  test('toRow ignores bidwinnrNm / sucsfbidAmt / sucsfbidRate on an opening item (award stays null)', () => {
    const row = toRow({ bidNtceNo: 'X1', bidNtceOrd: '000', bidwinnrNm: '업체Z', sucsfbidAmt: '5', sucsfbidRate: '1.1' });
    assert.equal(row.award, null);
    assert.equal(row.top.name, null);
    assert.equal(row.top.amount, null);
    assert.equal(row.top.rate, null);
  });

  test('toAward reads awards list fields only (no address, phone, contact)', () => {
    const a = toAward(SCSBID.response.body.items[0]);
    assert.equal(a.bidId, 'R26BK01900101-000');
    assert.deepEqual(a.award, { name: '업체A', bizNo: '0000000000', amount: 104520000, rate: 87.745, at: '2026-10-28' });
    const b = toAward({ bidNtceNo: 'X1', bidNtceOrd: '001', bidwinnrNm: '업체Q', rlOpengDt: '2026-10-01 11:00:00' });
    assert.equal(b.bidId, 'X1-001');
    assert.equal(b.award.at, '2026-10-01 11:00:00');
    assert.equal(b.award.amount, null);
  });

  test('mergeAwards joins by bidId without mutating inputs', () => {
    const rows = RESULT.response.body.items.map(toRow);
    const awards = SCSBID.response.body.items.map(toAward);
    const before = JSON.stringify(rows);
    const merged = mergeAwards(rows, awards);
    assert.equal(JSON.stringify(rows), before, 'rows unchanged');
    assert.notEqual(merged, rows);
    const byId = Object.fromEntries(merged.map((r) => [r.bidId, r]));
    assert.equal(byId['R26BK01900101-000'].award.name, '업체A');
    assert.equal(byId['R26BK01900105-000'].award.name, '업체E');
    for (const id of ['R26BK01900102-000', 'R26BK01900103-000', 'R26BK01900104-000']) assert.equal(byId[id].award, null, id);
    assert.equal(byId['R26BK01900102-000'].top.name, '업체B');
  });

  test('cleanDays / cleanQuery', () => {
    assert.equal(cleanDays(''), 30);
    assert.equal(cleanDays('7'), 7);
    assert.equal(cleanDays('999'), 90);
    assert.equal(cleanDays('-1'), 30);
    assert.equal(cleanQuery('  경기도   수원시 '), '경기도 수원시');
  });
});
