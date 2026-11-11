import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { normalizeBid, regionKeys, REGION_TABLE } from '../../app/core/normalize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nara = (name) => JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/nara', name), 'utf8')).response.body.items;
const LIST = nara('list-cnstwk-p1.json');
const CHANGED = nara('list-cnstwk-changed.json');
const LICENSE = nara('license-limit.json');
const REGION = nara('region-limit.json');
const BASE = nara('base-amount.json');

const key = (x) => `${x.bidNtceNo}-${x.bidNtceOrd}`;
const listItem = (no) => structuredClone(LIST.find((x) => x.bidNtceNo === no));
/** 수집 레인과 같은 병합 키(bidNtceNo + bidNtceOrd)로 보조 목록을 붙인다 */
function merged(no) {
  const item = listItem(no);
  const k = key(item);
  item.lcnsLmtList = LICENSE.filter((x) => key(x) === k);
  item.prtcptPsblRgnList = REGION.filter((x) => key(x) === k);
  const b = BASE.find((x) => key(x) === k);
  if (b) item.bssamt = b.bssamt;
  return item;
}

const tmpRoots = [];
const runtimes = [];
after(() => {
  for (const r of runtimes) r.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

async function rt() {
  const modulesDir = mkdtempSync(path.join(tmpdir(), 'br-mod-'));
  tmpRoots.push(modulesDir);
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir,
    secret: 'x',
    jobToken: 't',
    env: { NARA_API_KEY: 'dummy-key', NARA_API_BASE: 'http://nara.test/svc' },
    fetchImpl: async () => new Response('{}'),
    fakeNow: '2026-11-02',
  });
  runtimes.push(r);
  return r;
}

function setClock(r, iso) {
  r.ctx.now = () => new Date(iso);
}

describe('normalizeBid', () => {
  test('ntceKindNm partial match: 변경공고 → changed, 취소공고 → cancelled, 재공고 → rebid', () => {
    assert.deepEqual(
      CHANGED.map((x) => normalizeBid(x, 'nara-cnstwk').kind),
      ['changed', 'cancelled', 'rebid'],
    );
    assert.equal(normalizeBid(listItem('R26BK01900001'), 'nara-cnstwk').kind, 'new');
    assert.equal(normalizeBid({ bidNtceNo: 'X', bidNtceOrd: '000', ntceKindNm: '연기공고' }).kind, 'postponed');
    assert.equal(normalizeBid({ bidNtceNo: 'X', bidNtceOrd: '000' }).kind, 'new');
    const ps = normalizeBid(nara('prestd-cnstwk.json')[0], 'nara-prestd');
    assert.equal(ps.kind, 'prestd');
    assert.equal(ps.bidId, 'PSR26BD00900001-000');
    assert.equal(ps.title, '수원시 공원 조경 정비공사');
    assert.equal(ps.deadline, '2026-11-06 18:00:00');
    assert.equal(ps.budgetBasis, 'assigned');
  });

  test('lcnsLmtNm "이름/코드" is split into {name, code}', () => {
    const n = normalizeBid(merged('R26BK01900002'), 'nara-cnstwk');
    assert.deepEqual(n.limits.licenses, [
      { name: '조경식재공사업', code: '4993' },
      { name: '조경시설물설치공사업', code: '4994' },
    ]);
    assert.deepEqual(normalizeBid({ bidNtceNo: 'X', bidNtceOrd: '0', lcnsLmtList: [{ lcnsLmtNm: '전기공사업' }] }).limits.licenses, [
      { name: '전기공사업', code: null },
    ]);
    assert.equal(n.limits.sme, null);
  });

  test('region sub-list merged: prtcptPsblRgnList → regionRaw + standard keys; legacy prtcptLmtRgnNm still read', () => {
    const n = normalizeBid(merged('R26BK01900002'), 'nara-cnstwk');
    assert.equal(n.limits.regionRaw, '서울특별시, 경기도');
    assert.deepEqual(n.limits.regions, ['서울', '경기']);
    const legacy = normalizeBid({ bidNtceNo: 'X', bidNtceOrd: '000', prtcptLmtRgnNm: '부산광역시' });
    assert.equal(legacy.limits.regionRaw, '부산광역시');
    assert.deepEqual(legacy.limits.regions, ['부산']);
    const none = normalizeBid({ bidNtceNo: 'X', bidNtceOrd: '000', prtcptLmtRgnNm: '' });
    assert.equal(none.limits.regionRaw, null);
    assert.deepEqual(none.limits.regions, []);
  });

  test('already normalized input is returned as is', () => {
    const n = normalizeBid(merged('R26BK01900001'), 'nara-cnstwk');
    assert.equal(normalizeBid(n, 'other'), n);
    assert.equal(n.bidId, 'R26BK01900001-000');
    assert.equal(n.org, '서울특별시 마포구');
    assert.equal(n.openingAt, '2026-11-06 11:00:00');
    assert.equal(n.sourceId, 'nara-cnstwk');
    assert.equal(n.raw.bidNtceNo, 'R26BK01900001');
  });

  test('regionKeys: 17 keys, aliases, order kept, 경기도 광주시 → 경기', () => {
    assert.equal(Object.keys(REGION_TABLE).length, 17);
    assert.deepEqual(regionKeys('경기도 수원시, 서울특별시, 경기도 광주시'), ['경기', '서울']);
    assert.deepEqual(regionKeys('광주광역시'), ['광주']);
    assert.deepEqual(regionKeys('강원특별자치도 홍천군, 전라북도, 제주특별자치도'), ['강원', '전북', '제주']);
    assert.deepEqual(regionKeys(''), []);
  });
});

