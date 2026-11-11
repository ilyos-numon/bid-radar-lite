// 문법 검사 + 생성물 동기화 확인. 하나라도 실패하면 exit 1.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, 'app')),
  ...readdirSync(path.join(ROOT, 'scripts'))
    .filter((n) => n.endsWith('.mjs'))
    .sort()
    .map((n) => path.join(ROOT, 'scripts', n)),
  path.join(ROOT, 'src/match.js'),
];

const failures = [];
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failures.push(path.relative(ROOT, f));
    console.log(`FAIL syntax ${path.relative(ROOT, f)}`);
    process.stdout.write(r.stderr || '');
  }
}
console.log(`checked ${files.length} files`);

const wf = spawnSync(process.execPath, [path.join(ROOT, 'scripts/build-workflow.mjs'), '--check'], { encoding: 'utf8', cwd: ROOT });
process.stdout.write(wf.stdout || '');
process.stderr.write(wf.stderr || '');
if (wf.status !== 0) failures.push('scripts/build-workflow.mjs --check');

const daily = path.join(ROOT, 'workflows/bid-radar-daily.json');
if (existsSync(daily)) {
  try {
    JSON.parse(readFileSync(daily, 'utf8'));
  } catch (e) {
    failures.push('workflows/bid-radar-daily.json');
    console.log(`FAIL json workflows/bid-radar-daily.json: ${e.message}`);
  }
}

if (failures.length > 0) {
  console.log(`lint failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('lint ok');
