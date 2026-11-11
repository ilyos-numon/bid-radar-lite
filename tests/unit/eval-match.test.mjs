import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLabels, matchMetrics, verdictMetrics } from '../../scripts/eval-match.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/eval-match.mjs'), ...args], { encoding: 'utf8' });

function tmpGolden(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));
  const src = path.join(ROOT, 'tests/fixtures/golden');
  for (const f of ['bids.json', 'criteria.json', 'labels.json', 'baseline.json']) fs.copyFileSync(path.join(src, f), path.join(dir, f));
  if (mutate) mutate(dir);
  return dir;
}

test('실제 golden: 라벨 검사 통과, 40건 이상', () => {
  const r = run('--check-labels');
  assert.equal(r.status, 0, r.stderr);
  const n = Number(/labels ok: (\d+) items/.exec(r.stdout)?.[1]);
  assert.ok(n >= 40, r.stdout);
});

test('why 가 빈 라벨이 있으면 --check-labels 는 exit 1', () => {
  const dir = tmpGolden((d) => {
    const f = path.join(d, 'labels.json');
    const labels = JSON.parse(fs.readFileSync(f, 'utf8'));
    labels[Object.keys(labels)[0]].why = '  ';
    fs.writeFileSync(f, JSON.stringify(labels));
  });
  try {
    const r = run('--check-labels', '--golden', dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /why is empty/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bidId 가 맞지 않으면 --check-labels 는 exit 1', () => {
  const dir = tmpGolden((d) => {
    const f = path.join(d, 'labels.json');
    const labels = JSON.parse(fs.readFileSync(f, 'utf8'));
    labels['NOPE-000'] = labels[Object.keys(labels)[0]];
    fs.writeFileSync(f, JSON.stringify(labels));
  });
  try {
    const r = run('--check-labels', '--golden', dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /NOPE-000/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--json: 숫자 출력, baseline 통과 시 exit 0', () => {
  const r = run('--json');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(typeof o.precision, 'number');
  assert.equal(typeof o.recall, 'number');
  assert.equal(o.pass, true);
});

test('baseline 을 못 넘으면 exit 1', () => {
  // 실제 golden 수치에 기대지 않는다: 추천 라벨을 전부 뒤집어 규칙 결과가 일부러 틀리게 만들고, 높은 baseline 을 둔다.
  const dir = tmpGolden((d) => {
    const f = path.join(d, 'labels.json');
    const labels = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const l of Object.values(labels)) l.expectMatch = !l.expectMatch;
    fs.writeFileSync(f, JSON.stringify(labels));
    fs.writeFileSync(path.join(d, 'baseline.json'), JSON.stringify({ matchPrecisionMin: 0.95, matchRecallMin: 0.95, verdictAccuracyMin: 0 }));
  });
  try {
    const r = run('--golden', dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /match precision=\d\.\d{3} recall=\d\.\d{3}/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('지표 계산: 작은 합성 세트', () => {
  const labels = {
    a: { expectMatch: true, expectVerdict: 'ok' },
    b: { expectMatch: true, expectVerdict: 'no' },
    c: { expectMatch: false, expectVerdict: null },
    d: { expectMatch: false, expectVerdict: 'check' },
  };
  const m = matchMetrics(new Set(['a', 'c']), labels);
  assert.deepEqual([m.tp, m.fp, m.fn], [1, 1, 1]);
  assert.equal(m.precision, 0.5);
  assert.equal(m.recall, 0.5);
  const v = verdictMetrics({ a: 'ok', b: 'check', d: 'check' }, labels);
  assert.equal(v.n, 3);
  assert.equal(v.correct, 2);
  assert.ok(Math.abs(v.accuracy - 2 / 3) < 1e-9);
  assert.deepEqual(v.wrong, [{ id: 'b', expect: 'no', got: 'check' }]);
});

test('checkLabels: 정상 입력은 오류 없음', () => {
  assert.deepEqual(checkLabels(['x'], { x: { expectMatch: true, expectVerdict: null, why: '이유' } }), []);
});
