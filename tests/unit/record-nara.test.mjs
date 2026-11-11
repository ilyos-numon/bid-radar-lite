import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskKey, anonymizeItems, fieldSummary, OPERATIONS, parseArgs, buildUrl } from '../../scripts/record-nara.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NARA_DIR = path.join(ROOT, 'tests/fixtures/nara');

test('no key: prints RECORD_SKIP and exits 2', () => {
  const env = { ...process.env, NARA_API_KEY: '' };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/record-nara.mjs')], { encoding: 'utf8', env });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^RECORD_SKIP/);
});

test('maskKey replaces raw and URL-encoded key', () => {
  const key = 'ab+c/d==';
  const text = `serviceKey=${encodeURIComponent(key)}&x=1 raw ${key}`;
  const out = maskKey(text, key);
  assert.ok(!out.includes(key));
  assert.ok(!out.includes(encodeURIComponent(key)));
  assert.match(out, /serviceKey=\*\*\*/);
  assert.equal(maskKey('plain', ''), 'plain');
});

test('anonymizeItems maps company names to 업체A.. deterministically', () => {
  const items = [
    { bidwinnrNm: '가나건설(주)', bidwinnrBizno: '1234567890', bidwinnrCeoNm: '홍길동', bidNtceNm: '공원 정비' },
    { prcbdrNm: '다라조경', prcbdrBizno: '2223334444', prcbdrCeoNm: '김철수' },
    { bidwinnrNm: '가나건설(주)', opengCorpInfo: '마바개발^3334445555^이영희^100000000^87.745' },
  ];
  const out = anonymizeItems(items);
  assert.equal(out[0].bidwinnrNm, '업체A');
  assert.equal(out[1].prcbdrNm, '업체B');
  assert.equal(out[2].bidwinnrNm, '업체A');
  assert.equal(out[0].bidNtceNm, '공원 정비');
  assert.equal(out[0].bidwinnrBizno, '0000000000');
  assert.equal(out[0].bidwinnrCeoNm, '대표자');
  assert.equal(out[2].opengCorpInfo, '업체C^0000000000^대표자^100000000^87.745');
  const ofcl = anonymizeItems([{ ntceInsttOfclNm: '박담당', ntceInsttOfclTelNo: '02-000-0000', ntceInsttOfclEmailAdrs: 'a@b.kr' }])[0];
  assert.deepEqual(ofcl, { ntceInsttOfclNm: '담당자', ntceInsttOfclTelNo: '', ntceInsttOfclEmailAdrs: '' });
  // input is not mutated
  assert.equal(items[0].bidwinnrNm, '가나건설(주)');
});

test('anonymizeItems cycles past 업체E without leaking names', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ bidwinnrNm: `회사${n}` }));
  const out = anonymizeItems(items).map((i) => i.bidwinnrNm);
  assert.deepEqual(out.slice(0, 5), ['업체A', '업체B', '업체C', '업체D', '업체E']);
  assert.match(out[5], /^업체[A-E]$/);
});

test('fieldSummary lists result code, total and item keys', () => {
  const text = JSON.stringify({
    response: { header: { resultCode: '00', resultMsg: 'OK' }, body: { items: [{ a: 1, b: 2 }, { c: 3 }], totalCount: 2 } },
  });
  const s = fieldSummary(text);
  assert.equal(s.resultCode, '00');
  assert.equal(s.totalCount, 2);
  assert.deepEqual(s.fields, ['a', 'b', 'c']);
  const err = fieldSummary('<OpenAPI_ServiceResponse><cmmMsgHeader><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>');
  assert.equal(err.resultCode, '30');
  const gw = fieldSummary(JSON.stringify({ OpenAPI_ServiceResponse: { cmmMsgHeader: { returnReasonCode: '12', returnAuthMsg: 'x' } } }));
  assert.equal(gw.resultCode, '12');
});

test('parseArgs: defaults --days 1 --rows 5, no overrides', () => {
  assert.deepEqual(parseArgs([]), { only: [], out: '', days: 1, rows: 5, ops: {} });
});

