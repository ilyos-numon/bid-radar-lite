import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { matchBids } from '../../src/match.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = readFileSync(path.join(ROOT, 'tests/fixtures/nara-bids.json'), 'utf8');
const DEFAULT_CRITERIA = JSON.parse(readFileSync(path.join(ROOT, 'config/criteria.json'), 'utf8'));

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

/** handler(url, init) → Response (throw 하면 네트워크 오류) */
function stubFetch(handler = () => new Response('{}')) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

async function rt({ env = { NARA_API_KEY: 'dummy-key', NARA_API_BASE: 'http://nara.test/svc' }, fetchImpl = stubFetch(), modulesDir } = {}) {
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

function naraBody(items, code = '00', msg = 'NORMAL SERVICE.') {
  return JSON.stringify({ response: { header: { resultCode: code, resultMsg: msg }, body: { items, totalCount: items.length } } });
}

function bid(no, extra = {}) {
  return {
    bidNtceNo: no,
    bidNtceOrd: '000',
    bidNtceNm: `공고 ${no}`,
    ntceInsttNm: '경기도 수원시',
    dminsttNm: '경기도 수원시',
    bidNtceDt: '2026-10-29 09:00:00',
    bidClseDt: '2026-11-07 10:00:00',
    presmptPrce: '',
    asignBdgtAmt: '120000000',
    bidNtceDtlUrl: `https://www.g2b.go.kr/link/${no}`,
    ...extra,
  };
}

describe('nara adapter', () => {
  test('nara: request URL has operation, serviceKey, type=json and 12-digit dates', async () => {
    const f = stubFetch(() => new Response(naraBody([])));
    const r = await rt({ fetchImpl: f });
    const nara = r.ctx.sources.adapters()[0];
    assert.equal(nara.type, 'nara');
    await nara.fetch({ operation: 'getBidPblancListInfoServc' }, { since: new Date('2026-10-28T00:00:00+09:00'), fetchImpl: f, env: r.ctx.env });
    // 공사가 아닌 오퍼레이션: 공고게시일시(1) + 변경일시(3) 두 번, 보조 오퍼레이션 없음
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls.map((c) => new URL(c).searchParams.get('inqryDiv')), ['1', '3']);
    const u = new URL(f.calls[0]);
    assert.ok(u.pathname.endsWith('/getBidPblancListInfoServc'));
    assert.equal(u.searchParams.get('serviceKey'), 'dummy-key');
    assert.equal(u.searchParams.get('type'), 'json');
    assert.equal(u.searchParams.get('numOfRows'), '500');
    assert.equal(u.searchParams.get('pageNo'), '1');
    assert.match(u.searchParams.get('inqryBgnDt'), /^\d{12}$/);
    assert.match(u.searchParams.get('inqryEndDt'), /^\d{12}$/);
    assert.equal(u.searchParams.get('inqryBgnDt'), '202610280000');
    assert.equal(u.searchParams.get('inqryEndDt'), '202610290000');
  });

  test('nara: shared fixture normalizes to 6 unique bids (duplicate 001 merged) with attachments/regionLimit fields', async () => {
    const f = stubFetch(() => new Response(FIXTURE));
    const r = await rt({ fetchImpl: f });
    const out = await r.ctx.sources.adapters()[0].fetch({ operation: 'getBidPblancListInfoCnstwk' }, { since: new Date(), fetchImpl: f, env: r.ctx.env });
    assert.equal(out.length, 6);
    for (const b of out) {
      assert.deepEqual(b.attachments, []);
      assert.equal(b.regionLimit, b.bidNtceNo === '20261029003' ? '부산광역시' : null);
    }
    assert.equal(matchBids(out, DEFAULT_CRITERIA).length, 3);
  });

  test('nara: attachment and region fields are mapped', async () => {
    const item = bid('20261029100', {
      ntceSpecDocUrl1: 'https://www.g2b.go.kr/doc/1.pdf',
      ntceSpecFileNm1: '과업지시서.pdf',
      ntceSpecDocUrl2: '',
      ntceSpecFileNm2: '',
      ntceSpecDocUrl3: 'https://www.g2b.go.kr/doc/3.hwp',
      ntceSpecFileNm3: '공고문.hwp',
      prtcptLmtRgnNm: '경기도',
    });
    const f = stubFetch(() => new Response(naraBody([item])));
    const r = await rt({ fetchImpl: f });
    const [b] = await r.ctx.sources.adapters()[0].fetch({ operation: 'x' }, { since: new Date(), fetchImpl: f, env: r.ctx.env });
    assert.deepEqual(b.attachments, [
      { name: '과업지시서.pdf', url: 'https://www.g2b.go.kr/doc/1.pdf' },
      { name: '공고문.hwp', url: 'https://www.g2b.go.kr/doc/3.hwp' },
    ]);
    assert.equal(b.regionLimit, '경기도');
  });

  test('nara: resultCode 30 → SOURCE_ERROR, fetchNow returns user message without throwing', async () => {
    const f = stubFetch(() => new Response(naraBody([], '30', 'SERVICE KEY IS NOT REGISTERED ERROR.')));
    const r = await rt({ fetchImpl: f });
    await assert.rejects(
      r.ctx.sources.adapters()[0].fetch({ operation: 'x' }, { since: new Date(), fetchImpl: f, env: r.ctx.env }),
      (e) => e.message.startsWith('SOURCE_ERROR: NARA_API_ERROR: 30'),
    );
    const res = await r.ctx.sources.fetchNow('nara-cnstwk');
    assert.equal(res.ok, false);
    assert.equal(res.count, 0);
    assert.ok(res.error.includes('나라장터 응답 오류 30'), res.error);
    assert.ok(!res.error.includes('SOURCE_ERROR'));
    assert.ok(!res.error.includes('NARA_API_ERROR'));
    const [run] = await r.ctx.sources.runs('nara-cnstwk', 5);
    assert.equal(run.ok, false);
    assert.equal(run.error, res.error);
  });

  test('nara: missing key → user message, no request', async () => {
    const f = stubFetch();
    const r = await rt({ env: {}, fetchImpl: f });
    await assert.rejects(
      r.ctx.sources.adapters()[0].fetch({ operation: 'x' }, { since: new Date(), fetchImpl: f, env: {} }),
      { message: 'SOURCE_ERROR: 나라장터 인증키가 없습니다. 운영자가 인증키를 넣어야 합니다.' },
    );
    const res = await r.ctx.sources.fetchNow('nara-cnstwk');
    assert.deepEqual(res, { ok: false, count: 0, error: '나라장터 인증키가 없습니다. 운영자가 인증키를 넣어야 합니다.' });
    assert.equal(f.calls.length, 0);
  });
});

