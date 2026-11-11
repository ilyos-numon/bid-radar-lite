import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeNaraResponse,
  matchBids,
  formatBudget,
  buildNotification,
  normalizeBid,
  regionKeys,
  subRegionLimit,
  parseNoticeNos,
} from '../../src/match.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/nara-bids.json', import.meta.url), 'utf8'));
const criteria = JSON.parse(readFileSync(new URL('../../config/criteria.json', import.meta.url), 'utf8'));
const bids = normalizeNaraResponse(fixture);
const matched = matchBids(bids, criteria);
const ids = (list) => list.map((m) => m.bidId);

test('shared fixture matches 3 bids in deadline order', () => {
  assert.equal(bids.length, 7);
  assert.deepEqual(ids(matched), ['20261029007-000', '20261029001-000', '20261029002-000']);
});

test('A reasons: keyword, no region limit, assigned budget without VAT note', () => {
  const a = matched.find((m) => m.bidId === '20261029001-000');
  assert.deepEqual(a.reasons, ["키워드 '가로수' 일치", '지역 제한 없음', '예산 범위 안 (배정예산 1.2억, 부가세 표기 없음)']);
  assert.equal(a.title, '경기도 수원시 가로수 전정 및 보호 사업');
  assert.equal(a.org, '경기도 수원시');
  assert.equal(a.deadline, '2026-11-07 10:00:00');
  assert.equal(a.budget, 120000000);
  assert.equal(a.url, 'https://www.g2b.go.kr/link/20261029001');
});

test('B uses presmptPrce when asignBdgtAmt empty', () => {
  const b = matched.find((m) => m.bidId === '20261029002-000');
  assert.equal(b.budget, 380000000);
  assert.equal(b.budgetBasis, 'estimated');
  assert.equal(b.reasons.at(-1), '예산 범위 안 (추정가격 3.8억, 부가세 제외)');
});

test('G reasons end with 예산 정보 없음 and budget null', () => {
  const g = matched.find((m) => m.bidId === '20261029007-000');
  assert.equal(g.reasons.at(-1), '예산 정보 없음');
  assert.equal(g.budget, null);
});

test('C (region), D (budget), E (keyword) are excluded', () => {
  const got = ids(matched);
  assert.ok(!got.includes('20261029003-000'));
  assert.ok(!got.includes('20261029004-000'));
  assert.ok(!got.includes('20261029005-000'));
});

test('F duplicate of A is removed', () => {
  assert.equal(ids(matched).filter((id) => id === '20261029001-000').length, 1);
});

test('maxItems=2 cuts to 2', () => {
  const r = matchBids(bids, { ...criteria, maxItems: 2 });
  assert.deepEqual(ids(r), ['20261029007-000', '20261029001-000']);
});

test('empty regions: no region reason and C included', () => {
  const r = matchBids(bids, { ...criteria, regions: [] });
  assert.ok(ids(r).includes('20261029003-000'));
  for (const m of r) assert.ok(!m.reasons.some((x) => x.startsWith('지역')));
});

test('items {item:{...}} -> 1 bid', () => {
  const r = normalizeNaraResponse({ response: { header: { resultCode: '00' }, body: { items: { item: { bidNtceNo: 'X' } } } } });
  assert.equal(r.length, 1);
  assert.equal(r[0].bidNtceNo, 'X');
});

test('items {item:[...]} -> array', () => {
  const r = normalizeNaraResponse({ response: { header: { resultCode: '00' }, body: { items: { item: [{ bidNtceNo: 'X' }, { bidNtceNo: 'Y' }] } } } });
  assert.equal(r.length, 2);
});

test('items "" -> []', () => {
  assert.deepEqual(normalizeNaraResponse({ response: { header: { resultCode: '00' }, body: { items: '' } } }), []);
});

test('items missing -> []', () => {
  assert.deepEqual(normalizeNaraResponse({ response: { header: { resultCode: '00' }, body: {} } }), []);
});

test('resultCode 30 throws NARA_API_ERROR: 30', () => {
  assert.throws(
    () => normalizeNaraResponse({ response: { header: { resultCode: '30', resultMsg: 'SERVICE KEY IS NOT REGISTERED ERROR.' } } }),
    (e) => e instanceof Error && e.message.startsWith('NARA_API_ERROR: 30'),
  );
});

test('missing header throws NARA_API_ERROR: NO_HEADER', () => {
  assert.throws(() => normalizeNaraResponse({ foo: 1 }), (e) => e.message.startsWith('NARA_API_ERROR: NO_HEADER'));
});