test('parseArgs: --only, --out, --days, --rows, --op (repeatable)', () => {
  const o = parseArgs([
    '--only', 'prestd-cnstwk,scsbid-list-cnstwk', '--days', '30', '--rows', '20', '--out', 'x/samples',
    '--op', 'scsbid-list-cnstwk=getScsbidListSttusCnstwkPPSSrch', '--op', 'prestd-cnstwk=getFoo',
  ]);
  assert.deepEqual(o.only, ['prestd-cnstwk', 'scsbid-list-cnstwk']);
  assert.equal(o.days, 30);
  assert.equal(o.rows, 20);
  assert.equal(o.out, 'x/samples');
  assert.deepEqual(o.ops, { 'scsbid-list-cnstwk': 'getScsbidListSttusCnstwkPPSSrch', 'prestd-cnstwk': 'getFoo' });
  assert.equal(parseArgs(['--days', '90', '--rows', '100']).days, 90);
  assert.equal(parseArgs(['--days', '1', '--rows', '1']).rows, 1);
});

test('parseArgs: out-of-range or malformed values throw', () => {
  for (const argv of [['--days', '0'], ['--days', '91'], ['--days', 'x'], ['--rows', '0'], ['--rows', '101'], ['--rows', '2.5'], ['--days']]) {
    assert.throws(() => parseArgs(argv), /--days|--rows/, argv.join(' '));
  }
  assert.throws(() => parseArgs(['--op', 'scsbid-list-cnstwk']), /--op/);
  assert.throws(() => parseArgs(['--op', 'nope=getX']), /unknown/);
});

test('bad option: prints RECORD_ARG_ERROR, exits 2, makes no call', () => {
  const env = { ...process.env, NARA_API_KEY: 'dummy', NARA_SCSBID_BASE: 'http://nara.invalid' };
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/record-nara.mjs'), '--days', '91'], { encoding: 'utf8', env });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /^RECORD_ARG_ERROR --days/);
  assert.doesNotMatch(r.stdout, /RECORD /);
});

test('buildUrl: --days sets the window, --rows sets numOfRows, --op operation is used', () => {
  const now = new Date('2026-11-02T03:00:00Z'); // 12:00 KST
  const op = { base: 'NARA_SCSBID_BASE', operation: 'getScsbidListSttusCnstwkPPSSrch', inqryDiv: '1' };
  const u = new URL(buildUrl(op, 'k', { NARA_SCSBID_BASE: 'http://h/scsbid/' }, now, { days: 30, rows: 20 }));
  assert.equal(u.pathname, '/scsbid/getScsbidListSttusCnstwkPPSSrch');
  assert.equal(u.searchParams.get('numOfRows'), '20');
  assert.equal(u.searchParams.get('inqryBgnDt'), '202610031200');
  assert.equal(u.searchParams.get('inqryEndDt'), '202611021200');
  assert.equal(u.searchParams.get('inqryDiv'), '1');
  const d = new URL(buildUrl(op, 'k', { NARA_SCSBID_BASE: 'http://h' }, now));
  assert.equal(d.searchParams.get('numOfRows'), '5');
  assert.equal(d.searchParams.get('inqryBgnDt'), '202611011200');
});

test('operations: award list operation is recorded from the scsbid service', () => {
  const op = OPERATIONS.find((o) => o.name === 'scsbid-list-cnstwk');
  assert.deepEqual(op, { name: 'scsbid-list-cnstwk', base: 'NARA_SCSBID_BASE', operation: 'getScsbidListSttusCnstwk', inqryDiv: '1' });
});

test('anonymizeItems: award list company fields and free text are replaced', () => {
  const out = anonymizeItems([
    { fnlSucsfCorpNm: '가나건설(주)', fnlSucsfCorpBizno: '1234567890', fnlSucsfCorpCeoNm: '홍길동', opengRsltNtcCntnts: '유찰 사유 실명 포함' },
    { ofclNm: '박담당', ofclTelNo: '02-000-0000' },
    { bidwinnrNm: '가나건설(주)', bidwinnrAdrs: '어느시 어느로 1', bidwinnrTelNo: '02-111-1111', fnlSucsfCorpOfcl: '최담당' },
  ]);
  assert.deepEqual(out[2], { bidwinnrNm: '업체A', bidwinnrAdrs: '', bidwinnrTelNo: '', fnlSucsfCorpOfcl: '담당자' });
  assert.equal(out[0].fnlSucsfCorpNm, '업체A');
  assert.equal(out[0].fnlSucsfCorpBizno, '0000000000');
  assert.equal(out[0].fnlSucsfCorpCeoNm, '대표자');
  assert.equal(out[0].opengRsltNtcCntnts, '');
  assert.deepEqual(out[1], { ofclNm: '담당자', ofclTelNo: '' });
});