describe('bids store', () => {
  test('bids: upsert keeps first_seen, stores raw, re-upsert updates title', async () => {
    const r = await rt();
    const raw = bid('20261029200', { attachments: [{ name: 'a.txt', url: 'https://x.test/a.txt' }], regionLimit: null, source: 'nara-cnstwk' });
    const first = await r.ctx.bids.upsert(raw, 'nara-cnstwk');
    assert.equal(first.bidId, '20261029200-000');
    assert.equal(first.firstSeen, '2026-10-29');
    assert.equal(first.budget, 120000000);
    assert.equal(first.org, '경기도 수원시');
    assert.deepEqual(first.raw, raw);
    await r.ctx.db.run("UPDATE bids SET first_seen = '2026-10-01' WHERE bid_id = $1", ['20261029200-000']);
    const again = await r.ctx.bids.upsert({ ...raw, bidNtceNm: '바뀐 제목', asignBdgtAmt: '', presmptPrce: '50000000' }, 'nara-cnstwk');
    assert.equal(again.title, '바뀐 제목');
    assert.equal(again.firstSeen, '2026-10-01');
    assert.equal(again.budget, 50000000);
    assert.equal((await r.ctx.bids.upsert({ ...raw, asignBdgtAmt: '', presmptPrce: '' }, 'nara-cnstwk')).budget, null);
    assert.equal(await r.ctx.bids.get('nope-000'), null);
    assert.equal(Number((await r.ctx.db.get('SELECT COUNT(*) AS n FROM bids')).n), 1);
  });

  test('bids: matches.save → forDate round trip with maybe, same date replaced, latestDate', async () => {
    const r = await rt();
    for (const no of ['1', '2', '3']) await r.ctx.bids.upsert(bid(no), 'nara-cnstwk');
    const m = async (no, reasons) => ({ ...(await r.ctx.bids.get(`${no}-000`)), reasons });
    const pick = ({ bidId, title, org, deadline, budget, url, reasons }) => ({ bidId, title, org, deadline, budget, url, reasons });
    assert.equal(await r.ctx.matches.latestDate(), null);
    assert.deepEqual(await r.ctx.matches.forDate('2026-10-29'), { matched: [], maybe: null });

    const a = pick(await m('2', ["키워드 '조경' 일치"]));
    const b = pick(await m('1', ['예산 범위 안']));
    const c = pick(await m('3', ['관련 키워드 일치']));
    await r.ctx.matches.save('2026-10-28', [b], null);
    await r.ctx.matches.save('2026-10-29', [a, b], c);
    assert.deepEqual(await r.ctx.matches.forDate('2026-10-29'), { matched: [a, b], maybe: c });
    assert.deepEqual((await r.ctx.bids.listByDate('2026-10-29')).map((x) => x.bidId), ['2-000', '1-000', '3-000']);
    const rows = await r.ctx.db.all("SELECT bid_id, kind, rank FROM matches WHERE date = '2026-10-29' ORDER BY kind, rank");
    assert.deepEqual(rows.map((x) => [x.bid_id, x.kind, Number(x.rank)]), [['2-000', 'match', 1], ['1-000', 'match', 2], ['3-000', 'maybe', 1]]);
    assert.equal(await r.ctx.matches.latestDate(), '2026-10-29');

    await r.ctx.matches.save('2026-10-29', [c], null);
    assert.deepEqual(await r.ctx.matches.forDate('2026-10-29'), { matched: [c], maybe: null });
    assert.deepEqual((await r.ctx.matches.forDate('2026-10-28')).matched, [b]);
  });
});

