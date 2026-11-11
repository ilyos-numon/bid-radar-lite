// 공고 저장(bids + bid_details), 변경 이력(bid_changes), 날짜별 추천 결과(matches)
import { normalizeBid } from './normalize.mjs';
import { transaction } from './db.mjs';

/** bid_changes 에 남기는 필드 → StoredBid 값 */
const CHANGE_FIELDS = ['deadline', 'kind', 'budget', 'openingAt'];

function parseJson(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

/** row = bids.* + bid_details(d_kind, d_opening_at, d_budget_basis, d_norm, d_last_seen) */
function toStored(row) {
  if (!row) return null;
  const raw = JSON.parse(row.raw);
  const base = {
    bidId: row.bid_id,
    sourceId: row.source_id,
    title: row.title,
    org: row.org,
    deadline: row.deadline,
    budget: row.budget === null || row.budget === undefined ? null : Number(row.budget),
    url: row.url,
    raw,
    firstSeen: row.first_seen,
  };
  if (row.d_kind === null || row.d_kind === undefined) {
    // bid_details 가 생기기 전에 저장된 행: 원본에서 다시 계산한다
    const n = normalizeBid(raw, row.source_id);
    return {
      ...base,
      kind: n.kind,
      openingAt: n.openingAt,
      budgetBasis: n.budgetBasis,
      amounts: n.amounts,
      limits: n.limits,
      noticeOrg: n.noticeOrg,
      postedAt: n.postedAt,
      lastSeen: null,
    };
  }
  const norm = parseJson(row.d_norm, {});
  return {
    ...base,
    kind: row.d_kind,
    openingAt: row.d_opening_at ?? null,
    budgetBasis: row.d_budget_basis ?? null,
    amounts: norm.amounts ?? { estimated: null, base: null, assigned: null, vatIncluded: null },
    limits: norm.limits ?? { regions: [], regionRaw: null, licenses: [], sme: null },
    noticeOrg: norm.noticeOrg ?? '',
    postedAt: norm.postedAt ?? null,
    lastSeen: row.d_last_seen,
  };
}

/** @param {any} v */
function changeValue(v) {
  return v === null || v === undefined || v === '' ? null : String(v);
}

function parseReasons(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toMatched(row) {
  return {
    bidId: row.bid_id,
    title: row.title ?? '',
    org: row.org ?? '',
    deadline: row.deadline ?? '',
    budget: row.budget === null || row.budget === undefined ? null : Number(row.budget),
    url: row.url ?? '',
    reasons: parseReasons(row.reasons),
  };
}

/** 링크 상대편 공고 → LinkedBid. 저장돼 있지 않으면 stored:false 와 빈 값 */
function toLinked(row, fallbackId, noticeNo) {
  const s = row ? toStored(row) : null;
  if (!s) {
    return { bidId: fallbackId, noticeNo, title: '', kind: null, deadline: null, postedAt: null, url: null, stored: false };
  }
  return {
    bidId: s.bidId,
    noticeNo,
    title: s.title ?? '',
    kind: s.kind ?? null,
    deadline: s.deadline ?? null,
    postedAt: s.postedAt ?? null,
    url: s.url ?? null,
    stored: true,
  };
}

const STORED_SELECT = `SELECT b.*, d.kind AS d_kind, d.opening_at AS d_opening_at, d.budget_basis AS d_budget_basis,
    d.norm AS d_norm, d.last_seen AS d_last_seen
  FROM bids b LEFT JOIN bid_details d ON d.bid_id = b.bid_id`;

const GET_SQL = `${STORED_SELECT} WHERE b.bid_id = $1`;
const DETAIL_SQL = `INSERT INTO bid_details (bid_id, kind, opening_at, budget_basis, norm, last_seen)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, bid_id) DO UPDATE SET
       kind = excluded.kind, opening_at = excluded.opening_at, budget_basis = excluded.budget_basis,
       norm = excluded.norm, last_seen = excluded.last_seen`;
const CHANGE_SQL = 'INSERT INTO bid_changes (bid_id, seen_at, field, old, new) VALUES ($1, $2, $3, $4, $5)';
const UPSERT_SQL = `INSERT INTO bids (bid_id, source_id, title, org, deadline, budget, url, raw, first_seen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (workspace_id, bid_id) DO UPDATE SET
       source_id = excluded.source_id, title = excluded.title, org = excluded.org,
       deadline = excluded.deadline, budget = excluded.budget, url = excluded.url, raw = excluded.raw`;
const LINK_SQL = `INSERT INTO bid_links (prestd_id, notice_no, origin, seen_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, prestd_id, notice_no) DO UPDATE SET seen_at = excluded.seen_at, origin = excluded.origin`;
const PRESTD_OF_NOTICE_SQL = 'SELECT prestd_id FROM bid_links WHERE notice_no = $1 ORDER BY seen_at DESC, prestd_id DESC LIMIT 1';
const NOTICES_OF_PRESTD_SQL = 'SELECT notice_no FROM bid_links WHERE prestd_id = $1';
const LATEST_ORD_SQL = `${STORED_SELECT} WHERE b.bid_id LIKE $1 || '-%' ORDER BY b.bid_id DESC LIMIT 1`;
const MATCH_ROWS_SQL = `SELECT m.bid_id, m.kind, m.rank, m.reasons, b.title, b.org, b.deadline, b.budget, b.url
    FROM matches m LEFT JOIN bids b ON b.bid_id = m.bid_id
    WHERE m.date = $1 ORDER BY CASE m.kind WHEN 'match' THEN 0 ELSE 1 END, m.rank`;

/** @param {{db: any, today(): string, now?(): Date}} ctx */
export function create(ctx) {
  const { db } = ctx;
  const nowIso = () => (typeof ctx.now === 'function' ? ctx.now() : new Date()).toISOString();

  const bids = {
    /** @returns {Promise<object|null>} StoredBid */
    async get(bidId) {
      return toStored(await db.get(GET_SQL, [String(bidId)]));
    },
    /** 그날 matches 순서 (추천 → 관련 가능성) */
    async listByDate(date) {
      const rows = await db.all(
        `SELECT b.*, d.kind AS d_kind, d.opening_at AS d_opening_at, d.budget_basis AS d_budget_basis,
           d.norm AS d_norm, d.last_seen AS d_last_seen
         FROM matches m JOIN bids b ON b.bid_id = m.bid_id LEFT JOIN bid_details d ON d.bid_id = b.bid_id
         WHERE m.date = $1 ORDER BY CASE m.kind WHEN 'match' THEN 0 ELSE 1 END, m.rank`,
        [String(date)],
      );
      return rows.map(toStored);
    },
    /**
     * first_seen 은 처음 저장한 날을 유지하고 나머지는 새 값으로 바꾼다.
     * 이미 저장된 공고면 deadline·kind·budget·openingAt 중 값이 달라진 것마다 bid_changes 에 한 행.
     * @param {object} itemOrNormalized SourceBid 또는 NormalizedBid
     * @param {string} sourceId
     * @returns {Promise<object>} StoredBid
     */
    async upsert(itemOrNormalized, sourceId) {
      const n = normalizeBid(itemOrNormalized, sourceId);
      const raw = n.raw ?? itemOrNormalized;
      const prev = await db.get(GET_SQL, [n.bidId]);
      const seenAt = nowIso();
      await transaction(db, async () => {
        if (prev) {
          const hasDetails = prev.d_kind !== null && prev.d_kind !== undefined;
          const before = { deadline: prev.deadline, budget: prev.budget, kind: prev.d_kind, openingAt: prev.d_opening_at };
          for (const field of CHANGE_FIELDS) {
            if (!hasDetails && (field === 'kind' || field === 'openingAt')) continue;
            const oldV = changeValue(before[field]);
            const newV = changeValue(n[field]);
            if (oldV !== newV) await db.run(CHANGE_SQL, [n.bidId, seenAt, field, oldV, newV]);
          }
        }
        await db.run(UPSERT_SQL, [
          n.bidId,
          String(sourceId),
          String(n.title ?? ''),
          n.org || null,
          n.deadline || null,
          n.budget,
          n.url || null,
          JSON.stringify(raw),
          ctx.today(),
        ]);
        await db.run(DETAIL_SQL, [
          n.bidId,
          n.kind,
          n.openingAt,
          n.budgetBasis,
          JSON.stringify({ amounts: n.amounts, limits: n.limits, noticeOrg: n.noticeOrg, postedAt: n.postedAt }),
          seenAt,
        ]);
        const links = n.links ?? (n.raw && typeof n.raw === 'object' ? normalizeBid(n.raw, sourceId).links : null);
        if (links && n.kind === 'prestd') {
          for (const no of links.noticeNos || []) await db.run(LINK_SQL, [n.bidId, no, 'prestd', seenAt]);
        } else if (links && links.prestdId && n.noticeNo) {
          await db.run(LINK_SQL, [links.prestdId, String(n.noticeNo), 'notice', seenAt]);
        }
      });
      return this.get(n.bidId);
    },
    /**
     * 사전규격↔본공고 흐름. 본공고 bidId 면 연결된 사전규격 1건, 사전규격(PS…) bidId 면 연결된 본공고들. 예외 없음.
     * @param {string} bidId
     * @returns {Promise<{prestd: object|null, notices: object[]}>} BidFlow
     */
    async linksFor(bidId) {
      const id = String(bidId ?? '');
      try {
        if (!id.startsWith('PS')) {
          const noticeNo = id.split('-')[0];
          const row = noticeNo ? await db.get(PRESTD_OF_NOTICE_SQL, [noticeNo]) : null;
          if (!row) return { prestd: null, notices: [] };
          return { prestd: toLinked(await db.get(GET_SQL, [row.prestd_id]), row.prestd_id, noticeNo), notices: [] };
        }
        const notices = [];
        for (const r of await db.all(NOTICES_OF_PRESTD_SQL, [id])) {
          const stored = await db.get(LATEST_ORD_SQL, [r.notice_no]);
          notices.push(toLinked(stored, `${r.notice_no}-000`, r.notice_no));
        }
        notices.sort((a, b) => {
          if (a.postedAt !== b.postedAt) {
            if (a.postedAt === null) return 1;
            if (b.postedAt === null) return -1;
            return a.postedAt < b.postedAt ? 1 : -1;
          }
          return a.noticeNo < b.noticeNo ? -1 : a.noticeNo > b.noticeNo ? 1 : 0;
        });
        return { prestd: null, notices };
      } catch {
        return { prestd: null, notices: [] };
      }
    },
    /**
     * seen_at >= isoDateTime 인 변경 기록, 최신순
     * @param {string} isoDateTime
     * @returns {Promise<{bidId:string, title:string, field:string, old:string|null, new:string|null, seenAt:string}[]>}
     */
    async changesSince(isoDateTime) {
      const rows = await db.all(
        `SELECT c.bid_id, c.field, c.old, c.new, c.seen_at, b.title
         FROM bid_changes c LEFT JOIN bids b ON b.bid_id = c.bid_id
         WHERE c.seen_at >= $1 ORDER BY c.seen_at DESC, c.id DESC`,
        [String(isoDateTime)],
      );
      return rows.map((r) => ({ bidId: r.bid_id, title: r.title ?? '', field: r.field, old: r.old ?? null, new: r.new ?? null, seenAt: r.seen_at }));
    },
  };

  const matches = {
    /** @returns {Promise<{matched: object[], maybe: object|null}>} */
    async forDate(date) {
      const rows = await db.all(MATCH_ROWS_SQL, [String(date)]);
      const matched = rows.filter((r) => r.kind === 'match').map(toMatched);
      const maybeRow = rows.find((r) => r.kind === 'maybe');
      return { matched, maybe: maybeRow ? toMatched(maybeRow) : null };
    },
    /** @returns {Promise<string|null>} */
    async latestDate() {
      const row = await db.get('SELECT MAX(date) AS d FROM matches');
      return row && row.d ? row.d : null;
    },
    /**
     * 그 날짜의 행을 지우고 다시 넣는다. rank 는 1부터
     * @param {string} date
     * @param {object[]} matched MatchedBid[]
     * @param {object|null} maybe MatchedBid|null
     */
    async save(date, matched, maybe) {
      const d = String(date);
      const ins = 'INSERT INTO matches (date, bid_id, kind, rank, reasons) VALUES ($1, $2, $3, $4, $5)';
      await transaction(db, async () => {
        await db.run('DELETE FROM matches WHERE date = $1', [d]);
        const seen = new Set();
        let i = 0;
        for (const m of matched || []) {
          i += 1;
          if (seen.has(m.bidId)) continue;
          seen.add(m.bidId);
          await db.run(ins, [d, m.bidId, 'match', i, JSON.stringify(m.reasons || [])]);
        }
        if (maybe && !seen.has(maybe.bidId)) {
          await db.run(ins, [d, maybe.bidId, 'maybe', 1, JSON.stringify(maybe.reasons || [])]);
        }
      });
    },
  };

  return { bids, matches };
}
