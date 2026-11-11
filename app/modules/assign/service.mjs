// 업무 분배 로직: 상태 이름, 뱃지, assign_items 읽기·쓰기 (다른 모듈 테이블은 건드리지 않는다)

export const STATUSES = ['review', 'go', 'pass'];
export const STATUS_LABELS = { review: '검토중', go: '참여', pass: '패스' };

/** @param {unknown} s */
export function isStatus(s) {
  return typeof s === 'string' && STATUSES.includes(s);
}

/** @param {string} s */
export function statusLabel(s) {
  return STATUS_LABELS[s] ?? '';
}

/** 뱃지 뜻(kind)을 덧붙인다. 목록 비교(label·href)에는 나타나지 않게 열거하지 않는 속성으로 둔다 */
function withKind(b, kind) {
  return Object.defineProperty(b, 'kind', { value: kind, enumerable: false });
}

/**
 * @param {string} bidId
 * @param {{name: string, status: string}|null} item 담당 정보 (없으면 null)
 * @returns {{label: string, href: string, kind: 'assign'|'assign-set'}} kind 는 열거하지 않는 속성
 */
export function badgeFor(bidId, item) {
  const href = `/assign/${encodeURIComponent(bidId)}`;
  if (!item) return withKind({ label: '담당자 정하기', href }, 'assign');
  return withKind({ label: `담당 ${item.name} · ${statusLabel(item.status)}`, href }, 'assign-set');
}

const TIME_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** ISO 시각 → 'YYYY-MM-DD HH:MM' (서울). 읽을 수 없으면 '' */
export function formatTime(iso) {
  const d = new Date(String(iso ?? ''));
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(TIME_FMT.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function toItem(row) {
  if (!row) return null;
  return {
    bidId: row.bid_id,
    assigneeId: row.assignee_id === null || row.assignee_id === undefined ? null : Number(row.assignee_id),
    name: row.name ?? null,
    status: row.status,
    note: row.note ?? '',
    updatedAt: row.updated_at,
    updatedBy: row.updated_by === null || row.updated_by === undefined ? null : Number(row.updated_by),
    updatedByName: row.updated_by_name ?? null,
    title: row.title ?? null,
    deadline: row.deadline ?? null,
  };
}

const SELECT = `SELECT a.*, b.title AS title, b.deadline AS deadline
  FROM assign_items a
  LEFT JOIN bids b ON b.bid_id = a.bid_id`;

// members 를 넘기지 않은 호출부(이전 방식)용: 업무 DB 의 members 표에서 이름을 읽는다
const SELECT_LEGACY = `SELECT a.*, m.name AS name, u.name AS updated_by_name, b.title AS title, b.deadline AS deadline
  FROM assign_items a
  LEFT JOIN members m ON m.id = a.assignee_id
  LEFT JOIN members u ON u.id = a.updated_by
  LEFT JOIN bids b ON b.bid_id = a.bid_id`;

/** 담당자·수정자 이름을 MembersStore 목록으로 채운다 (못 찾으면 null) */
async function withNames(items, members) {
  const byId = new Map((await members.list()).map((m) => [Number(m.id), m.name]));
  for (const it of items) {
    if (!it) continue;
    it.name = it.assigneeId === null ? null : (byId.get(it.assigneeId) ?? null);
    it.updatedByName = it.updatedBy === null ? null : (byId.get(it.updatedBy) ?? null);
  }
  return items;
}

/**
 * @param {object} db @param {string} bidId
 * @param {{ list(): Promise<object[]> }} [members] ctx.members — 있으면 이름을 여기서 찾는다(기존·가입 모드 공통)
 * @returns {Promise<object|null>}
 */
export async function getItem(db, bidId, members) {
  if (!members) return toItem(await db.get(`${SELECT_LEGACY} WHERE a.bid_id = $1`, [String(bidId)]));
  const item = toItem(await db.get(`${SELECT} WHERE a.bid_id = $1`, [String(bidId)]));
  if (item) await withNames([item], members);
  return item;
}

/** 최근 수정 순 전체 (members 는 getItem 과 같다) */
export async function listItems(db, members) {
  if (!members) return (await db.all(`${SELECT_LEGACY} ORDER BY a.updated_at DESC, a.bid_id`)).map(toItem);
  return withNames((await db.all(`${SELECT} ORDER BY a.updated_at DESC, a.bid_id`)).map(toItem), members);
}

/** 상태별로 나눈다 (검토중 → 참여 → 패스) */
export function groupByStatus(items) {
  return STATUSES.map((status) => ({ status, label: statusLabel(status), items: items.filter((i) => i.status === status) }));
}

/**
 * 같은 공고는 한 행만 둔다 (upsert)
 * @param {{bidId: string, assigneeId: number, status: string, note: string, updatedAt: string, updatedBy: number}} v
 */
export async function saveItem(db, { bidId, assigneeId, status, note, updatedAt, updatedBy }) {
  if (!isStatus(status)) throw new Error(`bad status: ${status}`);
  await db.run(
    `INSERT INTO assign_items (bid_id, assignee_id, status, note, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, bid_id) DO UPDATE SET
       assignee_id = excluded.assignee_id, status = excluded.status, note = excluded.note,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [String(bidId), assigneeId, status, note, updatedAt, updatedBy],
  );
}

/** 초대 링크 주소: APP_BASE_URL(없으면 요청의 origin) + /join/<값> */
export function inviteUrl(baseUrl, origin, secret) {
  const base = String(baseUrl || origin || '').replace(/\/+$/, '');
  return `${base}/join/${encodeURIComponent(secret)}`;
}