describe('bids store (bid_details / bid_changes)', () => {
  test('Budget basis order: estimated → base → assigned, VAT flag follows basis', async () => {
    const r = await rt();
    const est = normalizeBid(merged('R26BK01900001'), 'nara-cnstwk');
    assert.equal(est.budgetBasis, 'estimated');
    assert.equal(est.budget, 349000000);
    assert.deepEqual(est.amounts, { estimated: 349000000, base: 132000000, assigned: 383900000, vatIncluded: false });

    const baseOnly = { ...merged('R26BK01900001'), presmptPrce: '' };
    const b = normalizeBid(baseOnly, 'nara-cnstwk');
    assert.equal(b.budgetBasis, 'base');
    assert.equal(b.budget, 132000000);
    assert.equal(b.amounts.vatIncluded, true);

    const assignedOnly = { ...listItem('R26BK01900001'), presmptPrce: '' };
    const a = normalizeBid(assignedOnly, 'nara-cnstwk');
    assert.equal(a.budgetBasis, 'assigned');
    assert.equal(a.budget, 383900000);
    assert.equal(a.amounts.vatIncluded, true);
    assert.equal(normalizeBid({ ...assignedOnly, asignBdgtAmt: '250000000' }).amounts.assigned, 250000000);

    const none = normalizeBid({ ...assignedOnly, bdgtAmt: '' });
    assert.equal(none.budget, null);
    assert.equal(none.budgetBasis, null);
    assert.equal(none.amounts.vatIncluded, null);

    const stored = await r.ctx.bids.upsert(baseOnly, 'nara-cnstwk');
    assert.equal(stored.budget, 132000000);
    assert.equal(stored.budgetBasis, 'base');
    assert.deepEqual(stored.amounts, b.amounts);
  });

  test('Region limit parsed and stored: get() returns limits, kind, openingAt, noticeOrg, postedAt, lastSeen', async () => {
    const r = await rt();
    setClock(r, '2026-11-02T01:00:00.000Z');
    const raw = merged('R26BK01900002');
    const s = await r.ctx.bids.upsert(raw, 'nara-cnstwk');
    assert.equal(s.bidId, 'R26BK01900002-000');
    assert.deepEqual(s.raw, raw);
    assert.deepEqual(s.limits.regions, ['서울', '경기']);
    assert.equal(s.limits.regionRaw, '서울특별시, 경기도');
    assert.equal(s.limits.licenses.length, 2);
    assert.equal(s.kind, 'new');
    assert.equal(s.openingAt, raw.opengDt);
    assert.equal(s.noticeOrg, raw.ntceInsttNm);
    assert.equal(s.postedAt, raw.bidNtceDt);
    assert.equal(s.lastSeen, '2026-11-02T01:00:00.000Z');
    assert.equal(s.firstSeen, '2026-11-02');
    assert.deepEqual(await r.ctx.bids.get('R26BK01900002-000'), s);
    // 이미 normalized 인 값도 받는다
    const again = await r.ctx.bids.upsert(normalizeBid(raw, 'nara-cnstwk'), 'nara-cnstwk');
    assert.deepEqual(again.raw, raw);
  });

  test('Deadline change recorded: one row per changed field, with old/new', async () => {
    const r = await rt();
    setClock(r, '2026-11-02T01:00:00.000Z');
    const raw = listItem('R26BK01900002');
    await r.ctx.bids.upsert(raw, 'nara-cnstwk');
    setClock(r, '2026-11-03T01:00:00.000Z');
    const changed = CHANGED[0];
    await r.ctx.bids.upsert({ ...raw, bidClseDt: '2026-11-13 10:00:00', ntceKindNm: changed.ntceKindNm }, 'nara-cnstwk');
    const rows = await r.ctx.bids.changesSince('2026-11-03T00:00:00.000Z');
    assert.deepEqual(
      rows.map((x) => [x.field, x.old, x.new]).sort(),
      [
        ['deadline', raw.bidClseDt, '2026-11-13 10:00:00'],
        ['kind', 'new', 'changed'],
      ],
    );
    assert.ok(rows.every((x) => x.bidId === 'R26BK01900002-000' && x.title === raw.bidNtceNm && x.seenAt === '2026-11-03T01:00:00.000Z'));
    assert.equal((await r.ctx.bids.get('R26BK01900002-000')).deadline, '2026-11-13 10:00:00');
  });

  test('Unchanged re-upsert writes no bid_changes rows and keeps first_seen', async () => {
    const r = await rt();
    const raw = merged('R26BK01900001');
    await r.ctx.bids.upsert(raw, 'nara-cnstwk');
    await r.ctx.db.run("UPDATE bids SET first_seen = '2026-10-01' WHERE bid_id = $1", ['R26BK01900001-000']);
    setClock(r, '2026-11-04T01:00:00.000Z');
    const again = await r.ctx.bids.upsert(structuredClone(raw), 'nara-cnstwk');
    assert.equal(again.firstSeen, '2026-10-01');
    assert.equal(again.lastSeen, '2026-11-04T01:00:00.000Z');
    assert.equal(Number((await r.ctx.db.get('SELECT COUNT(*) AS n FROM bid_changes')).n), 0);
    assert.deepEqual(await r.ctx.bids.changesSince('2000-01-01T00:00:00.000Z'), []);
  });

  test('changesSince: newest first, filtered by time, budget/openingAt tracked', async () => {
    const r = await rt();
    const raw = listItem('R26BK01900003');
    setClock(r, '2026-11-01T00:00:00.000Z');
    await r.ctx.bids.upsert(raw, 'nara-cnstwk');
    setClock(r, '2026-11-02T00:00:00.000Z');
    await r.ctx.bids.upsert({ ...raw, presmptPrce: '200000000' }, 'nara-cnstwk');
    setClock(r, '2026-11-03T00:00:00.000Z');
    await r.ctx.bids.upsert({ ...raw, presmptPrce: '200000000', opengDt: '2026-11-20 11:00:00' }, 'nara-cnstwk');

    const all = await r.ctx.bids.changesSince('2026-11-01T00:00:00.000Z');
    assert.deepEqual(all.map((x) => x.field), ['openingAt', 'budget']);
    assert.deepEqual(all[1], {
      bidId: 'R26BK01900003-000',
      title: raw.bidNtceNm,
      field: 'budget',
      old: String(Number(raw.presmptPrce)),
      new: '200000000',
      seenAt: '2026-11-02T00:00:00.000Z',
    });
    assert.deepEqual((await r.ctx.bids.changesSince('2026-11-02T12:00:00.000Z')).map((x) => x.field), ['openingAt']);
  });
});

