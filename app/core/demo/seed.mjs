// 예시 회사: 최초 생성(bootstrap)과 매일 초기화(reset). 사용자·회사·멤버십은 서비스 롤(Supabase 관리 API),
// 업무 표는 그 회사 withWorkspace 안에서, 플랫폼 표(demo_workspaces·subscriptions·payments)는 db.admin 으로 쓴다.
// 데모 비밀번호는 APP_SECRET 에서 파생한 값이며 로그·화면·응답에 절대 쓰지 않는다.
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transaction } from '../db.mjs';
import { regionKeys } from '../normalize.mjs';
import {
  DEMO_ASSIGNMENTS,
  DEMO_BIDS,
  DEMO_COMPANY,
  DEMO_CRITERIA,
  DEMO_HISTORY,
  DEMO_INTERESTS,
  DEMO_MATCHES,
  DEMO_SUMMARIES,
  kstDay,
} from './fixture.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DOMAIN = 'demo.example.com';
const TRIAL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
const MEMBER_IDS = { owner: 1, staffA: 2, staffB: 3 };
const OTHER_COMPANY = '다른 업체(예시)';
const HISTORY_DAYS = [7, 30, 90];

/** @param {Record<string, string|undefined>} env */
export function demoEnabled(env) {
  return env?.APP_DEMO === '1';
}

/** @param {Record<string, string|undefined>} env */
export function demoEmails(env) {
  const d = String(env?.APP_DEMO_EMAIL_DOMAIN ?? '').trim() || DEFAULT_DOMAIN;
  return { owner: `demo-owner@${d}`, staffA: `demo-staff-a@${d}`, staffB: `demo-staff-b@${d}` };
}

/** base64url(HMAC-SHA256(secret, 'demo-owner')) */
export function demoPassword(secret) {
  if (typeof secret !== 'string' || secret === '') throw Object.assign(new Error('APP_SECRET is required for the demo'), { code: 'NO_SECRET' });
  return createHmac('sha256', secret).update('demo-owner').digest('base64url');
}

function listTables(sql) {
  return [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]);
}

/** app/core/schema.sql + app/modules/<id>/schema.sql 의 테이블 이름(등장 순) */
function readTenantTables() {
  const files = [path.join(APP_DIR, 'core', 'schema.sql')];
  const modulesDir = path.join(APP_DIR, 'modules');
  if (existsSync(modulesDir)) {
    for (const id of readdirSync(modulesDir).sort()) {
      const file = path.join(modulesDir, id, 'schema.sql');
      if (statSync(path.join(modulesDir, id)).isDirectory() && existsSync(file)) files.push(file);
    }
  }
  return files.flatMap((f) => listTables(readFileSync(f, 'utf8')));
}

function fail(code, message, cause) {
  return Object.assign(new Error(message), { code, cause });
}

function errCode(e) {
  return e?.code ?? e?.error_code ?? e?.status ?? 'UNKNOWN';
}

function toStatus(r) {
  if (!r) return null;
  return {
    workspaceId: String(r.workspace_id),
    seededAt: r.seeded_at ? new Date(r.seeded_at).toISOString() : null,
    resetCount: Number(r.reset_count ?? 0),
  };
}

function historyRow(h, today) {
  const date = kstDay(new Date(`${today}T03:00:00.000Z`), h.dateOffset ?? 0);
  const winner = h.result === 'won' ? DEMO_COMPANY.name : OTHER_COMPANY;
  return {
    bidId: h.bidId ?? `DEMO-H${String(Math.abs(h.dateOffset ?? 0)).padStart(3, '0')}`,
    title: h.title,
    org: h.org,
    noticeOrg: h.org,
    openingAt: `${date} 11:00`,
    participants: null,
    status: '개찰완료',
    top: { name: winner, bizNo: null, amount: h.amount, rate: null },
    award: { name: winner, bizNo: null, amount: h.amount, rate: null, at: date },
    result: h.result,
    date,
  };
}

/**
 * @param {{ db: object, platform: object, env: Record<string, string|undefined>, now?: () => Date, runtimeFor?: (id: string) => Promise<object>, store?: object, consents?: object }} deps
 */
