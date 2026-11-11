// 관심 공고·지난 개찰·업무 분배 본문 함수의 `example` 옵션: 켜졌을 때만 제목 옆에 `예시 데이터` 칩
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHtml } from '../../app/core/html.mjs';
import { listBody, interestBody } from '../../app/modules/interest/view.mjs';
import { historyBody } from '../../app/modules/history/view.mjs';
import { boardBody, assignBoardBody } from '../../app/modules/assign/view.mjs';

const CHIP = '<span class="chip example">예시 데이터</span>';
const CHIP_TEXT = '예시 데이터';

/** 공용 html 헬퍼. exampleChip 이 아직 없으면 약속된 모양(이름 있는 export + 메서드)을 전제로 채운다 */
function helpers() {
  const h = createHtml({ menus: () => [] });
  return typeof h.exampleChip === 'function' ? h : { ...h, exampleChip: () => CHIP };
}

/** exampleChip 이 없는 헬퍼(병합 전 모양) */
function helpersWithoutChip() {
  const h = { ...createHtml({ menus: () => [] }) };
  delete h.exampleChip;
  return h;
}

const TODAY = '2026-11-04';
const INTEREST_ITEMS = [
  { bid: { bidId: 'DEMO-001', title: '근린공원 조경 공사', org: '예시시청(예시)', deadline: '2026-11-07 10:00', url: 'https://example.com/demo/DEMO-001' }, dday: 'D-3 10:00', checks: [true, false], badges: [] },
  { bid: { bidId: 'DEMO-002', title: '가로수 수목 정비', org: '예시군청(예시)', deadline: '2026-11-20 10:00' }, dday: 'D-16 10:00', checks: [], badges: [] },
];
const HISTORY_RESULT = {
  status: 'ok',
  rows: [
    { bidId: 'DEMO-101', title: '수목 식재 공사', org: '예시구청(예시)', openingAt: '2026-10-20 11:00', participants: 12, award: { name: '예시조경', amount: 120000000, rate: 87.5 } },
    { bidId: 'DEMO-102', title: '공원 정비 공사', org: '예시시청(예시)', openingAt: '2026-10-21 11:00', participants: 8, top: { name: '예시녹화', amount: 90000000, rate: 88.1 } },
  ],
};
const GROUPS = [
  { status: 'review', label: '검토 중', items: [{ bidId: 'DEMO-001', title: '근린공원 조경 공사', name: '예시 대표', status: 'review', deadline: '2026-11-07 10:00' }] },
  { status: 'go', label: '참여', items: [{ bidId: 'DEMO-002', title: '가로수 수목 정비', name: '예시 구성원 가', status: 'go', deadline: '2026-11-20 10:00' }] },
  { status: 'pass', label: '안 함', items: [] },
];

const count = (s, sub) => s.split(sub).length - 1;

describe('example chip on list views', () => {
  test('interest list: chip on every card only when example is true', () => {
    const h = helpers();
    const off = listBody(h, INTEREST_ITEMS, TODAY);
    assert.ok(!off.includes(CHIP_TEXT));
    assert.equal(listBody(h, INTEREST_ITEMS, TODAY, { example: false }), off);
    const on = listBody(h, INTEREST_ITEMS, TODAY, { example: true });
    assert.equal(count(on, CHIP), INTEREST_ITEMS.length);
    // 제목 옆 (제목 요소 안)
    assert.match(on, /<h2 class="title"[^>]*>근린공원 조경 공사 <span class="chip example">예시 데이터<\/span><\/h2>/);
  });

  test('interestBody(h, { items, today, example }) is the same body', () => {
    const h = helpers();
    assert.equal(interestBody(h, { items: INTEREST_ITEMS, today: TODAY }), listBody(h, INTEREST_ITEMS, TODAY));
    assert.equal(interestBody(h, { items: INTEREST_ITEMS, today: TODAY, example: true }), listBody(h, INTEREST_ITEMS, TODAY, { example: true }));
  });

  test('interest empty list: no chip even when example is true', () => {
    const h = helpers();
    assert.ok(!listBody(h, [], TODAY, { example: true }).includes(CHIP_TEXT));
  });

  test('history table: chip on every row only when example is true', () => {
    const h = helpers();
    const base = { q: '조경', days: 30, result: HISTORY_RESULT };
    const off = historyBody(h, base);
    assert.ok(!off.includes(CHIP_TEXT));
    assert.equal(historyBody(h, { ...base, example: false }), off);
    const on = historyBody(h, { ...base, example: true });
    assert.equal(count(on, CHIP), HISTORY_RESULT.rows.length);
    assert.ok(on.includes(`<td>수목 식재 공사 ${CHIP}<br>`));
    // 검색 전에는 행이 없으니 칩도 없다
    assert.ok(!historyBody(h, { q: '', days: 30, result: null, example: true }).includes(CHIP_TEXT));
  });

  test('assign board: chip on every card only when example is true', () => {
    const h = helpers();
    const base = { groups: GROUPS, members: [], today: TODAY };
    const off = boardBody(h, base);
    assert.ok(!off.includes(CHIP_TEXT));
    assert.equal(boardBody(h, { ...base, example: false }), off);
    const on = boardBody(h, { ...base, example: true });
    assert.equal(count(on, CHIP), 2);
    assert.match(on, /근린공원 조경 공사<\/a> <span class="chip example">예시 데이터<\/span><\/h3>/);
    assert.equal(assignBoardBody(h, { ...base, example: true }), on);
    assert.equal(assignBoardBody(h, base), off);
  });

  test('helper without exampleChip: example true renders without chip and does not throw', () => {
    const h = helpersWithoutChip();
    assert.ok(!listBody(h, INTEREST_ITEMS, TODAY, { example: true }).includes(CHIP_TEXT));
    assert.ok(!historyBody(h, { q: '조경', days: 30, result: HISTORY_RESULT, example: true }).includes(CHIP_TEXT));
    assert.ok(!boardBody(h, { groups: GROUPS, members: [], today: TODAY, example: true }).includes(CHIP_TEXT));
  });
});