test('JSON string input accepted', () => {
  const r = normalizeNaraResponse(JSON.stringify(fixture));
  assert.equal(r.length, 7);
});

test('non-JSON string throws NARA_API_ERROR: NON_JSON', () => {
  assert.throws(() => normalizeNaraResponse('<html>error</html>'), (e) => e.message.startsWith('NARA_API_ERROR: NON_JSON'));
});

test('formatBudget values', () => {
  assert.equal(formatBudget(null), '미공개');
  assert.equal(formatBudget(120000000), '1.2억');
  assert.equal(formatBudget(500000000), '5억');
  assert.equal(formatBudget(30000000), '3000만');
});

test('buildNotification 0 items exact text', () => {
  const n = buildNotification([], '2026-10-29');
  assert.deepEqual(n, {
    date: '2026-10-29',
    count: 0,
    items: [],
    text: '입찰 레이더 · 10/29 오늘은 조건에 맞는 새 공고가 없습니다',
  });
});

test('buildNotification 3 items text', () => {
  const n = buildNotification(matched, '2026-10-29');
  assert.equal(n.count, 3);
  assert.equal(n.items.length, 3);
  const lines = n.text.split('\n');
  assert.equal(lines[0], '입찰 레이더 · 10/29 새 공고 3건');
  assert.equal((n.text.match(/왜 추천:/g) || []).length, 3);
  assert.equal(lines.length, 1 + 4 * 3);
  assert.equal(lines[1], '1. 경기도 용인시 수목 관리 용역');
  assert.equal(lines[2], '   마감 2026-11-03 10:00:00 · 예산 미공개');
  assert.equal(lines[3], "   왜 추천: 키워드 '수목' 일치 · 지역 제한 없음 · 예산 정보 없음");
  assert.equal(lines[4], '   https://www.g2b.go.kr/link/20261029007');
  assert.equal(lines[6], '   마감 2026-11-07 10:00:00 · 예산 1.2억');
});

// ── S3 규칙: 구조화 참가가능지역 · 예산 기준 · 제외 키워드 · 비슷한 말 · 취소 제외 ──

const base = { keywords: ['조경'], regions: ['경기', '서울'], budgetMin: 30000000, budgetMax: 500000000, maxItems: 10 };
const item = (no, extra = {}) => ({
  bidNtceNo: no,
  bidNtceOrd: '000',
  bidNtceNm: '조경 시설 정비 공사',
  dminsttNm: '경기도 수원시',
  ntceInsttNm: '경기도 수원시',
  bidClseDt: '2026-11-07 10:00:00',
  opengDt: '2026-11-07 11:00:00',
  presmptPrce: '100000000',
  bidNtceDtlUrl: 'https://www.g2b.go.kr/link/' + no,
  ...extra,
});
const rgn = (...names) => ({ prtcptPsblRgnList: names.map((n, i) => ({ prtcptPsblRgnNm: n, lmtSno: String(i + 1) })) });

test('region: participation limited to 부산 is excluded even if org name says 경기', () => {
  assert.deepEqual(matchBids([item('R1', rgn('부산광역시'))], base), []);
});

test('region: org name is no longer used (부산 org, 경기 limit -> matched by limit)', () => {
  const r = matchBids([item('R2', { dminsttNm: '부산광역시', ntceInsttNm: '부산광역시', ...rgn('경기도') })], base);
  assert.equal(r.length, 1);
  assert.ok(r[0].reasons.includes("참가 가능 지역 '경기' 일치"));
});

test('region: no participation limit passes with 지역 제한 없음', () => {
  const r = matchBids([item('R3', { dminsttNm: '부산광역시' })], base);
  assert.equal(r.length, 1);
  assert.ok(r[0].reasons.includes('지역 제한 없음'));
});

test('region: criteria written as full names (경기도) match standard keys', () => {
  const r = matchBids([item('R4', rgn('경기도 화성시'))], { ...base, regions: ['경기도'] });
  assert.equal(r.length, 1);
  assert.ok(r[0].reasons.includes("참가 가능 지역 '경기' 일치"));
});

test('region: legacy prtcptLmtRgnNm is still read', () => {
  assert.deepEqual(matchBids([item('R5', { prtcptLmtRgnNm: '부산광역시' })], base), []);
  assert.equal(matchBids([item('R6', { prtcptLmtRgnNm: '서울특별시' })], base).length, 1);
});

