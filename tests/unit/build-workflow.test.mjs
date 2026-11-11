import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkflow } from '../../scripts/build-workflow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const paths = {
  templatePath: path.join(ROOT, 'workflows/bid-radar-smoke.template.json'),
  matchPath: path.join(ROOT, 'src/match.js'),
  criteriaPath: path.join(ROOT, 'config/criteria.json'),
};
const fixture = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/nara-bids.json'), 'utf8'));

const built = buildWorkflow(paths);
const wf = JSON.parse(built);
const code = wf.nodes.find((n) => n.name === 'Match Criteria').parameters.jsCode;

const targets = (name) =>
  (wf.connections[name]?.main ?? []).flat().map((c) => c.node);

test('output ends with newline and is 2-space JSON', () => {
  assert.equal(built, JSON.stringify(wf, null, 2) + '\n');
});

test('workflow id and name', () => {
  assert.equal(wf.id, 'bidRadarSmoke001');
  assert.equal(wf.name, 'bid-radar-smoke');
  assert.equal(wf.active, false);
});

test('node set is exactly the 5 contract nodes', () => {
  assert.deepEqual(
    wf.nodes.map((n) => n.name).sort(),
    ['Daily 08:00', 'Fetch Nara Bids', 'Manual Trigger', 'Match Criteria', 'Send Notification'].sort(),
  );
  const types = Object.fromEntries(wf.nodes.map((n) => [n.name, n.type]));
  assert.equal(types['Manual Trigger'], 'n8n-nodes-base.manualTrigger');
  assert.equal(types['Daily 08:00'], 'n8n-nodes-base.scheduleTrigger');
  assert.equal(types['Fetch Nara Bids'], 'n8n-nodes-base.httpRequest');
  assert.equal(types['Match Criteria'], 'n8n-nodes-base.code');
  assert.equal(types['Send Notification'], 'n8n-nodes-base.httpRequest');
});

test('connection chain: triggers -> fetch -> match -> send', () => {
  assert.deepEqual(targets('Manual Trigger'), ['Fetch Nara Bids']);
  assert.deepEqual(targets('Daily 08:00'), ['Fetch Nara Bids']);
  assert.deepEqual(targets('Fetch Nara Bids'), ['Match Criteria']);
  assert.deepEqual(targets('Match Criteria'), ['Send Notification']);
  assert.deepEqual(targets('Send Notification'), []);
});

test('Match Criteria jsCode is built from match.js', () => {
  assert.ok(!code.includes('/*@@MATCH_CODE@@*/'));
  assert.ok(!code.includes('export '));
  assert.ok(code.includes('function matchBids'));
  assert.ok(code.includes('const criteria = {"keywords"'));
  assert.ok(code.endsWith("$now.toFormat('yyyy-MM-dd')) }];\n"));
});

test('modified match copy changes the build result', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bid-radar-build-'));
  try {
    const copy = path.join(dir, 'match.js');
    writeFileSync(copy, readFileSync(paths.matchPath, 'utf8') + '\nexport function extraMarker() {}\n');
    const other = buildWorkflow({ ...paths, matchPath: copy });
    assert.notEqual(other, built);
    assert.ok(other.includes('function extraMarker'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('jsCode runs with stub $input/$now and yields count 3', () => {
  const $input = { first: () => ({ json: fixture }) };
  const $now = {
    toFormat: (fmt) => {
      assert.equal(fmt, 'yyyy-MM-dd');
      return '2026-10-29';
    },
  };
  const result = new Function('$input', '$now', code)($input, $now);
  assert.equal(result.length, 1);
  const n = result[0].json;
  assert.equal(n.count, 3);
  assert.equal(n.date, '2026-10-29');
  assert.deepEqual(n.items.map((m) => m.bidId), ['20261029007-000', '20261029001-000', '20261029002-000']);
  assert.ok(n.text.startsWith('입찰 레이더 · 10/29 새 공고 3건'));
});
