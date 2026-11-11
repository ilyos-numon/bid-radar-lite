// Demo example company: fixture invariants, migration sync, bootstrap/reset on PGlite (real INSERTs against module schemas).
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, WS_B } from './helpers/fake-platform.mjs';
import { createBillingStore } from '../../app/core/billing/store.mjs';
import { createConsents } from '../../app/core/legal/consent.mjs';
import {
  DEMO_ASSIGNMENTS,
  DEMO_BIDS,
  DEMO_COMPANY,
  DEMO_CRITERIA,
  DEMO_HISTORY,
  DEMO_INTERESTS,
  DEMO_MATCHES,
  DEMO_SUMMARIES,
  DEMO_TEXT,
  kstDay,
} from '../../app/core/demo/fixture.mjs';
import { createDemo, demoEmails, demoEnabled, demoPassword } from '../../app/core/demo/seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const DEMO_SCHEMA = read('app/core/demo/schema.sql');
const MIGRATION = read('supabase/migrations/20261105000000_demo.sql');
const ENV = { APP_DEMO: '1', APP_SECRET: 'test-secret-for-demo' };
const NOW = new Date('2026-11-03T01:00:00.000Z'); // 10:00 KST

const dbs = [];
after(async () => {
  for (const d of dbs) await d.close();
});

/** Supabase service client stand-in: auth.admin + from(table).upsert/insert, all in memory */
function fakeService() {
  const users = new Map(); // email -> { id, email, password }
  const calls = { createUser: 0, updateUserById: [], workspaces: [], memberships: [] };
  return {
    calls,
    users,
    client: {
      auth: {
        admin: {
          async createUser({ email, password }) {
            calls.createUser += 1;
            if (users.has(email)) return { data: { user: null }, error: { code: 'email_exists' } };
            const u = { id: randomUUID(), email, password };
            users.set(email, u);
            return { data: { user: u }, error: null };
          },
          async listUsers() {
            return { data: { users: [...users.values()] }, error: null };
          },
          async updateUserById(id, { password }) {
            calls.updateUserById.push({ id, hasPassword: typeof password === 'string' && password.length > 0 });
            return { data: { user: { id } }, error: null };
          },
        },
      },
      from(table) {
        return {
          async insert(row) {
            calls[table]?.push(row);
            return { error: null };
          },
          async upsert(rows) {
            calls[table]?.push(...rows);
            return { error: null };
          },
        };
      },
    },
  };
}

async function setup(env = ENV) {
  const db = await createTestDb();
  dbs.push(db);
  await db.admin(DEMO_SCHEMA);
  const svc = fakeService();
  const store = createBillingStore({ db, now: () => NOW });
  const consents = createConsents({ db, env });
  const demo = createDemo({ db, platform: { serviceClient: svc.client }, env, now: () => NOW, store, consents });
  return { db, svc, demo, store };
}

async function countIn(db, ws, table) {
  return db.withWorkspace(ws, async () => Number((await db.get(`SELECT count(*)::int AS n FROM ${table}`)).n));
}

function checkValues(rel, column) {
  const m = read(rel).match(new RegExp(`${column} text NOT NULL CHECK\\s*\\(${column} IN \\(([^)]*)\\)\\)`));
  assert.ok(m, `CHECK for ${column} in ${rel}`);
  return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
}

describe('demo config helpers', () => {
  test('demoEnabled only for APP_DEMO=1', () => {
    assert.equal(demoEnabled({ APP_DEMO: '1' }), true);
    assert.equal(demoEnabled({ APP_DEMO: '0' }), false);
    assert.equal(demoEnabled({}), false);
    assert.equal(demoEnabled(undefined), false);
  });

  test('demoEmails uses default and custom domain', () => {
    assert.deepEqual(demoEmails({}), {
      owner: 'demo-owner@demo.example.com',
      staffA: 'demo-staff-a@demo.example.com',
      staffB: 'demo-staff-b@demo.example.com',
    });
    assert.equal(demoEmails({ APP_DEMO_EMAIL_DOMAIN: 'x.test' }).staffB, 'demo-staff-b@x.test');
  });

  test('demoPassword is deterministic base64url HMAC and needs a secret', () => {
    const a = demoPassword('s1');
    assert.equal(a, demoPassword('s1'));
    assert.notEqual(a, demoPassword('s2'));
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.throws(() => demoPassword(''), /APP_SECRET/);
    assert.throws(() => demoPassword(undefined), /APP_SECRET/);
  });
});