describe('sources registry', () => {
  test('sources: seed has nara 1 + nara-prestd 1', async () => {
    const r = await rt({ env: { NARA_BID_OPERATION: 'getBidPblancListInfoServc' } });
    const list = await r.ctx.sources.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'nara-cnstwk');
    assert.equal(list[0].type, 'nara');
    assert.equal(list[0].name, '나라장터 공사');
    assert.equal(list[0].enabled, true);
    assert.deepEqual(list[0].config, { operation: 'getBidPblancListInfoServc' });
    assert.equal(list[1].id, 'nara-prestd');
    assert.equal(list[1].type, 'nara');
    assert.equal(list[1].name, '나라장터 사전규격 공사');
    assert.equal(list[1].enabled, true);
    assert.deepEqual(list[1].config, { operation: 'getPublicPrcureThngInfoCnstwk', service: 'prestd' });
  });

  test('sources: 기존 DB 에 nara-prestd 가 없으면 한 번 추가, 사용자가 지운 뒤에는 다시 만들지 않음', async () => {
    const dbPath = path.join(tmp('br-db-'), 'app.db');
    const open = () =>
      createRuntime({ dbPath, modulesDir: tmp('br-mod-'), secret: 'x', jobToken: 't', env: {}, fetchImpl: stubFetch(), fakeNow: '2026-10-29' });
    // 사전규격 소스가 생기기 전의 DB 흉내: nara 행만 있고 플래그 없음
    let r = await open();
    await r.ctx.db.run("DELETE FROM sources WHERE id = 'nara-prestd'");
    await r.ctx.db.run("DELETE FROM settings WHERE key = 'sources_prestd_seeded'");
    r.close();
    r = await open();
    let ids = (await r.ctx.sources.list()).map((s) => s.id);
    assert.deepEqual(ids, ['nara-cnstwk', 'nara-prestd']);
    assert.equal((await r.ctx.sources.get('nara-prestd')).enabled, true);
    assert.equal((await r.ctx.sources.remove('nara-prestd')).ok, true);
    r.close();
    r = await open();
    ids = (await r.ctx.sources.list()).map((s) => s.id);
    r.close();
    assert.deepEqual(ids, ['nara-cnstwk']);
  });

  test('sources: add/update/remove and adapters order with module adapter', async () => {
    const modulesDir = tmp('br-mod-');
    mkdirSync(path.join(modulesDir, 'fakesrc'));
    writeFileSync(
      path.join(modulesDir, 'fakesrc', 'manifest.mjs'),
      `export default {
  id: 'fakesrc', title: '가짜 소스', group: '더 넓게', order: 99, path: '/fakesrc', help: '도움말',
  routes() {},
  adapters: [{
    type: 'fake', label: '가짜 게시판', configFields: [{ key: 'url', label: '주소', required: true }],
    validate(config) { return config && config.url ? [] : ['주소를 적어 주세요.']; },
    async fetch(config) { return [{ bidNtceNo: 'fake1', bidNtceOrd: '000', bidNtceNm: '가로수 정비', ntceInsttNm: '경기도 수원시', dminsttNm: '경기도 수원시', bidNtceDt: '', bidClseDt: '2026-11-20 00:00:00', presmptPrce: '', asignBdgtAmt: '', bidNtceDtlUrl: config.url }]; },
  }],
};
`,
    );
    const r = await rt({ modulesDir });
    assert.deepEqual(r.ctx.sources.adapters().map((a) => a.type), ['nara', 'fake']);

    const bad = await r.ctx.sources.add({ type: 'fake', name: '시청 게시판', config: { url: '' } });
    assert.deepEqual(bad, { ok: false, errors: ['주소를 적어 주세요.'], source: null });
    assert.equal((await r.ctx.sources.list()).length, 2);
    assert.equal((await r.ctx.sources.add({ type: 'nope', name: 'x', config: {} })).ok, false);

    // 시각이 같으면 id 순이다 (ORDER BY created_at, id). 시드보다 뒤에 만든 것으로 둔다
    r.ctx.now = () => new Date('2026-10-29T03:00:01.000Z');
    const ok = await r.ctx.sources.add({ type: 'fake', name: '시청 게시판', config: { url: 'https://city.test/rss' } });
    assert.equal(ok.ok, true);
    const id = ok.source.id;
    assert.deepEqual((await r.ctx.sources.list()).map((s) => s.id), ['nara-cnstwk', 'nara-prestd', id]);

    const up = await r.ctx.sources.update(id, { enabled: false, name: '구청 게시판' });
    assert.equal(up.ok, true);
    assert.equal((await r.ctx.sources.get(id)).enabled, false);
    assert.equal((await r.ctx.sources.get(id)).name, '구청 게시판');
    assert.deepEqual((await r.ctx.sources.update(id, { config: { url: '' } })).errors, ['주소를 적어 주세요.']);

    const now = await r.ctx.sources.fetchNow(id);
    assert.deepEqual(now, { ok: true, count: 1, error: null });
    assert.equal((await r.ctx.bids.get('fake1-000')).sourceId, id);
    assert.equal((await r.ctx.sources.runs(id, 5)).length, 1);
    assert.equal((await r.ctx.sources.get(id)).lastRun.count, 1);

    assert.equal((await r.ctx.sources.remove('nara-cnstwk')).ok, false);
    assert.deepEqual(await r.ctx.sources.remove(id), { ok: true, errors: [] });
    assert.equal(await r.ctx.sources.get(id), null);
    assert.equal((await r.ctx.sources.list()).length, 2);
  });

  test('sources: fetchAll continues when one source fails', async () => {
    const modulesDir = tmp('br-mod-');
    mkdirSync(path.join(modulesDir, 'failsrc'));
    writeFileSync(
      path.join(modulesDir, 'failsrc', 'manifest.mjs'),
      `export default {
  id: 'failsrc', title: '실패 소스', group: '더 넓게', order: 99, path: '/failsrc', help: '도움말',
  routes() {},
  adapters: [{ type: 'boom', label: '깨진 소스', configFields: [], validate() { return []; },
    async fetch() { throw new Error('SOURCE_ERROR: timeout'); } }],
};
`,
    );
    const f = stubFetch(() => new Response(FIXTURE));
    const r = await rt({ modulesDir, fetchImpl: f });
    await r.ctx.db.run("UPDATE sources SET created_at = '2026-10-29T00:00:01.000Z'");
    await r.ctx.db.run("INSERT INTO sources (id, type, name, enabled, config, created_at) VALUES ('boom-1', 'boom', '깨진 소스', 1, '{}', '2026-10-29T00:00:00.000Z')");
    await r.ctx.db.run("INSERT INTO sources (id, type, name, enabled, config, created_at) VALUES ('off-1', 'boom', '꺼진 소스', 0, '{}', '2026-10-29T00:00:02.000Z')");
    const out = await r.ctx.sources.fetchAll(new Date('2026-10-28T00:00:00+09:00'));
    // 공유 fixture 에는 사전규격번호가 없어 nara-prestd 는 0건, 중복 001 은 하나로 합쳐진다
    assert.deepEqual(out.results.map((x) => [x.sourceId, x.ok, x.count]), [['boom-1', false, 0], ['nara-cnstwk', true, 6], ['nara-prestd', true, 0]]);
    assert.ok(out.results[0].error.startsWith('timeout'));
    assert.ok(!out.results[0].error.includes('SOURCE_ERROR'));
    assert.equal(out.bids.length, 6);
    assert.ok(out.bids.every((b) => b.source === 'nara-cnstwk'));
    assert.equal(Number((await r.ctx.db.get('SELECT COUNT(*) AS n FROM bids')).n), 6);
    const runs = await r.ctx.db.all('SELECT source_id, ok FROM source_runs ORDER BY id');
    assert.deepEqual(runs.map((x) => [x.source_id, Number(x.ok)]), [['boom-1', 0], ['nara-cnstwk', 1], ['nara-prestd', 1]]);
  });
});