describe('bid_links (prestd ↔ main notice)', () => {
  const PRESTD = nara('prestd-cnstwk.json');
  const prestdItem = (no) => structuredClone(PRESTD.find((x) => x.bfSpecRgstNo === no));
  const linkRows = async (r) =>
    (await r.ctx.db.all('SELECT prestd_id, notice_no, origin, seen_at FROM bid_links ORDER BY prestd_id, notice_no'))
      .map((x) => ({ ...x }));

  test('upsert of a main notice with bfSpecRgstNo writes one notice-origin row; get() has no links field', async () => {
    const r = await rt();
    setClock(r, '2026-11-02T01:00:00.000Z');
    const s = await r.ctx.bids.upsert(listItem('R26BK01900005'), 'nara-cnstwk');
    await r.ctx.bids.upsert(listItem('R26BK01900001'), 'nara-cnstwk');
    assert.deepEqual(await linkRows(r), [
      { prestd_id: 'PSR26BD00900005-000', notice_no: 'R26BK01900005', origin: 'notice', seen_at: '2026-11-02T01:00:00.000Z' },
    ]);
    assert.equal('links' in s, false);
  });

  test('upsert of a prestd writes one prestd-origin row per number (comma list); empty list writes none; re-upsert updates seen_at/origin', async () => {
    const r = await rt();
    setClock(r, '2026-11-02T01:00:00.000Z');
    await r.ctx.bids.upsert(prestdItem('R26BD00900001'), 'nara-prestd');
    assert.deepEqual(await linkRows(r), []);
    await r.ctx.bids.upsert({ ...prestdItem('R26BD00900005'), bidNtceNoList: 'R26BK01900005,R26BK01900099' }, 'nara-prestd');
    assert.deepEqual(
      (await linkRows(r)).map((x) => [x.prestd_id, x.notice_no, x.origin]),
      [
        ['PSR26BD00900005-000', 'R26BK01900005', 'prestd'],
        ['PSR26BD00900005-000', 'R26BK01900099', 'prestd'],
      ],
    );
    setClock(r, '2026-11-03T01:00:00.000Z');
    await r.ctx.bids.upsert(listItem('R26BK01900005'), 'nara-cnstwk');
    const rows = await linkRows(r);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      prestd_id: 'PSR26BD00900005-000',
      notice_no: 'R26BK01900005',
      origin: 'notice',
      seen_at: '2026-11-03T01:00:00.000Z',
    });
  });

  test('linksFor both ways when both sides are stored', async () => {
    const r = await rt();
    const pre = prestdItem('R26BD00900005');
    const main = listItem('R26BK01900005');
    await r.ctx.bids.upsert(pre, 'nara-prestd');
    await r.ctx.bids.upsert(main, 'nara-cnstwk');
    assert.deepEqual(await r.ctx.bids.linksFor('R26BK01900005-000'), {
      prestd: {
        bidId: 'PSR26BD00900005-000',
        noticeNo: 'R26BK01900005',
        title: pre.prdctClsfcNoNm,
        kind: 'prestd',
        deadline: pre.opninRgstClseDt,
        postedAt: null,
        url: null,
        stored: true,
      },
      notices: [],
    });
    assert.deepEqual(await r.ctx.bids.linksFor('PSR26BD00900005-000'), {
      prestd: null,
      notices: [
        {
          bidId: 'R26BK01900005-000',
          noticeNo: 'R26BK01900005',
          title: main.bidNtceNm,
          kind: 'new',
          deadline: main.bidClseDt,
          postedAt: main.bidNtceDt,
          url: main.bidNtceDtlUrl,
          stored: true,
        },
      ],
    });
  });

  test('linksFor with only one side stored: placeholders with stored:false; highest order wins; sort postedAt desc (null last) then noticeNo', async () => {
    const r = await rt();
    // 본공고만 저장 → 사전규격 자리표시
    await r.ctx.bids.upsert(listItem('R26BK01900005'), 'nara-cnstwk');
    assert.deepEqual((await r.ctx.bids.linksFor('R26BK01900005-000')).prestd, {
      bidId: 'PSR26BD00900005-000',
      noticeNo: 'R26BK01900005',
      title: '',
      kind: null,
      deadline: null,
      postedAt: null,
      url: null,
      stored: false,
    });
    // 사전규격이 번호 3개를 가리킨다: 저장된 것 1개(차수 2개), 저장 안 된 것 2개
    await r.ctx.bids.upsert({ ...listItem('R26BK01900005'), bidNtceOrd: '001', bidNtceDt: '2026-11-03 09:00:00' }, 'nara-cnstwk');
    await r.ctx.bids.upsert(
      { ...prestdItem('R26BD00900005'), bidNtceNoList: 'R26BK01900099,R26BK01900005,R26BK01900098' },
      'nara-prestd',
    );
    const flow = await r.ctx.bids.linksFor('PSR26BD00900005-000');
    assert.equal(flow.prestd, null);
    assert.deepEqual(
      flow.notices.map((x) => [x.bidId, x.noticeNo, x.stored, x.postedAt]),
      [
        ['R26BK01900005-001', 'R26BK01900005', true, '2026-11-03 09:00:00'],
        ['R26BK01900098-000', 'R26BK01900098', false, null],
        ['R26BK01900099-000', 'R26BK01900099', false, null],
      ],
    );
    assert.deepEqual(flow.notices[1], {
      bidId: 'R26BK01900098-000',
      noticeNo: 'R26BK01900098',
      title: '',
      kind: null,
      deadline: null,
      postedAt: null,
      url: null,
      stored: false,
    });
  });

  test('linksFor with no link (or odd input) → { prestd: null, notices: [] }, never throws', async () => {
    const r = await rt();
    await r.ctx.bids.upsert(listItem('R26BK01900001'), 'nara-cnstwk');
    await r.ctx.bids.upsert(prestdItem('R26BD00900001'), 'nara-prestd');
    const none = { prestd: null, notices: [] };
    assert.deepEqual(await r.ctx.bids.linksFor('R26BK01900001-000'), none);
    assert.deepEqual(await r.ctx.bids.linksFor('PSR26BD00900001-000'), none);
    assert.deepEqual(await r.ctx.bids.linksFor('NOPE'), none);
    assert.deepEqual(await r.ctx.bids.linksFor(''), none);
    assert.deepEqual(await r.ctx.bids.linksFor(undefined), none);
  });
});

describe('criteria.effective', () => {
  test('adds excludeKeywords ([] when not stored) and empty synonyms', async () => {
    const r = await rt();
    const eff = await r.ctx.criteria.effective();
    assert.deepEqual(eff, { ...(await r.ctx.criteria.get()), excludeKeywords: [], synonyms: {} });
  });
});