test('광주 rule: lone 광주시 is 광주광역시, 경기도 광주시 is 경기', () => {
  assert.deepEqual(regionKeys('광주시'), ['광주']);
  assert.deepEqual(regionKeys('광주광역시'), ['광주']);
  assert.deepEqual(regionKeys('경기도 광주시'), ['경기']);
  const gg = item('R7', rgn('경기도 광주시'));
  const gj = item('R8', rgn('광주시'));
  assert.deepEqual(ids(matchBids([gg, gj], { ...base, regions: ['경기'] })), ['R7-000']);
  assert.deepEqual(ids(matchBids([gg, gj], { ...base, regions: ['광주'] })), ['R8-000']);
});

test('region: 시군구 단위 제한은 통과시키되 사유에 원문을 보여 준다', () => {
  const r = matchBids([item('R9', rgn('경기도 수원시'))], base);
  assert.equal(r.length, 1);
  assert.ok(r[0].reasons.includes("참가 가능 지역 '경기' 일치"));
  assert.ok(r[0].reasons.includes('참가 가능 지역이 시군구 단위로 제한됨: 경기도 수원시'), r[0].reasons.join(' / '));
  const whole = matchBids([item('R10', rgn('경기도'))], base)[0];
  assert.ok(!whole.reasons.some((x) => x.includes('시군구')));
  const both = matchBids([item('R11', rgn('경기도', '경기도 수원시'))], base)[0];
  assert.ok(!both.reasons.some((x) => x.includes('시군구')), '시도 전체가 열려 있으면 시군구 사유 없음');
});

test('subRegionLimit: 시도 키별 시군구 제한 원문', () => {
  assert.equal(subRegionLimit('경기도 수원시', ['경기']), '경기도 수원시');
  assert.equal(subRegionLimit('경기도 수원시, 경기도 용인시', ['경기']), '경기도 수원시, 경기도 용인시');
  assert.equal(subRegionLimit('경기도', ['경기']), null);
  assert.equal(subRegionLimit('경기도, 경기도 수원시', ['경기']), null);
  assert.equal(subRegionLimit('서울특별시 강남구', ['경기']), null);
  assert.equal(subRegionLimit('세종특별자치시', ['세종']), null);
  assert.equal(subRegionLimit('광주시', ['광주']), null);
  assert.equal(subRegionLimit('', ['경기']), null);
});

test('budget basis: estimated → base → assigned with VAT notes', () => {
  const est = matchBids([item('B1')], base)[0];
  assert.equal(est.reasons.at(-1), '예산 범위 안 (추정가격 1억, 부가세 제외)');
  assert.equal(est.budgetBasis, 'estimated');
  const bs = matchBids([item('B2', { presmptPrce: '', bssamt: '110000000' })], base)[0];
  assert.equal(bs.reasons.at(-1), '예산 범위 안 (기초금액 1.1억, 부가세 포함)');
  assert.equal(bs.budget, 110000000);
  const bd = matchBids([item('B3', { presmptPrce: '', bdgtAmt: '132000000' })], base)[0];
  assert.equal(bd.reasons.at(-1), '예산 범위 안 (배정예산 1.3억, 부가세 포함)');
  const as = matchBids([item('B4', { presmptPrce: '', asignBdgtAmt: '120000000' })], base)[0];
  assert.equal(as.reasons.at(-1), '예산 범위 안 (배정예산 1.2억, 부가세 표기 없음)');
  assert.deepEqual(as.amounts, { estimated: null, base: null, assigned: 120000000, vatIncluded: true });
});

test('budget out of range by chosen basis is excluded', () => {
  assert.deepEqual(matchBids([item('B5', { presmptPrce: '600000000', bssamt: '100000000' })], base), []);
});

test('exclude keyword 묘지 drops a bid even when a keyword matches', () => {
  const list = [item('X1', { bidNtceNm: '공원묘지 조경 정비' }), item('X2')];
  assert.deepEqual(ids(matchBids(list, { ...base, excludeKeywords: ['묘지'] })), ['X2-000']);
  assert.equal(matchBids(list, base).length, 2);
});

test('cancelled notices are excluded, changed ones kept', () => {
  const list = [item('K1', { ntceKindNm: '취소공고' }), item('K2', { ntceKindNm: '변경공고' })];
  const r = matchBids(list, base);
  assert.deepEqual(ids(r), ['K2-000']);
  assert.equal(r[0].kind, 'changed');
});

