import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMigration, listTables, OUT_REL } from '../../scripts/build-migration.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const built = buildMigration({ root: ROOT });

test('output is deterministic and ends with a single newline', () => {
  assert.equal(buildMigration({ root: ROOT }), built);
  assert.ok(built.endsWith('\n') && !built.endsWith('\n\n'));
});

test('committed migration matches generator output (no drift)', () => {
  assert.equal(readFileSync(path.join(ROOT, OUT_REL), 'utf8'), built);
});

test('core first, then modules in id order, each with a source comment', () => {
  const sources = [...built.matchAll(/^-- source: (.+)$/gm)].map((m) => m[1]);
  assert.equal(sources[0], 'app/core/schema.sql');
  const mods = sources.slice(1);
  assert.ok(mods.length >= 7);
  assert.deepEqual(mods, [...mods].sort());
  for (const s of mods) assert.match(s, /^app\/modules\/[a-z0-9_-]+\/schema\.sql$/);
});

test('contains all 25 tenant tables, each keyed by workspace_id', () => {
  const tables = listTables(built);
  assert.equal(tables.length, 25);
  for (const t of ['settings', 'members', 'bids', 'job_runs', 'notification_deliveries', 'assign_items', 'company_profile', 'history_results']) {
    assert.ok(tables.includes(t), `missing ${t}`);
  }
  assert.ok(!tables.includes('rate_limits'));
  const blocks = built.split(/CREATE TABLE IF NOT EXISTS /i).slice(1);
  for (const b of blocks) assert.match(b, /PRIMARY KEY \(workspace_id\b/);
});

test('modules without schema.sql are skipped; module order is by directory id', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-migration-'));
  try {
    mkdirSync(path.join(dir, 'app/core'), { recursive: true });
    writeFileSync(path.join(dir, 'app/core/schema.sql'), 'CREATE TABLE IF NOT EXISTS a (workspace_id uuid, PRIMARY KEY (workspace_id));\n');
    for (const m of ['zeta', 'alpha', 'empty']) mkdirSync(path.join(dir, 'app/modules', m), { recursive: true });
    writeFileSync(path.join(dir, 'app/modules/zeta/schema.sql'), 'CREATE TABLE IF NOT EXISTS zeta_t (x int);');
    writeFileSync(path.join(dir, 'app/modules/alpha/schema.sql'), 'CREATE TABLE IF NOT EXISTS alpha_t (x int);\n\n\n');
    const out = buildMigration({ root: dir });
    const sources = [...out.matchAll(/^-- source: (.+)$/gm)].map((m) => m[1]);
    assert.deepEqual(sources, ['app/core/schema.sql', 'app/modules/alpha/schema.sql', 'app/modules/zeta/schema.sql']);
    assert.deepEqual(listTables(out), ['a', 'alpha_t', 'zeta_t']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saas_platform migration enables forced RLS, policy, FK and grant for every tenant table', () => {
  const platform = readFileSync(path.join(ROOT, 'supabase/migrations/20261103000001_saas_platform.sql'), 'utf8');
  const hasTableList = platform.match(/-- tenant tables: (.+)$/m);
  assert.ok(hasTableList, 'tenant table list comment missing');
  const listed = hasTableList[1].split(/\s+/).filter(Boolean).sort();
  assert.deepEqual(listed, listTables(built).sort());
  const loop = platform.match(/foreach t in array array\[([^\]]+)\]/);
  assert.ok(loop, 'tenant table loop missing');
  const looped = [...loop[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(looped, listTables(built).sort());
  for (const stmt of ['_ws_fk', 'enable row level security', 'force row level security', "_app_worker', t", 'grant select, insert, update, delete on public.%I to app_worker']) {
    assert.ok(platform.includes(stmt), `missing ${stmt}`);
  }
});
