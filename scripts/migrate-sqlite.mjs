// 기존 회사별 SQLite 파일을 Postgres(공유 pg) 또는 PGlite 디렉토리로 옮긴다. 원본은 읽기만 한다.
// 사용: node scripts/migrate-sqlite.mjs (--from <file.sqlite> --workspace <uuid> | --all <dir>) (--to-url <url> | --to-dir <dir>) [--dry]
//   --all <dir>: <dir>/<uuid>.sqlite 파일을 모두 옮긴다 (--to-dir 이면 <to-dir>/<uuid> 디렉토리로)
//   --to-url: 공유 Postgres (스키마는 Supabase 마이그레이션이 만든다). 구성원(members)은 플랫폼이 가지므로 옮기지 않는다
//   --to-dir: PGlite 디렉토리 (스키마를 여기서 만든다). 레거시 구성원(members)도 옮긴다
// 여러 번 돌려도 같다(이미 있는 행은 건너뛴다). 출력: 표마다 `<table> read=<n> inserted=<n> skipped=<n>`,
// 마지막 줄 `MIGRATE_OK <files> files`. 실패하면 exit 1 (그 파일은 트랜잭션으로 되돌린다).
import nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { openDb as realOpenDb, transaction } from '../app/core/db.mjs';

export const TABLES = [
  'settings',
  'members',
  'sources',
  'source_runs',
  'bids',
  'bid_details',
  'bid_changes',
  'bid_texts',
  'bid_links',
  'matches',
  'notifications',
  'collect_days',
  'interest_items',
  'interest_checks',
  'interest_reminders',
  'assign_items',
  'company_profile',
  'company_verdicts',
  'summary_items',
  'keywords_synonyms',
  'support_items',
  'support_runs',
  'history_results',
];

const USAGE = [
  '사용법:',
  '  node scripts/migrate-sqlite.mjs (--from <file.sqlite> --workspace <uuid> | --all <dir>) (--to-url <url> | --to-dir <dir>) [--dry]',
  '',
].join('\n');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MODULES_DIR = fileURLToPath(new URL('../app/modules/', import.meta.url));
const MAX_PARAMS = 30000;
const MAX_BATCH = 500;

class MigrateError extends Error {}

function present(v) {
  return typeof v === 'string' && v.trim() !== '';
}

const qid = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** 옮길 파일 목록: [{ file, workspaceId }] */
function listJobs(values, fs) {
  if (present(values.all)) {
    if (present(values.from) || present(values.workspace)) throw new MigrateError(USAGE);
    const dir = path.resolve(values.all);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new MigrateError(`디렉토리가 없습니다: ${dir}`);
    const jobs = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.sqlite'))
      .sort()
      .map((n) => ({ file: path.join(dir, n), workspaceId: n.slice(0, -'.sqlite'.length) }));
    const bad = jobs.filter((j) => !UUID_RE.test(j.workspaceId));
    if (bad.length) throw new MigrateError(`파일 이름이 <회사 id>.sqlite 형식이 아닙니다: ${bad.map((j) => path.basename(j.file)).join(', ')}`);
    if (!jobs.length) throw new MigrateError(`옮길 .sqlite 파일이 없습니다: ${dir}`);
    return jobs;
  }
  if (!present(values.from) || !present(values.workspace)) throw new MigrateError(USAGE);
  if (!UUID_RE.test(values.workspace)) throw new MigrateError('회사 id 형식이 아닙니다 (--workspace)');
  const file = path.resolve(values.from);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new MigrateError(`옮길 SQLite 파일이 없습니다: ${file}`);
  return [{ file, workspaceId: values.workspace.toLowerCase() }];
}

/** 원본에서 표마다 열·행을 읽는다. 없는 표는 빈 표로 */
function readSource(file) {
  const src = new DatabaseSync(file, { readOnly: true });
  try {
    const existing = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    const out = new Map();
    for (const t of TABLES) {
      if (!existing.has(t)) {
        out.set(t, { columns: [], rows: [] });
        continue;
      }
      const columns = src.prepare(`PRAGMA table_info(${qid(t)})`).all().map((c) => c.name);
      const order = columns.includes('id') ? ' ORDER BY id' : '';
      const rows = src.prepare(`SELECT * FROM ${qid(t)}${order}`).all();
      out.set(t, { columns, rows });
    }
    return out;
  } catch (e) {
    throw new MigrateError(`SQLite 파일을 읽지 못했습니다: ${path.basename(file)} (${e?.code ?? e?.message})`);
  } finally {
    src.close();
  }
}

/** PGlite 대상: 코어 스키마는 openDb 가, 모듈 스키마는 여기서 만든다 */
async function applyModuleSchemas(db, fs) {
  if (!fs.existsSync(MODULES_DIR)) return;
  for (const name of fs.readdirSync(MODULES_DIR).sort()) {
    const file = path.join(MODULES_DIR, name, 'schema.sql');
    if (fs.existsSync(file)) await db.applySchema(file);
  }
}

async function targetColumns(db, table) {
  const rows = await db.all(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
    [table],
  );
  return new Set(rows.map((r) => r.column_name));
}

