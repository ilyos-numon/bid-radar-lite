// 관심 공고: 담기·해제·확인 항목·D-day·마감 임박 알림 (순수 로직, ctx.db 만 쓴다)
import { CHECKLIST } from './view.mjs';

export const REMINDER_DAYS = [7, 3, 1, 0];

/** dday 문자열 'D-9 10:00'·'D-9' → 9, 그 밖('마감 지남'·'마감 미확인') → null */
export function ddayNumber(label) {
  const m = /^D-(\d+)/.exec(String(label ?? ''));
  return m ? Number(m[1]) : null;
}

/** @param {object} ctx @param {string} bidId */
export async function isInterested(ctx, bidId) {
  return Boolean(await ctx.db.get('SELECT 1 AS x FROM interest_items WHERE bid_id = $1', [String(bidId)]));
}

/** @returns {boolean} 새로 담았으면 true, 이미 있으면 false */
export async function addInterest(ctx, bidId, memberId) {
  const info = await ctx.db.run(
    `INSERT INTO interest_items (bid_id, member_id, created_at, note) VALUES ($1, $2, $3, NULL)
     ON CONFLICT (workspace_id, bid_id) DO NOTHING`,
    [String(bidId), memberId ?? null, ctx.now().toISOString()],
  );
  return info.rowCount > 0;
}

/** 관심 해제: 항목과 확인 기록을 함께 지운다 */
export async function removeInterest(ctx, bidId) {
  const id = String(bidId);
  await ctx.db.run('DELETE FROM interest_checks WHERE bid_id = $1', [id]);
  const info = await ctx.db.run('DELETE FROM interest_items WHERE bid_id = $1', [id]);
  return info.rowCount > 0;
}

/** @param {number} item 1..CHECKLIST.length @param {boolean} checked */
export async function setCheck(ctx, bidId, item, checked) {
  await ctx.db.run(
    `INSERT INTO interest_checks (bid_id, item, checked) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, bid_id, item) DO UPDATE SET checked = excluded.checked`,
    [String(bidId), Number(item), checked ? 1 : 0],
  );
}

/** @returns {boolean[]} CHECKLIST 순서의 체크 여부 */
export async function checksFor(ctx, bidId) {
  const rows = await ctx.db.all('SELECT item, checked FROM interest_checks WHERE bid_id = $1', [String(bidId)]);
  const out = CHECKLIST.map(() => false);
  for (const r of rows) {
    const i = Number(r.item) - 1;
    if (i >= 0 && i < out.length) out[i] = Number(r.checked) === 1;
  }
  return out;
}

/**
 * 마감 시각(Asia/Seoul) 을 Date 로. 시각이 없으면 그날 23:59:59. 읽지 못하면 null
 * @param {string} deadline 'YYYY-MM-DD HH:MM[:SS]' | 'YYYY-MM-DD'
 */
function deadlineInstant(deadline) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(deadline ?? '').trim());
  if (!m) return null;
  const time = m[4] ? `${m[4]}:${m[5]}:${m[6] ?? '00'}` : '23:59:59';
  const t = new Date(`${m[1]}-${m[2]}-${m[3]}T${time}+09:00`);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** 업무 분배 메뉴가 켜져 있는지 (decorate 훅 등록 여부로 본다) */
function hasAssign(ctx) {
  return Boolean(ctx.hooks && Array.isArray(ctx.hooks.decorate) && ctx.hooks.decorate.some((h) => h.id === 'assign'));
}

/** 담당자 이름 (업무 분배 기록을 읽기만). 업무 분배 메뉴·기록이 없으면 '미정' */
export async function assigneeName(ctx, bidId) {
  if (!hasAssign(ctx)) return '미정';
  try {
    const row = await ctx.db.get('SELECT assignee_id FROM assign_items WHERE bid_id = $1', [String(bidId)]);
    if (!row || row.assignee_id === null || row.assignee_id === undefined) return '미정';
    const m = await ctx.members.get(Number(row.assignee_id));
    return m && m.name ? String(m.name) : '미정';
  } catch {
    return '미정';
  }
}

/** 정렬 키: 남은 날짜 오름차순 → 마감 미확인 → 마감 지남 */
function rank(label) {
  const n = ddayNumber(label);
  if (n !== null) return [0, n];
  return label === '마감 미확인' ? [1, 0] : [2, 0];
}

/**
 * 관심 공고 목록 (D-day 임박 순)
 * @returns {Promise<Array<{bid: object, dday: string, checks: boolean[], createdAt: string}>>}
 */
export async function listInterest(ctx, today) {
  const rows = await ctx.db.all('SELECT bid_id, created_at FROM interest_items');
  const out = [];
  for (const r of rows) {
    const bid = await ctx.bids.get(r.bid_id);
    if (!bid) continue;
    out.push({ bid, dday: ctx.html.dday(bid.deadline, today), checks: await checksFor(ctx, r.bid_id), createdAt: r.created_at });
  }
  out.sort((a, b) => {
    const [ga, na] = rank(a.dday);
    const [gb, nb] = rank(b.dday);
    if (ga !== gb) return ga - gb;
    if (na !== nb) return na - nb;
    const da = String(a.bid.deadline ?? '');
    const db = String(b.bid.deadline ?? '');
    if (ga === 2) return db.localeCompare(da);
    return da.localeCompare(db) || String(a.bid.bidId).localeCompare(String(b.bid.bidId));
  });
  return out;
}

/**
 * 마감 임박 알림: date 기준 D-7·D-3·D-1·D-0 인 관심 공고를 (D-0 은 ctx.now() 가 마감 시각 이전일 때만) (공고, 날짜) 당 한 번만.
 * @param {object} ctx @param {{date?: string, dry?: boolean}} opts
 * @returns {Promise<object|null>} NotificationV2 (kind 'reminder') 또는 대상이 없으면 null
 */
export async function reminders(ctx, { date, dry } = {}) {
  const d = date || ctx.today();
  const sent = (bidId, day) => ctx.db.get('SELECT 1 AS x FROM interest_reminders WHERE bid_id = $1 AND day = $2', [bidId, day]);
  const items = [];
  for (const { bid, dday, checks } of await listInterest(ctx, d)) {
    const k = ddayNumber(dday);
    if (k === null || !REMINDER_DAYS.includes(k)) continue;
    if (k === 0) {
      const at = deadlineInstant(bid.deadline);
      if (!at || ctx.now().getTime() >= at.getTime()) continue;
    }
    if (await sent(bid.bidId, k)) continue;
    items.push({
      bidId: bid.bidId,
      title: bid.title,
      org: bid.org,
      deadline: bid.deadline,
      budget: bid.budget,
      url: bid.url,
      reasons: [],
      dday,
      assignee: await assigneeName(ctx, bid.bidId),
      checklist: CHECKLIST.filter((_, i) => !checks[i]),
      day: k,
    });
  }
  if (items.length === 0) return null;
  if (!dry) {
    for (const it of items) {
      await ctx.db.run(
        `INSERT INTO interest_reminders (bid_id, day, sent_date) VALUES ($1, $2, $3)
         ON CONFLICT (workspace_id, bid_id, day) DO NOTHING`,
        [it.bidId, it.day, d],
      );
    }
  }
  return {
    kind: 'reminder',
    date: d,
    count: items.length,
    items: items.map(({ day, ...rest }) => rest),
  };
}
