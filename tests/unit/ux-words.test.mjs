// Screen-language check: shared layout and every module view must not contain engine terms,
// case-insensitive, comments included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FORBIDDEN = ['n8n', 'LLM', '워크플로', 'MCP', '프롬프트', '토큰', '모델'];

function targetFiles() {
  const files = [];
  const html = path.join(ROOT, 'app', 'core', 'html.mjs');
  if (existsSync(html)) files.push(html);
  const platformViews = path.join(ROOT, 'app', 'core', 'platform-views.mjs');
  if (existsSync(platformViews)) files.push(platformViews);
  const modulesDir = path.join(ROOT, 'app', 'modules');
  if (existsSync(modulesDir)) {
    for (const name of readdirSync(modulesDir).sort()) {
      const dir = path.join(modulesDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const view = path.join(dir, 'view.mjs');
      if (existsSync(view)) files.push(view);
    }
  }
  return files;
}

/** @returns {Array<{file: string, line: number, word: string}>} */
export function findForbidden(file) {
  const hits = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    const lower = text.toLowerCase();
    for (const word of FORBIDDEN) {
      if (lower.includes(word.toLowerCase())) hits.push({ file: path.relative(ROOT, file), line: i + 1, word });
    }
  });
  return hits;
}

test('ux-words: target files exist (html.mjs, today and settings views at least)', () => {
  const rel = targetFiles().map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  assert.ok(rel.length > 0, 'no files to scan');
  for (const need of ['app/core/html.mjs', 'app/modules/today/view.mjs', 'app/modules/settings/view.mjs']) {
    assert.ok(rel.includes(need), `missing scan target ${need} (found: ${rel.join(', ') || 'none'})`);
  }
});

test('ux-words: no forbidden engine terms in layout and module views', () => {
  const files = targetFiles();
  assert.ok(files.length > 0, 'no files to scan');
  const hits = files.flatMap(findForbidden);
  assert.equal(
    hits.length,
    0,
    `forbidden terms found:\n${hits.map((h) => `  ${h.file}:${h.line} '${h.word}'`).join('\n')}`,
  );
});

test('ux-words: detector is case-insensitive and reports line numbers', () => {
  const sample = ['ok line', 'uses N8N here', '// 리모델링 comment'];
  const found = [];
  sample.forEach((text, i) => {
    for (const word of FORBIDDEN) if (text.toLowerCase().includes(word.toLowerCase())) found.push(`${i + 1}:${word}`);
  });
  assert.deepEqual(found, ['2:n8n', '3:모델']);
});
