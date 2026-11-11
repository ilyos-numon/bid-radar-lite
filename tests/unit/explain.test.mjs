// 왜 추천됐나: 조건 4개(키워드·제외어·지역·예산)마다 맞음/안 맞음/정보 없음
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainMatch, EXPLAIN_TEXT } from '../../app/core/explain.mjs';

const CRIT = { keywords: ['조경', '수목', '공원'], excludeKeywords: ['철거'], regions: ['경기'], budgetMin: 50000000, budgetMax: 300000000 };
const byId = (r) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

test('explain: all four conditions met', () => {
  const r = explainMatch(CRIT, { title: '근린공원 조경 공사', region: '경기도 수원시', budget: 120000000 });
  assert.equal(r.total, 4);
  assert.equal(r.met, 4);
  assert.deepEqual(r.checks.map((c) => c.id), ['keyword', 'exclude', 'region', 'budget']);
  const c = byId(r);
  assert.deepEqual(c.keyword, { id: 'keyword', ok: true, text: "키워드 '조경' 일치" });
  assert.deepEqual(c.exclude, { id: 'exclude', ok: true, text: '제외어 없음' });
  assert.deepEqual(c.region, { id: 'region', ok: true, text: "지역 '경기' 일치" });
  assert.deepEqual(c.budget, { id: 'budget', ok: true, text: '예산 범위 안 (1.2억)' });
});

test('explain: keyword missing lists the keywords', () => {
  const c = byId(explainMatch(CRIT, { title: '도로 포장 공사', region: '경기', budget: 100000000 }));
  assert.deepEqual(c.keyword, { id: 'keyword', ok: false, text: '키워드 없음 (조경·수목·공원)' });
});

test('explain: synonyms[].word counts as a keyword hit', () => {
  const r = explainMatch(CRIT, { title: '가로수 정비', region: '경기', budget: 100000000 }, { synonyms: [{ word: '가로수' }] });
  assert.deepEqual(byId(r).keyword, { id: 'keyword', ok: true, text: "키워드 '가로수' 일치" });
  assert.equal(r.met, 4);
});

test('explain: exclude word present', () => {
  const r = explainMatch(CRIT, { title: '공원 시설 철거 공사', region: '경기', budget: 100000000 });
  assert.deepEqual(byId(r).exclude, { id: 'exclude', ok: false, text: "제외어 '철거' 포함" });
  assert.equal(r.met, 3);
});

test('explain: region empty in criteria → 지역 제한 없음', () => {
  const r = explainMatch({ ...CRIT, regions: [] }, { title: '공원 조경', budget: 100000000 });
  assert.deepEqual(byId(r).region, { id: 'region', ok: true, text: '지역 제한 없음' });
});

test('explain: bid region unknown → null 지역 정보 없음; other region → false 제외', () => {
  const none = explainMatch(CRIT, { title: '공원 조경', budget: 100000000 });
  assert.deepEqual(byId(none).region, { id: 'region', ok: null, text: '지역 정보 없음' });
  assert.equal(none.met, 3, 'null is not counted as met');
  const busan = explainMatch(CRIT, { title: '공원 조경', region: '부산광역시', budget: 100000000 });
  assert.deepEqual(byId(busan).region, { id: 'region', ok: false, text: "지역 '부산' 제외" });
});

test('explain: stored bid limits.regions is used when region is absent', () => {
  const r = explainMatch(CRIT, { title: '공원 조경', limits: { regions: ['서울', '경기'] }, budget: 100000000 });
  assert.deepEqual(byId(r).region, { id: 'region', ok: true, text: "지역 '경기' 일치" });
  const empty = explainMatch(CRIT, { title: '공원 조경', limits: { regions: [] }, budget: 100000000 });
  assert.equal(byId(empty).region.ok, null);
});

test('explain: budget null → 정보 없음, outside range → 범위 밖', () => {
  assert.deepEqual(byId(explainMatch(CRIT, { title: '공원', region: '경기', budget: null })).budget, { id: 'budget', ok: null, text: '예산 정보 없음' });
  assert.deepEqual(byId(explainMatch(CRIT, { title: '공원', region: '경기', budget: 750000000 })).budget, { id: 'budget', ok: false, text: '예산 범위 밖 (7.5억)' });
  assert.deepEqual(byId(explainMatch(CRIT, { title: '공원', region: '경기', budget: 30000000 })).budget, { id: 'budget', ok: false, text: '예산 범위 밖 (3000만)' });
});

test('explain: missing budget bounds are open-ended', () => {
  const r = explainMatch({ keywords: ['조경'], regions: [], budgetMin: null, budgetMax: null }, { title: '조경', budget: 9e9 });
  assert.equal(byId(r).budget.ok, true);
  assert.equal(r.met, 4);
});

test('explain: never throws on empty or broken input', () => {
  for (const [c, b] of [[null, null], [undefined, undefined], [{}, {}], [{ keywords: 'x' }, { title: 3, budget: 'abc' }]]) {
    const r = explainMatch(c, b);
    assert.equal(r.total, 4);
    assert.equal(r.checks.length, 4);
  }
  const r = explainMatch({}, { title: '무엇' });
  assert.deepEqual(byId(r).keyword, { id: 'keyword', ok: false, text: '키워드 없음' });
});

test('explain: EXPLAIN_TEXT summary and labels', () => {
  assert.equal(EXPLAIN_TEXT.summary(3, 4), '왜 추천됐나 · 3/4 조건 맞음');
  assert.equal(EXPLAIN_TEXT.ok, '맞음');
  assert.equal(EXPLAIN_TEXT.no, '안 맞음');
  assert.equal(EXPLAIN_TEXT.unknown, '정보 없음');
});
