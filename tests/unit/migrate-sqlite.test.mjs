import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { run, TABLES } from '../../scripts/migrate-sqlite.mjs';
import { openDb } from '../../app/core/db.mjs';

const MODULES_DIR = fileURLToPath(new URL('../../app/modules/', import.meta.url));
const WS = '11111111-2222-4333-8444-555555555555';
const WS2 = '66666666-7777-4888-8999-aaaaaaaaaaaa';

// 옛 SQLite 스키마 (1f92328 시점의 코어 + 모듈 schema.sql 요지)
const LEGACY_DDL = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','staff')), token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, config TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE source_runs (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, ran_at TEXT NOT NULL, ok INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE bids (bid_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, title TEXT NOT NULL, org TEXT, deadline TEXT, budget INTEGER, url TEXT, raw TEXT NOT NULL, first_seen TEXT NOT NULL);
CREATE TABLE bid_texts (bid_id TEXT PRIMARY KEY, status TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', fetched_at TEXT NOT NULL);
CREATE TABLE matches (date TEXT NOT NULL, bid_id TEXT NOT NULL, kind TEXT NOT NULL, rank INTEGER NOT NULL, reasons TEXT NOT NULL, PRIMARY KEY (date, bid_id));
CREATE TABLE notifications (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE bid_details (bid_id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'new', opening_at TEXT, budget_basis TEXT, norm TEXT NOT NULL DEFAULT '{}', last_seen TEXT NOT NULL);
CREATE TABLE bid_changes (id INTEGER PRIMARY KEY, bid_id TEXT NOT NULL, seen_at TEXT NOT NULL, field TEXT NOT NULL, old TEXT, new TEXT);
CREATE TABLE collect_days (source_id TEXT NOT NULL, day TEXT NOT NULL, ok INTEGER NOT NULL, pages INTEGER NOT NULL DEFAULT 0, count INTEGER NOT NULL DEFAULT 0, truncated INTEGER NOT NULL DEFAULT 0, ran_at TEXT NOT NULL, PRIMARY KEY (source_id, day));
CREATE TABLE bid_links (prestd_id TEXT NOT NULL, notice_no TEXT NOT NULL, origin TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (prestd_id, notice_no));
CREATE TABLE assign_items (bid_id TEXT PRIMARY KEY, assignee_id INTEGER, status TEXT NOT NULL, note TEXT, updated_at TEXT NOT NULL, updated_by INTEGER);
CREATE TABLE company_profile (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL DEFAULT '', licenses TEXT NOT NULL DEFAULT '[]', regions TEXT NOT NULL DEFAULT '[]', small_business INTEGER NOT NULL DEFAULT 0);
CREATE TABLE company_verdicts (bid_id TEXT PRIMARY KEY, verdict TEXT NOT NULL, reasons TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL);
CREATE TABLE history_results (query_key TEXT, fetched_at TEXT, rows TEXT NOT NULL, PRIMARY KEY (query_key));
CREATE TABLE interest_items (bid_id TEXT PRIMARY KEY, member_id INTEGER, created_at TEXT NOT NULL, note TEXT);
CREATE TABLE interest_checks (bid_id TEXT NOT NULL, item INTEGER NOT NULL, checked INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (bid_id, item));
CREATE TABLE interest_reminders (bid_id TEXT NOT NULL, day INTEGER NOT NULL, sent_date TEXT NOT NULL, PRIMARY KEY (bid_id, day));
CREATE TABLE keywords_synonyms (word TEXT PRIMARY KEY, for_keyword TEXT, why TEXT, status TEXT NOT NULL, created_at TEXT);
CREATE TABLE summary_items (bid_id TEXT PRIMARY KEY, status TEXT NOT NULL, what TEXT, qualification TEXT, documents TEXT, evidence TEXT, error TEXT, updated_at TEXT NOT NULL);
CREATE TABLE support_items (id TEXT PRIMARY KEY, title TEXT NOT NULL, org TEXT NOT NULL DEFAULT '', apply_end TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', region TEXT NOT NULL DEFAULT '', first_seen TEXT NOT NULL, matched_reasons TEXT NOT NULL DEFAULT '[]');
CREATE TABLE support_runs (id INTEGER PRIMARY KEY, ran_at TEXT NOT NULL, ok INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, error TEXT);
`;

const T = '2026-11-01T00:00:00.000Z';
const SEED = `
INSERT INTO settings VALUES ('company_name', '테스트 상사'), ('keywords', '["CCTV"]');
INSERT INTO members VALUES (1, '대표', 'owner', 'h1', '${T}'), (2, '직원', 'staff', 'h2', '${T}');
INSERT INTO sources VALUES ('nara', 'nara', '나라장터', 1, '{}', '${T}');
INSERT INTO source_runs VALUES (5, 'nara', '${T}', 1, 3, NULL), (9, 'nara', '${T}', 0, 0, 'timeout');
INSERT INTO bids VALUES ('B1', 'nara', '공고1', '기관', '2026-11-10', 12000000000, 'https://example.com/1', '{}', '${T}'), ('B2', 'nara', '공고2', NULL, NULL, NULL, NULL, '{}', '${T}');
INSERT INTO bid_details VALUES ('B1', 'new', NULL, NULL, '{}', '${T}');
INSERT INTO bid_changes VALUES (3, 'B1', '${T}', 'deadline', 'a', 'b');
INSERT INTO bid_texts VALUES ('B1', 'ok', '본문', '${T}');
INSERT INTO bid_links VALUES ('PS1-000', 'N1', 'prestd', '${T}');
INSERT INTO matches VALUES ('2026-11-01', 'B1', 'match', 1, '[]');
INSERT INTO notifications VALUES (7, 'daily', '2026-11-01', '{}', '${T}');
INSERT INTO collect_days VALUES ('nara', '2026-11-01', 1, 2, 3, 0, '${T}');
INSERT INTO interest_items VALUES ('B1', 2, '${T}', NULL);
INSERT INTO interest_checks VALUES ('B1', 0, 1);
INSERT INTO interest_reminders VALUES ('B1', 3, '2026-11-01');
INSERT INTO assign_items VALUES ('B1', 2, 'go', '메모', '${T}', 1);
INSERT INTO company_profile VALUES (1, '테스트 상사', '["전기"]', '["서울"]', 1);
INSERT INTO company_verdicts VALUES ('B1', 'ok', '[]', '${T}');
INSERT INTO summary_items VALUES ('B1', 'ready', '무엇', NULL, NULL, NULL, NULL, '${T}');
INSERT INTO keywords_synonyms VALUES ('감시', 'CCTV', '유사', 'accepted', '${T}');
INSERT INTO support_items VALUES ('S1', '지원1', '', '', '', '', '', '${T}', '[]');
INSERT INTO support_runs VALUES (4, '${T}', 1, 1, NULL);
INSERT INTO history_results VALUES ('q1', '${T}', '[]');
`;

function makeLegacy(file) {
  const db = new DatabaseSync(file);
  db.exec(LEGACY_DDL);
  db.exec(SEED);
  db.close();
}

function capture() {
  let o = '';
  let e = '';
  return {
    stdout: { write: (s) => (o += s) },
    stderr: { write: (s) => (e += s) },
    out: () => o,
    err: () => e,
  };
}

function counts(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    const r = /^(\w+) read=(\d+) inserted=(\d+) skipped=(\d+)$/.exec(line);
    if (r) m.set(r[1], { read: +r[2], inserted: +r[3], skipped: +r[4] });
  }
  return m;
}

async function applyModules(db) {
  for (const n of readdirSync(MODULES_DIR).sort()) {
    const f = path.join(MODULES_DIR, n, 'schema.sql');
    if (existsSync(f)) await db.applySchema(f);
  }
}

let dir;
let legacy;
before(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'br-migrate-'));
  legacy = path.join(dir, 'legacy.sqlite');
  makeLegacy(legacy);
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('migrate-sqlite --to-dir (PGlite)', () => {
  it('copies every table in order, then a second run inserts nothing', async () => {
    const to = path.join(dir, 'pg-a');
    const c = capture();
    const code = await run(['--from', legacy, '--workspace', WS, '--to-dir', to], c);
    assert.equal(code, 0, c.err());
    const lines = c.out().trim().split('\n');
    assert.equal(lines.at(-1), 'MIGRATE_OK 1 files');
    const tables = lines.map((l) => l.split(' ')[0]).filter((t) => TABLES.includes(t));
    assert.deepEqual(tables, TABLES, 'table order (members included for --to-dir)');
    const first = counts(c.out());
    assert.deepEqual(first.get('members'), { read: 2, inserted: 2, skipped: 0 });
    assert.deepEqual(first.get('bids'), { read: 2, inserted: 2, skipped: 0 });
    assert.deepEqual(first.get('company_profile'), { read: 1, inserted: 1, skipped: 0 });

    const c2 = capture();
    assert.equal(await run(['--from', legacy, '--workspace', WS, '--to-dir', to], c2), 0, c2.err());
    for (const [t, n] of counts(c2.out())) {
      assert.equal(n.inserted, 0, `${t} inserted on second run`);
      assert.equal(n.skipped, n.read, `${t} skipped on second run`);
    }
    assert.match(c2.out(), /MIGRATE_OK 1 files/);

    const db = await openDb({ dataDir: to });
    try {
      const ws = await db.all('SELECT DISTINCT workspace_id FROM bids');
      assert.deepEqual(ws.map((r) => r.workspace_id), [WS]);
      assert.equal((await db.get("SELECT budget FROM bids WHERE bid_id = 'B1'")).budget, 12000000000);
      assert.equal((await db.get('SELECT name, small_business FROM company_profile')).name, '테스트 상사');
      assert.equal((await db.get("SELECT value FROM settings WHERE key = 'company_name'")).value, '테스트 상사');
      // identity 시퀀스가 옮긴 id 뒤로 올라가 새 행이 충돌하지 않는다
      await db.withWorkspace(WS, async () => {
        const r = await db.get("INSERT INTO source_runs (source_id, ran_at, ok) VALUES ('nara', 'x', 1) RETURNING id");
        assert.ok(r.id > 9, `new id ${r.id} after migrated max 9`);
      });
    } finally {
      await db.close();
    }
  });

  it('--dry reads and reports but writes nothing', async () => {
    const to = path.join(dir, 'pg-dry');
    const c = capture();
    assert.equal(await run(['--from', legacy, '--workspace', WS, '--to-dir', to, '--dry'], c), 0, c.err());
    assert.equal(existsSync(to), false, 'target dir not created');
    const n = counts(c.out());
    assert.equal(n.get('bids').read, 2);
    for (const [, v] of n) assert.equal(v.inserted, 0);
    assert.match(c.out(), /MIGRATE_OK 1 files\n$/);
  });

  it('--all migrates every <uuid>.sqlite into <to-dir>/<uuid>', async () => {
    const src = path.join(dir, 'ws');
    mkdirSync(src);
    makeLegacy(path.join(src, `${WS}.sqlite`));
    makeLegacy(path.join(src, `${WS2}.sqlite`));
    const to = path.join(dir, 'pg-all');
    const c = capture();
    assert.equal(await run(['--all', src, '--to-dir', to], c), 0, c.err());
    assert.match(c.out(), /MIGRATE_OK 2 files/);
    assert.ok(existsSync(path.join(to, WS)) && existsSync(path.join(to, WS2)));
  });
});

describe('migrate-sqlite --to-url (shared Postgres, PGlite stand-in)', () => {
  it('skips members and stores rows under the workspace', async () => {
    let target;
    const fakeOpen = async (opts) => {
      assert.equal(opts.url, 'postgresql://example.invalid/db');
      target = await openDb({ memory: true });
      await applyModules(target);
      const close = target.close;
      target.close = async () => {}; // 테스트가 뒤에서 확인하고 닫는다
      target.realClose = close;
      return target;
    };
    const c = capture();
    const code = await run(['--from', legacy, '--workspace', WS, '--to-url', 'postgresql://example.invalid/db'], { ...c, openDb: fakeOpen });
    assert.equal(code, 0, c.err());
    const n = counts(c.out());
    assert.equal(n.has('members'), false, 'members line omitted');
    assert.equal(n.size, TABLES.length - 1);
    assert.equal(n.get('assign_items').inserted, 1);
    assert.equal((await target.get('SELECT count(*)::int AS n FROM members')).n, 0);
    assert.equal((await target.get('SELECT workspace_id FROM assign_items')).workspace_id, WS);
    await target.realClose();
  });
});

describe('migrate-sqlite arguments', () => {
  it('rejects bad usage with exit 1', async () => {
    for (const argv of [
      [],
      ['--from', 'x.sqlite', '--workspace', WS],
      ['--from', 'x.sqlite', '--workspace', WS, '--to-dir', 'a', '--to-url', 'b'],
      ['--from', 'x.sqlite', '--workspace', 'not-a-uuid', '--to-dir', 'a'],
      ['--from', path.join(dir, 'missing.sqlite'), '--workspace', WS, '--to-dir', 'a'],
      ['--bogus'],
    ]) {
      const c = capture();
      assert.equal(await run(argv, c), 1, argv.join(' '));
      assert.ok(c.err().length > 0);
      assert.doesNotMatch(c.out(), /MIGRATE_OK/);
    }
  });
});
