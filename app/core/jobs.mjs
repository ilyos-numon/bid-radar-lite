// 일일 잡: 수집(누락일 백필) → 조건 매칭 → 모듈 훅 → 알림 payload
import { matchBids } from '../../src/match.js';
import { normalizeBid } from './normalize.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const ALL_ITEMS = Number.MAX_SAFE_INTEGER;
const DEFAULT_BACKFILL_MAX_DAYS = 7;

/** date 의 전날 00:00 (Asia/Seoul) */
function sinceOf(date) {
  return new Date(new Date(`${date}T00:00:00+09:00`).getTime() - DAY_MS);
}

/** 'YYYY-MM-DD' + n일 */
function addDays(date, n) {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 수집할 날짜 목록 (오래된 것부터). 날짜 d 의 창 = d 전날 00:00 ~ d 00:00 (KST).
 * 마지막 성공일 다음 날부터 date 까지, 최대 maxDays 개 (가장 최근 쪽을 남긴다). 기록이 없으면 date 하나.
 */
export function backfillDays(lastOk, date, maxDays) {
  if (!lastOk || lastOk >= date) return [date];
  const days = [];
  for (let d = addDays(lastOk, 1); d <= date; d = addDays(d, 1)) days.push(d);
  return days.slice(-Math.max(1, maxDays));
}

const bidIdOf = (b) => normalizeBid(b, b && b.source).bidId;

const errText = (err) => (err && err.message ? err.message : String(err));

/** @param {object} ctx */
export function create(ctx) {
  const appUrl = () => {
    const env = ctx.env || {};
    return env.APP_BASE_URL ? String(env.APP_BASE_URL) : `http://localhost:${env.APP_PORT || 8820}`;
  };
  const hooks = () => ctx.hooks || {};
  const backfillMax = () => {
    const n = Number.parseInt(String((ctx.env || {}).NARA_BACKFILL_MAX_DAYS ?? ''), 10);
    return Number.isFinite(n) && n >= 1 ? n : DEFAULT_BACKFILL_MAX_DAYS;
  };
  const lastOkDay = async () => {
    const row = await ctx.db.get('SELECT MAX(day) AS d FROM collect_days WHERE ok = 1');
    return row && row.d ? String(row.d) : null;
  };
  const recordDay = async (x, day) => {
    await ctx.db.run(
      `INSERT INTO collect_days (source_id, day, ok, pages, count, truncated, ran_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (workspace_id, source_id, day) DO UPDATE SET
         ok = excluded.ok, pages = excluded.pages, count = excluded.count, truncated = excluded.truncated, ran_at = excluded.ran_at`,
      [String(x.sourceId), day, x.ok ? 1 : 0, Number(x.pages) || 0, Number(x.count) || 0, x.truncated ? 1 : 0, ctx.now().toISOString()],
    );
  };
  const wasMatched = async (bidId) => Boolean(await ctx.db.get('SELECT 1 FROM matches WHERE bid_id = $1 LIMIT 1', [String(bidId)]));

  async function runNamed(name, { date, dry }) {
    const d = date || ctx.today();
    const list = (hooks().jobs && hooks().jobs[name]) || [];
    for (const { id, fn } of list) {
      let n;
      try {
        n = await fn(ctx, { date: d, dry: Boolean(dry) });
      } catch (err) {
        ctx.log(id, `jobs.${name} failed: ${errText(err)}`);
        continue;
      }
      if (n === null || n === undefined || n.count === 0) continue;
      const payload = { ...n, date: n.date || d, appUrl: n.appUrl || appUrl() };
      if (typeof payload.text !== 'string' || payload.text === '') payload.text = ctx.notify.render(payload);
      if (!dry) await ctx.notify.record(payload.kind, payload.date, payload);
      return payload;
    }
    return null;
  }

  const jobs = {
    /** @param {{date?:string, dry?:boolean}} opts @returns {Promise<object>} NotificationV2 */
    async runDaily({ date, dry } = {}) {
      const d = date || ctx.today();
      const isDry = Boolean(dry);
      const h = hooks();

      // ① 수집 (upsert·source_runs 는 sources 가 이미 끝낸다). 마지막 성공일 이후 빠진 날을 창 단위로 다시 가져온다
      const runStart = ctx.now().toISOString();
      const byId = new Map();
      const warnings = [];
      const warn = (w) => {
        if (w && !warnings.includes(w)) warnings.push(w);
      };
      let anyOk = false;
      let anyResult = false;
      for (const day of backfillDays(await lastOkDay(), d, backfillMax())) {
        const since = sinceOf(day);
        try {
          const r = await ctx.sources.fetchAll(since, new Date(since.getTime() + DAY_MS));
          for (const b of Array.isArray(r.bids) ? r.bids : []) byId.set(bidIdOf(b), b);
          for (const x of Array.isArray(r.results) ? r.results : []) {
            anyResult = true;
            if (x.ok) anyOk = true;
            if (x.error) warn(x.error);
            if (!isDry) await recordDay(x, day);
          }
        } catch (err) {
          ctx.log('core', `daily fetch failed: ${errText(err)}`);
          anyResult = true;
        }
      }
      const all = [...byId.values()];
      const allFailed = anyResult && !anyOk;

      // ② 전체 매칭 → 앞 maxItems 개가 matched, 조건에 안 맞은 것만 unmatched
      const criteria = await ctx.criteria.effective();
      const full = matchBids(all, { ...criteria, maxItems: ALL_ITEMS });
      const matched = full.slice(0, criteria.maxItems);
      const fullIds = new Set(full.map((m) => m.bidId));
      const unmatched = all.filter((b) => !fullIds.has(bidIdOf(b)));

      // ③ 관련 가능성 1건
      let maybe = null;
      if (h.pickMaybe && typeof h.pickMaybe.fn === 'function') {
        try {
          maybe = (await h.pickMaybe.fn(ctx, { date: d, unmatched, criteria })) || null;
        } catch (err) {
          ctx.log(h.pickMaybe.id, `pickMaybe failed: ${errText(err)}`);
          maybe = null;
        }
      }

      // ④ 그날 매칭 저장 (전부 실패한 날은 이전 결과를 지우지 않는다)
      if (!isDry && !allFailed) await ctx.matches.save(d, matched, maybe);

      // ⑤ afterMatch (모듈 id 순)
      const after = [...(h.afterMatch || [])].sort((a, b) => a.id.localeCompare(b.id));
      for (const { id, fn } of after) {
        try {
          await fn(ctx, { date: d, matched, maybe, candidates: all, dry: isDry });
        } catch (err) {
          ctx.log(id, `afterMatch failed: ${errText(err)}`);
        }
      }

      // ⑥ 항목별 추가 줄
      const sourceOf = new Map(all.map((b) => [bidIdOf(b), b.source]));
      const items = [];
      for (const m of matched) {
        const extras = [];
        for (const { id, fn } of h.notifyLines || []) {
          try {
            const lines = await fn(ctx, m.bidId, d);
            if (Array.isArray(lines)) extras.push(...lines.filter((x) => typeof x === 'string' && x !== ''));
          } catch (err) {
            ctx.log(id, `notifyLines failed for ${m.bidId}: ${errText(err)}`);
          }
        }
        const item = { ...m, extras };
        const src = sourceOf.get(m.bidId);
        if (src) item.source = src;
        items.push(item);
      }

      // ⑦ payload — 변경은 이번 실행에서 기록된 것 중 추천했던(또는 지금 추천하는) 공고만
      const shownIds = new Set(matched.map((m) => m.bidId));
      if (maybe && maybe.bidId) shownIds.add(maybe.bidId);
      const changes = [];
      for (const c of typeof ctx.bids.changesSince === 'function' ? await ctx.bids.changesSince(runStart) : []) {
        if (!shownIds.has(c.bidId) && !(await wasMatched(c.bidId))) continue;
        changes.push({ bidId: c.bidId, title: c.title, field: c.field, old: c.old, new: c.new });
      }
      const payload = {
        kind: 'bids',
        date: d,
        count: items.length,
        text: '',
        appUrl: appUrl(),
        items,
        maybe,
        warnings,
        changes,
      };
      payload.text = ctx.notify.render(payload);

      // ⑧ 기록
      if (!isDry) await ctx.notify.record('bids', d, payload);
      return payload;
    },
    runReminders(opts = {}) {
      return runNamed('reminders', opts);
    },
    runSupport(opts = {}) {
      return runNamed('support', opts);
    },
  };
  return { jobs };
}