test('operations: each recorded operation listed once, ≤ 10 calls', () => {
  assert.ok(OPERATIONS.length <= 10);
  const names = OPERATIONS.map((o) => o.name);
  assert.equal(new Set(names).size, names.length);
});

test('fixtures: all nara fixtures parse and share the response shape', () => {
  const files = readdirSync(NARA_DIR).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 11); // JSON 11개(낙찰 목록 추가) + README.md
  for (const f of files) {
    const j = JSON.parse(readFileSync(path.join(NARA_DIR, f), 'utf8'));
    assert.ok(j.response && j.response.header && typeof j.response.header.resultCode === 'string', f);
    const b = j.response.body;
    assert.ok(b && Array.isArray(b.items), f);
    for (const k of ['numOfRows', 'pageNo', 'totalCount']) assert.equal(typeof b[k], 'number', `${f} ${k}`);
  }
});

test('fixtures: list pages, changed, results, errors follow the recorded layout', () => {
  const read = (f) => JSON.parse(readFileSync(path.join(NARA_DIR, f), 'utf8')).response;
  const p1 = read('list-cnstwk-p1.json');
  const p2 = read('list-cnstwk-p2.json');
  assert.equal(p1.body.totalCount, 650);
  assert.equal(p1.body.numOfRows, 500);
  assert.equal(p1.body.items.length, 500);
  assert.equal(p2.body.totalCount, 650);
  assert.equal(p2.body.pageNo, 2);
  assert.equal(p2.body.items.length, 150);
  const ids = new Set([...p1.body.items, ...p2.body.items].map((i) => `${i.bidNtceNo}-${i.bidNtceOrd}`));
  assert.equal(ids.size, 650);
  const kinds = read('list-cnstwk-changed.json').body.items.map((i) => i.ntceKindNm).sort();
  assert.deepEqual(kinds, ['변경공고', '재공고', '취소공고']);
  const openg = read('openg-result-cnstwk.json').body.items;
  assert.deepEqual(openg.map((i) => i.bidNtceNo), ['R26BK01900101', 'R26BK01900102', 'R26BK01900103', 'R26BK01900104', 'R26BK01900105']);
  for (const i of openg) {
    assert.equal(Object.keys(i).length, 16, i.bidNtceNo);
    for (const k of ['bidwinnrNm', 'sucsfbidAmt', 'sucsfbidRate']) assert.ok(!(k in i), `${i.bidNtceNo} ${k}`);
    assert.match(i.opengCorpInfo, /^업체[A-E]\^0000000000\^대표자\^\d+\^[\d.]+$/);
  }
  const award = read('scsbid-list-cnstwk.json').body.items;
  assert.deepEqual(
    award.map((i) => [`${i.bidNtceNo}-${i.bidNtceOrd}`, i.bidwinnrNm, i.sucsfbidAmt, i.sucsfbidRate]),
    [
      ['R26BK01900101-000', '업체A', '104520000', '87.745'],
      ['R26BK01900105-000', '업체E', '129800000', '86.774'],
    ],
  );
  for (const i of award) {
    assert.equal(i.bidwinnrBizno, '0000000000');
    assert.equal(i.bidwinnrCeoNm, '대표자');
    assert.equal(i.bidwinnrTelNo, '');
    assert.equal(i.bidwinnrAdrs, '');
  }
  const prestd = read('prestd-cnstwk.json').body.items;
  assert.ok(prestd.length >= 3);
  const byNo = Object.fromEntries(prestd.map((i) => [i.bfSpecRgstNo, i]));
  assert.equal(byNo.R26BD00900005.bidNtceNoList, 'R26BK01900005');
  assert.equal(byNo.R26BD00900001.bidNtceNoList, '');
  for (const i of prestd) {
    assert.equal(i.ofclNm, '담당자');
    assert.equal(i.ofclTelNo, '');
    assert.match(i.opninRgstClseDt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  }
  assert.equal(read('error-22.json').header.resultCode, '22');
  assert.equal(read('error-30.json').header.resultCode, '30');
});
