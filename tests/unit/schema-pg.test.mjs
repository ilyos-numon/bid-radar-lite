import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA_FILES = [
  'app/core/schema.sql',
  ...['assign', 'company', 'history', 'interest', 'keywords', 'summary', 'support']
    .map((m) => `app/modules/${m}/schema.sql`),
];
const EXPECTED_TABLES = [
  // core (12 + 2 신규)
  'settings', 'members', 'sources', 'source_runs', 'bids', 'bid_texts', 'matches',
  'notifications', 'bid_details', 'bid_changes', 'collect_days', 'bid_links',
  'job_runs', 'notification_deliveries',
  // modules (11)
  'assign_items', 'company_profile', 'company_verdicts', 'history_results',
  'interest_items', 'interest_checks', 'interest_reminders', 'keywords_synonyms',
  'summary_items', 'support_items', 'support_runs',
].sort();

const WS_A = '00000000-0000-0000-0000-00000000000a';
const WS_B = '00000000-0000-0000-0000-00000000000b';

describe('schema.sql — Postgres 방언 (PGlite)', () => {
  let db;
  before(async () => {
    db = new PGlite();
    for (const f of SCHEMA_FILES) await db.exec(readFileSync(path.join(ROOT, f), 'utf8'));
  });
  after(async () => { await db?.close(); });

  test('8개 파일을 두 번 적용해도 오류가 없다 (IF NOT EXISTS)', async () => {
    for (const f of SCHEMA_FILES) await db.exec(readFileSync(path.join(ROOT, f), 'utf8'));
  });

  test('금지 구문이 없다', () => {
    for (const f of SCHEMA_FILES) {
      const sql = readFileSync(path.join(ROOT, f), 'utf8').replace(/--.*$/gm, '');
      for (const bad of [/\bALTER\s+TABLE\b/i, /\bAUTOINCREMENT\b/i, /\bWITHOUT\s+ROWID\b/i, /\bCREATE\s+TRIGGER\b/i]) {
        assert.doesNotMatch(sql, bad, `${f}: ${bad}`);
      }
    }
  });

  test('25 테이블이 만들어진다', async () => {
    const { rows } = await db.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
    assert.deepEqual(rows.map((r) => r.table_name).sort(), EXPECTED_TABLES);
  });

  test('모든 테이블의 첫 열은 workspace_id uuid NOT NULL', async () => {
    const { rows } = await db.query(
      `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND ordinal_position = 1`);
    assert.equal(rows.length, 25);
    for (const r of rows) {
      assert.equal(r.column_name, 'workspace_id', r.table_name);
      assert.equal(r.data_type, 'uuid', r.table_name);
      assert.equal(r.is_nullable, 'NO', r.table_name);
      assert.match(r.column_default ?? '', /current_setting\('app\.workspace_id'/, r.table_name);
    }
  });

  test('25 테이블 모두 PK 첫 열이 workspace_id', async () => {
    const { rows } = await db.query(
      `SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
          AND kcu.ordinal_position = 1`);
    assert.deepEqual(rows.map((r) => r.table_name).sort(), EXPECTED_TABLES);
    for (const r of rows) assert.equal(r.column_name, 'workspace_id', r.table_name);
  });

  test('UNIQUE 제약도 workspace_id 로 시작한다', async () => {
    const { rows } = await db.query(
      `SELECT tc.table_name, tc.constraint_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = 'public' AND tc.constraint_type = 'UNIQUE'
          AND kcu.ordinal_position = 1`);
    const tables = rows.map((r) => r.table_name).sort();
    assert.deepEqual(tables, ['members', 'notification_deliveries']);
    for (const r of rows) assert.equal(r.column_name, 'workspace_id', r.constraint_name);
  });

  test('보조 인덱스는 workspace_id 로 시작한다', async () => {
    const { rows } = await db.query(
      `SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN ('bid_changes_seen', 'bid_links_notice')`);
    assert.equal(rows.length, 2);
    for (const r of rows) assert.match(r.indexdef, /\(workspace_id, /, r.indexname);
  });

  test('금액 열 bids.budget 은 bigint', async () => {
    const { rows } = await db.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name = 'bids' AND column_name = 'budget'`);
    assert.equal(rows[0].data_type, 'bigint');
  });

  test('workspace_id 기본값은 세션 설정을 따르고, 같은 키가 회사별로 공존한다', async () => {
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_A]);
      await tx.query(`INSERT INTO settings (key, value) VALUES ('k', 'a')`);
      await tx.query(`INSERT INTO company_profile (name) VALUES ('A사')`);
      const m = await tx.query(
        `INSERT INTO members (name, role, token_hash, created_at)
         VALUES ('대표', 'owner', 'h1', 'now') RETURNING id, workspace_id`);
      assert.equal(m.rows[0].workspace_id, WS_A);
      assert.equal(typeof m.rows[0].id, 'number');
    });
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.workspace_id', $1, true)`, [WS_B]);
      await tx.query(`INSERT INTO settings (key, value) VALUES ('k', 'b')`);
      await tx.query(`INSERT INTO company_profile (name) VALUES ('B사')`);
      await tx.query(
        `INSERT INTO members (name, role, token_hash, created_at) VALUES ('대표', 'owner', 'h1', 'now')`);
    });
    const { rows } = await db.query(`SELECT workspace_id, value FROM settings WHERE key = 'k' ORDER BY value`);
    assert.deepEqual(rows, [{ workspace_id: WS_A, value: 'a' }, { workspace_id: WS_B, value: 'b' }]);
    await assert.rejects(
      db.query(`INSERT INTO company_profile (workspace_id, name) VALUES ($1, 'dup')`, [WS_A]),
      /duplicate key/);
    await assert.rejects(
      db.query(`INSERT INTO members (workspace_id, name, role, token_hash, created_at)
                VALUES ($1, 'x', 'staff', 'h1', 'now')`, [WS_A]),
      /duplicate key/);
  });

  test('company_profile 은 ON CONFLICT (workspace_id) 로 갱신된다', async () => {
    await db.query(
      `INSERT INTO company_profile (workspace_id, name) VALUES ($1, 'A사2')
       ON CONFLICT (workspace_id) DO UPDATE SET name = excluded.name`, [WS_A]);
    const { rows } = await db.query(`SELECT name FROM company_profile WHERE workspace_id = $1`, [WS_A]);
    assert.deepEqual(rows, [{ name: 'A사2' }]);
  });

  test('CHECK 제약이 유지된다', async () => {
    await assert.rejects(
      db.query(`INSERT INTO members (workspace_id, name, role, token_hash, created_at)
                VALUES ($1, 'x', 'boss', 'h9', 'now')`, [WS_A]),
      /check constraint/);
    await assert.rejects(
      db.query(`INSERT INTO job_runs (workspace_id, job, date, run_id, status)
                VALUES ($1, 'weekly', '2026-11-02', 'r', 'queued')`, [WS_A]),
      /check constraint/);
  });

  test('notification_deliveries 는 (workspace_id, kind, date) 가 유일하다', async () => {
    const ins = `INSERT INTO notification_deliveries (workspace_id, kind, date, run_id, status, created_at)
                 VALUES ($1, 'daily', '2026-11-02', 'r1', 'sending', 'now')`;
    await db.query(ins, [WS_A]);
    await db.query(ins, [WS_B]);
    await assert.rejects(db.query(ins, [WS_A]), /duplicate key/);
  });
});