/** 행을 묶어 넣는다. 이미 있는 행(키 충돌)은 건너뛴다. 넣은 행 수를 돌려준다 */
async function insertRows(db, table, columns, rows) {
  if (!rows.length || !columns.length) return 0;
  const size = Math.max(1, Math.min(MAX_BATCH, Math.floor(MAX_PARAMS / columns.length)));
  const colSql = columns.map(qid).join(', ');
  let inserted = 0;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const params = [];
    const tuples = chunk.map((row) => {
      const ph = columns.map((c) => {
        const v = row[c];
        params.push(typeof v === 'bigint' ? v.toString() : v ?? null);
        return `$${params.length}`;
      });
      return `(${ph.join(', ')})`;
    });
    const r = await db.run(`INSERT INTO ${qid(table)} (${colSql}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`, params);
    inserted += r.rowCount;
  }
  return inserted;
}

/** 옮긴 id 다음 번호부터 새 행이 생기게 identity 시퀀스를 올린다 (내리지는 않는다) */
async function bumpSequence(db, table) {
  const seq = (await db.get('SELECT pg_get_serial_sequence($1, $2) AS s', [table, 'id']))?.s;
  if (!seq) return;
  const max = Number((await db.get(`SELECT COALESCE(MAX(id), 0) AS m FROM ${qid(table)}`))?.m ?? 0);
  if (max < 1) return;
  const cur = await db.get(`SELECT last_value, is_called FROM ${seq}`);
  const last = cur?.is_called ? Number(cur.last_value) : Number(cur?.last_value ?? 1) - 1;
  if (max > last) await db.get('SELECT setval($1::regclass, $2::bigint, true)', [seq, max]);
}

async function migrateFile({ file, workspaceId, target, dry, openDb, fs, out, err }) {
  const source = readSource(file);
  const tables = TABLES.filter((t) => !(t === 'members' && target.kind === 'url'));
  out(`# ${path.basename(file)} → ${workspaceId}${dry ? ' (dry: 쓰지 않습니다)' : ''}`);

  if (dry) {
    for (const t of tables) out(`${t} read=${source.get(t).rows.length} inserted=0 skipped=0`);
    return;
  }

  const db = target.kind === 'url' ? await openDb({ url: target.url }) : await openDb({ dataDir: path.join(target.dir) });
  try {
    if (target.kind === 'dir') await applyModuleSchemas(db, fs);
    await db.withWorkspace(workspaceId, async () => {
      const lines = [];
      const withIds = [];
      await transaction(db, async () => {
        for (const t of tables) {
          const { columns, rows } = source.get(t);
          const have = rows.length ? await targetColumns(db, t) : new Set();
          if (rows.length && !have.size) throw new MigrateError(`대상에 ${t} 표가 없습니다 (마이그레이션을 먼저 적용해 주세요)`);
          const cols = columns.filter((c) => c !== 'workspace_id' && have.has(c));
          const inserted = await insertRows(db, t, cols, rows);
          if (cols.includes('id') && inserted > 0) withIds.push(t);
          lines.push(`${t} read=${rows.length} inserted=${inserted} skipped=${rows.length - inserted}`);
        }
      });
      for (const l of lines) out(l);
      for (const t of withIds) {
        try {
          await bumpSequence(db, t);
        } catch (e) {
          err(`경고: ${t} 번호 시퀀스를 올리지 못했습니다 (${e?.code ?? 'UNKNOWN'}). 관리자 계정으로 다시 실행해 주세요`);
        }
      }
    });
  } finally {
    await db.close();
  }
}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @param {{ openDb?: typeof realOpenDb, fs?: typeof nodeFs, stdout?: {write(s:string):void}, stderr?: {write(s:string):void} }} [deps]
 * @returns {Promise<number>} 종료 코드
 */
export async function run(argv, { openDb = realOpenDb, fs = nodeFs, stdout = process.stdout, stderr = process.stderr } = {}) {
  const write = (stream) => (s) => stream.write(String(s).endsWith('\n') ? String(s) : `${s}\n`);
  const out = write(stdout);
  const err = write(stderr);
  try {
    const { values } = parseArgs({
      args: argv ?? [],
      options: {
        from: { type: 'string' },
        workspace: { type: 'string' },
        all: { type: 'string' },
        'to-url': { type: 'string' },
        'to-dir': { type: 'string' },
        dry: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const toUrl = present(values['to-url']);
    const toDir = present(values['to-dir']);
    if (toUrl === toDir) throw new MigrateError(USAGE);
    const jobs = listJobs(values, fs);
    const multi = present(values.all);
    for (const job of jobs) {
      const target = toUrl
        ? { kind: 'url', url: values['to-url'] }
        : { kind: 'dir', dir: multi ? path.join(path.resolve(values['to-dir']), job.workspaceId) : path.resolve(values['to-dir']) };
      await migrateFile({ ...job, target, dry: values.dry, openDb, fs, out, err });
    }
    out(`MIGRATE_OK ${jobs.length} files`);
    return 0;
  } catch (e) {
    if (e instanceof MigrateError) err(e.message);
    else if (String(e?.code ?? '').startsWith('ERR_PARSE_ARGS')) err(USAGE);
    else err(`실패했습니다 (${e?.code ?? 'UNKNOWN'}: ${e?.message ?? e})`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