describe('criteria', () => {
  test('criteria: falls back to config/criteria.json, set validates and saves', async () => {
    const r = await rt();
    assert.deepEqual(await r.ctx.criteria.get(), DEFAULT_CRITERIA);
    const good = { keywords: [' 조경 ', '수목'], regions: [], budgetMin: 0, budgetMax: 100000000, maxItems: 3 };
    assert.deepEqual(r.ctx.criteria.validate(good), []);
    assert.deepEqual(await r.ctx.criteria.set(good), []);
    assert.deepEqual(await r.ctx.criteria.get(), { ...good, keywords: ['조경', '수목'] });

    const errs = r.ctx.criteria.validate({ keywords: [], regions: 'x', budgetMin: -1, budgetMax: 'a', maxItems: 0 });
    assert.deepEqual(errs, [
      '업종 키워드를 하나 이상 적어 주세요.',
      '지역은 목록으로 적어 주세요. 전국이면 비워 두세요.',
      '최소 예산을 0 이상의 숫자로 적어 주세요.',
      '최대 예산을 0 이상의 숫자로 적어 주세요.',
      '알림 건수는 1에서 20 사이로 적어 주세요.',
    ]);
    assert.deepEqual(r.ctx.criteria.validate({ ...good, budgetMin: 5, budgetMax: 1 }), ['최소 예산이 최대 예산보다 큽니다. 두 값을 다시 확인해 주세요.']);
    const before = await r.ctx.settings.get('criteria');
    assert.equal((await r.ctx.criteria.set({ ...good, keywords: [] })).length, 1);
    assert.equal(await r.ctx.settings.get('criteria'), before);
  });
});