export function createDemo({ db, platform, env = {}, now = () => new Date(), runtimeFor, store, consents } = {}) {
  const enabled = demoEnabled(env);
  /** @type {Map<string, boolean>} */
  const wsCache = new Map();
  let row = null; // 있을 때만 기억한다(다른 인스턴스가 만든 뒤에도 보이게)
  let bootstrapping = null;
  let tables = null;

  const service = () => {
    const s = platform?.serviceClient;
    if (!s?.auth?.admin || typeof s.from !== 'function') throw fail('NO_SERVICE', 'service client is required for the demo');
    return s;
  };

  function invalidate() {
    row = null;
    wsCache.clear();
  }

  async function readRow() {
    if (row) return row;
    const r = await db.admin('SELECT workspace_id, owner_user_id, staff_user_ids, seeded_at, reset_count FROM demo_workspaces ORDER BY seeded_at NULLS LAST LIMIT 1');
    if (r.rows[0]) row = r.rows[0];
    return r.rows[0] ?? null;
  }

  async function findUser(email) {
    const want = email.toLowerCase();
    const perPage = 1000;
    for (let page = 1; page <= 100; page++) {
      const { data, error } = await service().auth.admin.listUsers({ page, perPage });
      if (error) throw fail('DEMO_USER', `demo user lookup failed (${errCode(error)})`);
      const users = data?.users ?? [];
      const hit = users.find((u) => String(u.email ?? '').toLowerCase() === want);
      if (hit) return hit;
      if (users.length < perPage) break;
    }
    return null;
  }

  /** 있으면 그 사용자, 없으면 메일 확인 끝난 사용자로 만든다 */
  async function ensureUser(email, password) {
    const { data, error } = await service().auth.admin.createUser({ email, password, email_confirm: true });
    if (!error && data?.user?.id) return data.user;
    const found = await findUser(email);
    if (!found) throw fail('DEMO_USER', `demo user not created (${errCode(error)})`);
    return found;
  }

  async function ensureMemberships(workspaceId, ids) {
    const at = new Date(now()).toISOString();
    const rows = [
      { workspace_id: workspaceId, user_id: ids.owner, role: 'owner', member_id: MEMBER_IDS.owner, member_name: DEMO_COMPANY.ownerName, created_at: at },
      { workspace_id: workspaceId, user_id: ids.staffA, role: 'staff', member_id: MEMBER_IDS.staffA, member_name: DEMO_COMPANY.staff[0], created_at: at },
      { workspace_id: workspaceId, user_id: ids.staffB, role: 'staff', member_id: MEMBER_IDS.staffB, member_name: DEMO_COMPANY.staff[1], created_at: at },
    ];
    const r = await service().from('memberships').upsert(rows, { onConflict: 'workspace_id,user_id' });
    if (r?.error) throw fail('DEMO_MEMBERS', `demo memberships failed (${errCode(r.error)})`);
  }

  async function recordConsents(ids, emails, { onlyIfNeeded }) {
    if (!consents) return;
    for (const k of ['owner', 'staffA', 'staffB']) {
      if (onlyIfNeeded && !(await consents.needsReconsent(ids[k]))) continue;
      await consents.record({ userId: ids[k], email: emails[k], req: null });
    }
  }

  function idsOf(r) {
    const staff = (r.staff_user_ids ?? []).map(String);
    return { owner: String(r.owner_user_id), staffA: staff[0], staffB: staff[1] };
  }

  async function doBootstrap() {
    const existing = await readRow();
    if (existing) return { workspaceId: String(existing.workspace_id), created: false };
    const emails = demoEmails(env);
    const password = demoPassword(env.APP_SECRET);
    const users = {};
    for (const k of ['owner', 'staffA', 'staffB']) users[k] = String((await ensureUser(emails[k], password)).id);

    const workspaceId = randomUUID();
    const at = new Date(now()).toISOString();
    const ws = await service().from('workspaces').insert({ id: workspaceId, name: DEMO_COMPANY.name, created_by: users.owner, created_at: at });
    if (ws?.error) throw fail('DEMO_WORKSPACE', `demo workspace not created (${errCode(ws.error)})`);
    await db.admin(
      `INSERT INTO demo_workspaces (workspace_id, owner_user_id, staff_user_ids, seeded_at, reset_count)
       VALUES ($1, $2, $3::uuid[], NULL, 0) ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId, users.owner, [users.staffA, users.staffB]],
    );
    await ensureMemberships(workspaceId, users);
    await recordConsents(users, emails, { onlyIfNeeded: false });
    if (store) await store.ensure(workspaceId);
    invalidate();
    return { workspaceId, created: true };
  }

  async function insertFixture(workspaceId, today, nowIso) {
    const w = workspaceId;
    const day = (offset) => kstDay(new Date(`${today}T03:00:00.000Z`), offset);
    const run = (sql, params) => db.run(sql, [w, ...params]);

    await run('INSERT INTO settings (workspace_id, key, value) VALUES ($1, $2, $3)', ['company_name', DEMO_COMPANY.name]);
    await run('INSERT INTO settings (workspace_id, key, value) VALUES ($1, $2, $3)', ['criteria', JSON.stringify(DEMO_CRITERIA)]);
    await run('INSERT INTO company_profile (workspace_id, name, licenses, regions, small_business) VALUES ($1, $2, $3, $4, 1)', [
      DEMO_COMPANY.name,
      JSON.stringify(['조경식재공사업', '조경시설물설치공사업']),
      JSON.stringify(DEMO_CRITERIA.regions),
    ]);

    for (const b of DEMO_BIDS) {
      const posted = day(b.postedOffset ?? 0);
      const deadline = `${day(b.deadlineOffset ?? 0)} 10:00`;
      const limits = { regions: regionKeys(b.region || ''), regionRaw: b.region || null, licenses: [], sme: null };
      const amounts = {
        estimated: b.budgetBasis === 'estimated' ? b.budget : null,
        base: b.budgetBasis === 'base' ? b.budget : null,
        assigned: b.budgetBasis === 'assigned' ? b.budget : null,
        vatIncluded: b.budgetBasis ? b.budgetBasis !== 'estimated' : null,
      };
      const raw = { bidId: b.bidId, title: b.title, org: b.org, noticeOrg: b.org, kind: b.kind, postedAt: posted, deadline, budget: b.budget, budgetBasis: b.budgetBasis, url: b.url, limits, amounts, source: b.source };
      await run(
        'INSERT INTO bids (workspace_id, bid_id, source_id, title, org, deadline, budget, url, raw, first_seen) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
        [b.bidId, b.source, b.title, b.org, deadline, b.budget, b.url, JSON.stringify(raw), posted],
      );
      await run(
        'INSERT INTO bid_details (workspace_id, bid_id, kind, opening_at, budget_basis, norm, last_seen) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [b.bidId, b.kind, `${day((b.deadlineOffset ?? 0) + 1)} 11:00`, b.budgetBasis, JSON.stringify({ amounts, limits, noticeOrg: b.org, postedAt: posted }), nowIso],
      );
    }

    const ins = 'INSERT INTO matches (workspace_id, date, bid_id, kind, rank, reasons) VALUES ($1, $2, $3, $4, $5, $6)';
    let rank = 0;
    for (const m of DEMO_MATCHES.matched) {
      rank += 1;
      await run(ins, [today, m.bidId, 'match', rank, JSON.stringify(m.reasons)]);
    }
    if (DEMO_MATCHES.maybe) await run(ins, [today, DEMO_MATCHES.maybe.bidId, 'maybe', 1, JSON.stringify(DEMO_MATCHES.maybe.reasons)]);

    for (const i of DEMO_INTERESTS) {
      await run('INSERT INTO interest_items (workspace_id, bid_id, member_id, created_at, note) VALUES ($1, $2, $3, $4, $5)', [
        i.bidId,
        MEMBER_IDS.owner,
        nowIso,
        i.note ?? null,
      ]);
    }

    for (const a of DEMO_ASSIGNMENTS) {
      await run(
        'INSERT INTO assign_items (workspace_id, bid_id, assignee_id, status, note, updated_at, updated_by) VALUES ($1, $2, $3, $4, NULL, $5, $6)',
        [a.bidId, MEMBER_IDS[a.assignee] ?? null, a.status, nowIso, MEMBER_IDS.owner],
      );
    }

    for (const s of DEMO_SUMMARIES) {
      await run('INSERT INTO bid_texts (workspace_id, bid_id, status, text, fetched_at) VALUES ($1, $2, $3, $4, $5)', [s.bidId, 'ok', s.text, nowIso]);
      const evidence = s.evidence.map((e) => ({ field: e.field ?? 'what', quote: e.quote, found: true }));
      await run(
        'INSERT INTO summary_items (workspace_id, bid_id, status, what, qualification, documents, evidence, error, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8)',
        [s.bidId, 'ready', s.summary, s.qualification ?? null, s.documents ?? null, JSON.stringify(evidence), nowIso],
      );
    }

    // 지난 개찰: 조건 키워드 × 기간 선택지마다 캐시 한 행 (검색 결과와 같은 모양)
    const rows = DEMO_HISTORY.map((h) => historyRow(h, today)).sort((a, b) => b.date.localeCompare(a.date));
    for (const q of DEMO_CRITERIA.keywords) {
      for (const days of HISTORY_DAYS) {
        const from = day(-days);
        const hit = rows.filter((r) => r.title.includes(q) && r.date >= from);
        await run('INSERT INTO history_results (workspace_id, query_key, fetched_at, rows) VALUES ($1, $2, $3, $4)', [
          `v2|${q}|${days}`,
          nowIso,
          JSON.stringify({ rows: hit, truncated: 0 }),
        ]);
      }
    }

    const todayCount = DEMO_BIDS.filter((b) => (b.postedOffset ?? 0) === 0).length;
    await run('INSERT INTO collect_days (workspace_id, source_id, day, ok, pages, count, truncated, ran_at) VALUES ($1, $2, $3, 1, 1, $4, 0, $5)', [
      'demo',
      today,
      Math.max(todayCount, DEMO_BIDS.length),
      nowIso,
    ]);
    await run(
      `INSERT INTO job_runs (workspace_id, job, date, run_id, status, attempt, started_at, finished_at, error_code)
       VALUES ($1, 'daily', $2, $3, 'done', 1, $4, $4, NULL)`,
      [today, `demo-${today}`, nowIso],
    );
  }

  const api = {
    enabled,

    async isDemoWorkspace(workspaceId) {
      if (!enabled) return false;
      const id = String(workspaceId ?? '');
      if (wsCache.has(id)) return wsCache.get(id);
      const r = await readRow();
      if (!r) return false;
      const hit = String(r.workspace_id) === id;
      wsCache.set(id, hit);
      return hit;
    },

    async isDemoUser(userId) {
      if (!enabled) return false;
      const r = await readRow();
      if (!r) return false;
      const ids = idsOf(r);
      const id = String(userId ?? '');
      return id !== '' && (ids.owner === id || ids.staffA === id || ids.staffB === id);
    },

    async workspaceId() {
      if (!enabled) return null;
      const r = await readRow();
      return r ? String(r.workspace_id) : null;
    },

    bootstrap() {
      if (!enabled) return Promise.reject(fail('DEMO_DISABLED', 'demo is disabled'));
      if (!bootstrapping) {
        bootstrapping = doBootstrap().finally(() => {
          bootstrapping = null;
        });
      }
      return bootstrapping;
    },

    async reset() {
      const { workspaceId } = await api.bootstrap();
      const r = await readRow();
      const ids = idsOf(r);
      const emails = demoEmails(env);
      const password = demoPassword(env.APP_SECRET);
      const at = new Date(now());
      const nowIso = at.toISOString();
      const today = kstDay(at, 0);

      await ensureMemberships(workspaceId, ids);
      await recordConsents(ids, emails, { onlyIfNeeded: true });

      await db.withWorkspace(workspaceId, () =>
        transaction(db, async () => {
          for (const t of api.tenantTables()) await db.run(`DELETE FROM ${t} WHERE workspace_id = $1`, [workspaceId]);
          await insertFixture(workspaceId, today, nowIso);
        }),
      );

      await db.admin('DELETE FROM payments WHERE workspace_id = $1', [workspaceId]);
      await db.admin('DELETE FROM email_unsubscribes WHERE workspace_id = $1', [workspaceId]);
      if (store) {
        await store.ensure(workspaceId);
        await store.update(workspaceId, {
          plan: 'trial',
          status: 'trialing',
          trialEndsAt: new Date(at.getTime() + TRIAL_DAYS * DAY_MS).toISOString(),
          currentPeriodEnd: null,
          nextChargeAt: null,
          cancelAtPeriodEnd: false,
          retryCount: 0,
          cardSummary: null,
          billingSecretId: null,
        });
      }

      for (const k of ['owner', 'staffA', 'staffB']) {
        const { error } = await service().auth.admin.updateUserById(ids[k], { password });
        if (error) throw fail('DEMO_PASSWORD', `demo password not reset (${errCode(error)})`);
      }

      const up = await db.admin('UPDATE demo_workspaces SET seeded_at = $2, reset_count = reset_count + 1 WHERE workspace_id = $1 RETURNING reset_count', [
        workspaceId,
        nowIso,
      ]);
      invalidate();
      if (typeof runtimeFor === 'function') await runtimeFor(workspaceId);
      return { ok: true, workspaceId, bids: DEMO_BIDS.length, resetCount: Number(up.rows[0]?.reset_count ?? 0) };
    },

    async status() {
      if (!enabled) return null;
      return toStatus(await readRow());
    },

    tenantTables() {
      if (!tables) tables = readTenantTables();
      return [...tables];
    },
  };
  return api;
}