test('synonym match adds its own reason and counts as a match', () => {
  const r = matchBids([item('S1', { bidNtceNm: '녹지 시설물 유지관리' })], { ...base, synonyms: { 시설물: '조경' } });
  assert.equal(r.length, 1);
  assert.equal(r[0].reasons[0], "비슷한 말 '시설물' 일치 (키워드 '조경')");
  assert.deepEqual(matchBids([item('S2', { bidNtceNm: '녹지 시설물 유지관리' })], base), []);
});

test('MatchedBid keeps first 7 fields and adds kind/openingAt/budgetBasis/amounts', () => {
  const m = matchBids([item('M1', { source: 'nara' })], base)[0];
  assert.deepEqual(Object.keys(m).slice(0, 7), ['bidId', 'title', 'org', 'deadline', 'budget', 'url', 'reasons']);
  assert.equal(m.kind, 'new');
  assert.equal(m.openingAt, '2026-11-07 11:00:00');
  assert.equal(m.budgetBasis, 'estimated');
  assert.deepEqual(m.amounts, { estimated: 100000000, base: null, assigned: null, vatIncluded: false });
  assert.equal(m.source, 'nara');
});

test('already normalized input gives the same result', () => {
  const raw = [item('N1', rgn('서울특별시'))];
  assert.deepEqual(matchBids(raw.map((b) => normalizeBid(b)), base), matchBids(raw, base));
});

const prestdItems = JSON.parse(readFileSync(new URL('../fixtures/nara/prestd-cnstwk.json', import.meta.url), 'utf8')).response.body.items;
const listP1 = JSON.parse(readFileSync(new URL('../fixtures/nara/list-cnstwk-p1.json', import.meta.url), 'utf8')).response.body.items;

test('parseNoticeNos: comma list (measured form), several numbers, order kept, duplicates dropped', () => {
  assert.deepEqual(parseNoticeNos('R26BK01900005'), ['R26BK01900005']);
  assert.deepEqual(parseNoticeNos('R26BK01900007,R26BK01900005,R26BK01900007'), ['R26BK01900007', 'R26BK01900005']);
  assert.deepEqual(parseNoticeNos('R26BK01900007;R26BK01900008^R26BK01900009|R26BK01900010 R26BK01900011'), [
    'R26BK01900007',
    'R26BK01900008',
    'R26BK01900009',
    'R26BK01900010',
    'R26BK01900011',
  ]);
});

test('parseNoticeNos: trailing -NNN order removed, short or odd tokens dropped, non-string/empty → []', () => {
  assert.deepEqual(parseNoticeNos('R26BK01900005-001, R26BK01900006'), ['R26BK01900005', 'R26BK01900006']);
  assert.deepEqual(parseNoticeNos('AB12,,R26-BK,R26BK01900005'), ['R26BK01900005']);
  assert.deepEqual(parseNoticeNos(''), []);
  assert.deepEqual(parseNoticeNos('   '), []);
  assert.deepEqual(parseNoticeNos(null), []);
  assert.deepEqual(parseNoticeNos(undefined), []);
  assert.deepEqual(parseNoticeNos(12345678), []);
});

test('links: main notice with bfSpecRgstNo → prestdId PS…-000, noticeNos []', () => {
  const item = listP1.find((x) => x.bfSpecRgstNo === 'R26BD00900005');
  const n = normalizeBid(item, 'nara-cnstwk');
  assert.equal(n.bidId, 'R26BK01900005-000');
  assert.deepEqual(n.links, { prestdId: 'PSR26BD00900005-000', noticeNos: [] });
  const plain = normalizeBid(listP1.find((x) => x.bfSpecRgstNo === ''), 'nara-cnstwk');
  assert.deepEqual(plain.links, { prestdId: null, noticeNos: [] });
});

test('links: prestd → prestdId is own bidId, noticeNos from bidNtceNoList (empty list → [])', () => {
  const linked = normalizeBid(prestdItems.find((x) => x.bfSpecRgstNo === 'R26BD00900005'), 'nara-prestd');
  assert.equal(linked.kind, 'prestd');
  assert.deepEqual(linked.links, { prestdId: 'PSR26BD00900005-000', noticeNos: ['R26BK01900005'] });
  const empty = normalizeBid(prestdItems.find((x) => x.bfSpecRgstNo === 'R26BD00900001'), 'nara-prestd');
  assert.deepEqual(empty.links, { prestdId: 'PSR26BD00900001-000', noticeNos: [] });
  const many = normalizeBid({ ...prestdItems[0], bidNtceNoList: 'R26BK01900007,R26BK01900008' }, 'nara-prestd');
  assert.deepEqual(many.links.noticeNos, ['R26BK01900007', 'R26BK01900008']);
});
