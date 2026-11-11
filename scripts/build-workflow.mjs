import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PLACEHOLDER = '/*@@MATCH_CODE@@*/';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_REL = 'workflows/bid-radar-smoke.json';

/**
 * @param {{templatePath:string, matchPath:string, criteriaPath:string}} paths
 * @returns {string}
 */
export function buildWorkflow({ templatePath, matchPath, criteriaPath }) {
  const template = JSON.parse(readFileSync(templatePath, 'utf8'));
  const matchSrc = readFileSync(matchPath, 'utf8').replace(/^export /gm, '');
  const criteriaRaw = readFileSync(criteriaPath, 'utf8').trim();
  JSON.parse(criteriaRaw);
  const code =
    matchSrc +
    `\nconst criteria = ${criteriaRaw};\n` +
    'const bids = normalizeNaraResponse($input.first().json);\n' +
    "return [{ json: buildNotification(matchBids(bids, criteria), $now.toFormat('yyyy-MM-dd')) }];\n";
  const node = (template.nodes || []).find((n) => n.name === 'Match Criteria');
  if (!node || node.parameters.jsCode !== PLACEHOLDER) {
    throw new Error('template: Match Criteria jsCode placeholder missing');
  }
  node.parameters.jsCode = code;
  return JSON.stringify(template, null, 2) + '\n';
}

function main(argv) {
  const out = buildWorkflow({
    templatePath: path.join(ROOT, 'workflows/bid-radar-smoke.template.json'),
    matchPath: path.join(ROOT, 'src/match.js'),
    criteriaPath: path.join(ROOT, 'config/criteria.json'),
  });
  const outPath = path.join(ROOT, OUT_REL);
  if (argv.includes('--check')) {
    let current = null;
    try {
      current = readFileSync(outPath, 'utf8');
    } catch {
      current = null;
    }
    if (current !== null && Buffer.from(current).equals(Buffer.from(out))) {
      console.log('workflow up to date');
      return 0;
    }
    console.log('workflow stale: run npm run build:workflow');
    return 1;
  }
  writeFileSync(outPath, out);
  console.log(`built ${OUT_REL}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