describe('demo fixture', () => {
  const ids = new Set(DEMO_BIDS.map((b) => b.bidId));
  const today = kstDay(new Date(), 0);

  test('bids: ≥12, DEMO ids, example org/url, demo source, 2 past deadlines, posted within 5 days', () => {
    assert.ok(DEMO_BIDS.length >= 12);
    assert.equal(ids.size, DEMO_BIDS.length);
    for (const b of DEMO_BIDS) {
      assert.match(b.bidId, /^DEMO-\d{3}$/);
      assert.ok(b.org.endsWith('(예시)'), b.org);
      assert.equal(b.url, `https://example.com/demo/${b.bidId}`);
      assert.equal(b.source, 'demo');
      assert.match(b.postedAt, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(b.postedAt <= today && b.postedAt >= kstDay(new Date(), -5), b.postedAt);
    }
    assert.equal(DEMO_BIDS.filter((b) => b.deadline.slice(0, 10) < today).length, 2);
  });

  test('matches, interests, assignments refer to fixture bids and module values', () => {
    assert.ok(DEMO_MATCHES.matched.length >= 5);
    for (const m of [...DEMO_MATCHES.matched, DEMO_MATCHES.maybe]) {
      assert.ok(ids.has(m.bidId), m.bidId);
      assert.ok(m.reasons.length > 0);
    }
    assert.ok(DEMO_INTERESTS.length >= 3);
    assert.ok(DEMO_INTERESTS.every((i) => ids.has(i.bidId)));
    const dTwo = DEMO_INTERESTS.map((i) => DEMO_BIDS.find((b) => b.bidId === i.bidId)).filter((b) => b.deadlineOffset === 2);
    assert.ok(dTwo.length >= 1, 'one interest due in 2 days');
    const statuses = checkValues('app/modules/assign/schema.sql', 'status');
    assert.ok(DEMO_ASSIGNMENTS.length >= 4);
    for (const a of DEMO_ASSIGNMENTS) {
      assert.ok(ids.has(a.bidId));
      assert.ok(['owner', 'staffA', 'staffB'].includes(a.assignee));
      assert.ok(statuses.includes(a.status), a.status);
    }
  });

  test('history ≥6 with 3 won; summaries quote their own text; no real-looking people', () => {
    assert.ok(DEMO_HISTORY.length >= 6);
    assert.equal(DEMO_HISTORY.filter((h) => h.result === 'won').length, 3);
    for (const h of DEMO_HISTORY) {
      assert.ok(h.org.endsWith('(예시)'));
      assert.ok(Number.isFinite(h.amount));
      assert.match(h.date, /^\d{4}-\d{2}-\d{2}$/);
    }
    assert.equal(DEMO_SUMMARIES.length, 2);
    for (const s of DEMO_SUMMARIES) {
      assert.ok(ids.has(s.bidId));
      for (const e of s.evidence) assert.ok(s.text.includes(e.quote), e.quote);
    }
    assert.ok(DEMO_COMPANY.name.endsWith('(예시)'));
    assert.ok([DEMO_COMPANY.ownerName, ...DEMO_COMPANY.staff].every((n) => n.startsWith('예시 ')));
    assert.deepEqual(DEMO_CRITERIA.regions, ['경기']);
    assert.equal(DEMO_TEXT.chip, '예시 데이터');
  });
});

describe('demo migration', () => {
  test('migration embeds schema.sql verbatim, FK to workspaces, revoke/grant like platform tables', () => {
    const body = DEMO_SCHEMA.slice(DEMO_SCHEMA.indexOf('CREATE TABLE'));
    assert.ok(MIGRATION.includes(body.trim()), 'schema.sql body drifted from migration');
    assert.equal(MIGRATION.match(/CREATE TABLE IF NOT EXISTS demo_workspaces/g).length, 1);
    assert.match(MIGRATION, /references public\.workspaces\(id\) on delete cascade/);
    assert.match(MIGRATION, /revoke all on public\.demo_workspaces from public, anon, authenticated/);
    assert.match(MIGRATION, /grant select, insert, update, delete on public\.demo_workspaces to app_worker/);
  });
});

describe('createDemo', () => {
  test('tenantTables parses core + module schema files', async () => {
    const { demo } = await setup();
    const files = ['app/core/schema.sql'];
    for (const id of readdirSync(path.join(ROOT, 'app/modules')).sort()) {
      if (existsSync(path.join(ROOT, 'app/modules', id, 'schema.sql'))) files.push(`app/modules/${id}/schema.sql`);
    }
    const expected = files.flatMap((f) => [...read(f).matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1]));
    assert.deepEqual(demo.tenantTables(), expected);
    for (const t of ['bids', 'matches', 'assign_items', 'interest_items', 'summary_items', 'history_results']) assert.ok(expected.includes(t), t);
  });

  test('disabled demo does nothing', async () => {
    const { demo, svc } = await setup({ APP_SECRET: 'x' });
    assert.equal(demo.enabled, false);
    assert.equal(await demo.isDemoWorkspace(WS_B), false);
    assert.equal(await demo.isDemoUser('anyone'), false);
    assert.equal(await demo.workspaceId(), null);
    assert.equal(await demo.status(), null);
    await assert.rejects(demo.bootstrap(), { code: 'DEMO_DISABLED' });
    assert.equal(svc.calls.createUser, 0);
  });

  test('bootstrap creates once: 3 users, workspace, memberships, consents, demo row, trial', async () => {
    const { db, svc, demo, store } = await setup();
    assert.equal(await demo.workspaceId(), null);
    const first = await demo.bootstrap();
    assert.equal(first.created, true);
    const again = await demo.bootstrap();
    assert.deepEqual(again, { workspaceId: first.workspaceId, created: false });
    assert.equal(svc.users.size, 3);
    assert.equal(svc.calls.workspaces.length, 1);
    assert.equal(svc.calls.workspaces[0].name, DEMO_COMPANY.name);
    assert.deepEqual(svc.calls.memberships.map((m) => m.role), ['owner', 'staff', 'staff']);
    const consents = await db.admin('SELECT count(*)::int AS n FROM consents');
    assert.equal(consents.rows[0].n, 6);
    assert.equal((await store.get(first.workspaceId)).status, 'trialing');
    assert.equal(await demo.workspaceId(), first.workspaceId);
    const st = await demo.status();
    assert.deepEqual(st, { workspaceId: first.workspaceId, seededAt: null, resetCount: 0 });
  });

  test('reset seeds every module table through real INSERTs (CHECK constraints hold)', async () => {
    const { db, svc, demo, store } = await setup();
    const r = await demo.reset();
    assert.equal(r.ok, true);
    assert.equal(r.bids, DEMO_BIDS.length);
    assert.equal(r.resetCount, 1);
    const ws = r.workspaceId;
    assert.equal(await countIn(db, ws, 'bids'), DEMO_BIDS.length);
    assert.equal(await countIn(db, ws, 'bid_details'), DEMO_BIDS.length);
    assert.equal(await countIn(db, ws, 'matches'), DEMO_MATCHES.matched.length + 1);
    assert.equal(await countIn(db, ws, 'interest_items'), DEMO_INTERESTS.length);
    assert.equal(await countIn(db, ws, 'assign_items'), DEMO_ASSIGNMENTS.length);
    assert.equal(await countIn(db, ws, 'summary_items'), DEMO_SUMMARIES.length);
    assert.equal(await countIn(db, ws, 'bid_texts'), DEMO_SUMMARIES.length);
    assert.ok((await countIn(db, ws, 'history_results')) >= 1);
    const today = kstDay(NOW, 0);
    const job = await db.withWorkspace(ws, () => db.get("SELECT status FROM job_runs WHERE job = 'daily' AND date = $1", [today]));
    assert.equal(job.status, 'done');
    const m = await db.withWorkspace(ws, () => db.all('SELECT DISTINCT date FROM matches'));
    assert.deepEqual(m.map((x) => String(x.date).slice(0, 10)), [today]);
    const sources = await db.withWorkspace(ws, () => db.all('SELECT DISTINCT source_id FROM bids'));
    assert.deepEqual(sources.map((x) => x.source_id), ['demo']);
    const sub = await store.get(ws);
    assert.equal(sub.status, 'trialing');
    assert.equal(sub.plan, 'trial');
    assert.equal(new Date(sub.trialEndsAt).getTime(), NOW.getTime() + 14 * 86400000);
    assert.equal(svc.calls.updateUserById.length, 3);
    assert.ok(svc.calls.updateUserById.every((c) => c.hasPassword));
    const st = await demo.status();
    assert.equal(st.seededAt, NOW.toISOString());
    assert.equal(st.resetCount, 1);
  });

  test('reset is idempotent, wipes edits, leaves other workspaces alone', async () => {
    const { db, demo } = await setup();
    const { workspaceId: ws } = await demo.reset();
    await db.withWorkspace(ws, () => db.run("INSERT INTO settings (workspace_id, key, value) VALUES ($1, 'user_edit', 'x')", [ws]));
    await db.withWorkspace(ws, () => db.run('DELETE FROM interest_items WHERE workspace_id = $1', [ws]));
    await db.withWorkspace(WS_B, () =>
      db.run("INSERT INTO settings (workspace_id, key, value) VALUES ($1, 'company_name', '다른 회사')", [WS_B]),
    );
    const r2 = await demo.reset();
    assert.equal(r2.workspaceId, ws);
    assert.equal(r2.resetCount, 2);
    assert.equal(await countIn(db, ws, 'bids'), DEMO_BIDS.length);
    assert.equal(await countIn(db, ws, 'interest_items'), DEMO_INTERESTS.length);
    const edit = await db.withWorkspace(ws, () => db.get("SELECT 1 FROM settings WHERE key = 'user_edit'"));
    assert.equal(edit, null);
    assert.equal(await countIn(db, WS_B, 'settings'), 1);
  });

  test('isDemoWorkspace / isDemoUser recognise only the demo company and its 3 users', async () => {
    const { demo, svc } = await setup();
    const { workspaceId } = await demo.reset();
    assert.equal(await demo.isDemoWorkspace(workspaceId), true);
    assert.equal(await demo.isDemoWorkspace(WS_B), false);
    for (const u of svc.users.values()) assert.equal(await demo.isDemoUser(u.id), true);
    assert.equal(await demo.isDemoUser(randomUUID()), false);
    assert.equal(await demo.isDemoUser(''), false);
  });
});
