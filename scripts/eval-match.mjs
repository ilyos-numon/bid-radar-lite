// 정답셋 평가: node scripts/eval-match.mjs [--json] [--check-labels] [--golden <dir>]
// 추천(matchBids) 정밀도·재현율과 자격 판정(judge) 정확도를 사람 라벨과 비교한다. exit 0 = 통과, 1 = 실패.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERDICTS = ['ok', 'check', 'no'];

const readJson = (dir, name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
const round3 = (x) => Math.round(x * 1000) / 1000;

export function parseArgs(argv) {
  const a = { json: false, checkLabels: false, golden: path.join(ROOT, 'tests/fixtures/golden') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') a.json = true;
    else if (argv[i] === '--check-labels') a.checkLabels = true;
    else if (argv[i] === '--golden') a.golden = path.resolve(argv[++i] ?? '');
  }
  return a;
}

/** 라벨 검사 → 오류 문자열 목록. bidIds: bids.json 의 공고 id 목록 */
export function checkLabels(bidIds, labels) {
  const errors = [];
  const ids = new Set(bidIds);
  for (const id of bidIds) if (!(id in labels)) errors.push(`label missing for bid ${id}`);
  for (const [id, l] of Object.entries(labels)) {
    if (!ids.has(id)) errors.push(`label ${id} has no matching bid`);
    if (!l || typeof l.why !== 'string' || l.why.trim() === '') errors.push(`label ${id}: why is empty`);
    if (!l || typeof l.expectMatch !== 'boolean') errors.push(`label ${id}: expectMatch must be boolean`);
    if (!l || !(l.expectVerdict === null || VERDICTS.includes(l.expectVerdict))) errors.push(`label ${id}: expectVerdict must be ok|check|no|null`);
  }
  return errors;
}

/** 순수 지표 계산. predicted: 추천된 bidId 집합, labels: {id:{expectMatch}} */
export function matchMetrics(predicted, labels) {
  let tp = 0, fp = 0, fn = 0;
  const wrong = [];
  for (const [id, l] of Object.entries(labels)) {
    const got = predicted.has(id);
    if (got && l.expectMatch) tp++;
    else if (got && !l.expectMatch) { fp++; wrong.push({ id, kind: 'fp' }); }
    else if (!got && l.expectMatch) { fn++; wrong.push({ id, kind: 'fn' }); }
  }
  return { tp, fp, fn, precision: tp + fp === 0 ? 1 : tp / (tp + fp), recall: tp + fn === 0 ? 1 : tp / (tp + fn), wrong };
}

export function verdictMetrics(verdicts, labels) {
  let n = 0, correct = 0;
  const wrong = [];
  for (const [id, l] of Object.entries(labels)) {
    if (l.expectVerdict === null || l.expectVerdict === undefined) continue;
    n++;
    if (verdicts[id] === l.expectVerdict) correct++;
    else wrong.push({ id, expect: l.expectVerdict, got: verdicts[id] ?? null });
  }
  return { n, correct, accuracy: n === 0 ? null : correct / n, wrong };
}

async function loadJudge() {
  try {
    const m = await import(pathToFileURL(path.join(ROOT, 'app/modules/company/service.mjs')).href);
    return typeof m.judge === 'function' ? m.judge : null;
  } catch {
    return null;
  }
}

export async function evaluate(goldenDir) {
  const bids = readJson(goldenDir, 'bids.json');
  const { criteria, profile } = readJson(goldenDir, 'criteria.json');
  const labels = readJson(goldenDir, 'labels.json');
  const { matchBids, normalizeBid } = await import(pathToFileURL(path.join(ROOT, 'src/match.js')).href);
  const norm = bids.map((b) => normalizeBid(b, 'golden'));
  const predicted = new Set(matchBids(bids, criteria).map((m) => m.bidId));
  const match = matchMetrics(predicted, labels);

  const judge = await loadJudge();
  let verdict = { n: 0, correct: 0, accuracy: null, wrong: [] };
  if (judge) {
    const got = {};
    for (const nb of norm) {
      try {
        // limits: 새 시그니처, regionLimit: 옛 시그니처 (한쪽만 읽는다). 공고문 원문은 없는 상태로 구조화 정보만 본다.
        const r = await judge({ profile, limits: nb.limits, regionLimit: nb.limits.regionRaw, textStatus: 'none', result: null });
        got[nb.bidId] = r && r.verdict;
      } catch {
        got[nb.bidId] = null;
      }
    }
    verdict = verdictMetrics(got, labels);
  }
  return { count: norm.length, match, verdict };
}

function fmt(x) {
  return x === null ? 'n/a' : round3(x).toFixed(3);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.checkLabels) {
    const bids = readJson(args.golden, 'bids.json');
    const labels = readJson(args.golden, 'labels.json');
    const { normalizeBid } = await import(pathToFileURL(path.join(ROOT, 'src/match.js')).href);
    const errors = checkLabels(bids.map((b) => normalizeBid(b, 'golden').bidId), labels);
    if (errors.length > 0) {
      for (const e of errors) console.error(e);
      process.exit(1);
    }
    console.log(`labels ok: ${bids.length} items`);
    return;
  }
  const r = await evaluate(args.golden);
  const baseline = readJson(args.golden, 'baseline.json');
  const fails = [];
  if (round3(r.match.precision) < baseline.matchPrecisionMin) fails.push('match precision below baseline');
  if (round3(r.match.recall) < baseline.matchRecallMin) fails.push('match recall below baseline');
  if (r.verdict.accuracy !== null && round3(r.verdict.accuracy) < baseline.verdictAccuracyMin) fails.push('verdict accuracy below baseline');
  if (args.json) {
    console.log(JSON.stringify({
      items: r.count,
      precision: round3(r.match.precision), recall: round3(r.match.recall), tp: r.match.tp, fp: r.match.fp, fn: r.match.fn,
      verdictAccuracy: r.verdict.accuracy === null ? null : round3(r.verdict.accuracy), verdictItems: r.verdict.n,
      wrongMatch: r.match.wrong, wrongVerdict: r.verdict.wrong, baseline, pass: fails.length === 0,
    }, null, 2));
  } else {
    console.log(`match precision=${fmt(r.match.precision)} recall=${fmt(r.match.recall)} (tp=${r.match.tp} fp=${r.match.fp} fn=${r.match.fn})`);
    console.log(r.verdict.accuracy === null ? 'verdict accuracy=n/a' : `verdict accuracy=${fmt(r.verdict.accuracy)} (${r.verdict.correct}/${r.verdict.n})`);
    for (const w of r.match.wrong) console.log(`  match ${w.kind} ${w.id}`);
    for (const w of r.verdict.wrong) console.log(`  verdict ${w.id} expect=${w.expect} got=${w.got}`);
    for (const f of fails) console.log(`FAIL: ${f}`);
  }
  process.exit(fails.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
