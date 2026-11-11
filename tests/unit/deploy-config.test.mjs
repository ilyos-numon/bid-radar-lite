import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkDeploy,
  DEPLOY_FILES,
  ENV_VALUE_RULES,
  FORBIDDEN_FILES,
  FORBIDDEN_TEXT,
  parseEnvExample,
  parseEnvKeys,
  parseServiceAnnotations,
  parseServiceEnv,
  REQUIRED_ENV,
  REQUIRED_SECRETS,
  SCALE_RULES,
} from '../../scripts/check-deploy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/check-deploy.mjs');

function copyDeploy() {
  const dir = mkdtempSync(path.join(tmpdir(), 'deploy-check-'));
  cpSync(path.join(ROOT, 'deploy'), path.join(dir, 'deploy'), { recursive: true });
  return dir;
}

function edit(dir, rel, fn) {
  const p = path.join(dir, rel);
  writeFileSync(p, fn(readFileSync(p, 'utf8')));
}

test('deploy-config: committed example passes', () => {
  const r = checkDeploy({ root: ROOT, example: true });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test('deploy-config: CLI --example prints DEPLOY_CONFIG_OK and exits 0', () => {
  const r = spawnSync(process.execPath, [SCRIPT, '--example'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /DEPLOY_CONFIG_OK/);
});

test('deploy-config: secret list is exactly the 10 contract names', () => {
  assert.deepEqual([...REQUIRED_SECRETS].sort(), [
    'APP_DB_URL', 'APP_JOB_TOKEN', 'APP_SECRET', 'EMAIL_API_KEY', 'LLM_API_KEY',
    'NARA_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPPORT_API_KEY', 'TOSS_SECRET_KEY', 'TURNSTILE_SECRET_KEY',
  ]);
  const ex = parseEnvExample(readFileSync(path.join(ROOT, 'deploy/env.production.example'), 'utf8'));
  assert.deepEqual([...ex.SECRET].sort(), [...REQUIRED_SECRETS].sort());
});

test('deploy-config: service.yaml secretKeyRef names equal env names', () => {
  const s = parseServiceEnv(readFileSync(path.join(ROOT, 'deploy/gcp/service.yaml'), 'utf8'));
  assert.equal(s.secrets.length, 10);
  for (const { env, secret } of s.secrets) assert.equal(env, secret);
  assert.ok(s.plain.includes('APP_TRUST_PROXY'));
  assert.ok(!s.plain.includes('APP_SECRET'));
});

test('deploy-config: parsers ignore comments and blank lines', () => {
  const ex = parseEnvExample('# head\nX=1\n# === SECRET\n# c\nA=\n\n# === ENV\nB=x\n# === UNUSED\nC=\n');
  assert.deepEqual(ex.SECRET, ['A']);
  assert.deepEqual(ex.ENV, ['B']);
  assert.deepEqual(ex.UNUSED, ['C']);
  assert.deepEqual(parseEnvKeys('# x\nexport A=1\nB = 2\n\nnot a line\n'), ['A', 'B']);
});

test('deploy-config: secret missing from service.yaml is reported', () => {
  const dir = copyDeploy();
  try {
    edit(dir, 'deploy/gcp/service.yaml', (t) =>
      t.replace(/ {12}- name: TOSS_SECRET_KEY\n {14}valueFrom:\n {16}secretKeyRef:\n {18}name: TOSS_SECRET_KEY\n {18}key: latest\n/, ''));
    const r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('TOSS_SECRET_KEY')), r.problems.join('\n'));
    const cli = spawnSync(process.execPath, [SCRIPT, '--example', '--root', dir], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /TOSS_SECRET_KEY/);
    assert.doesNotMatch(cli.stdout, /DEPLOY_CONFIG_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: secret missing from example SECRET section is reported', () => {
  const dir = copyDeploy();
  try {
    edit(dir, 'deploy/env.production.example', (t) => t.replace(/^EMAIL_API_KEY=\n/m, ''));
    const r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('EMAIL_API_KEY')), r.problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: secretKeyRef pointing at a different secret name is reported', () => {
  const dir = copyDeploy();
  try {
    edit(dir, 'deploy/gcp/service.yaml', (t) => t.replace(/name: LLM_API_KEY\n(\s+)key: latest/, 'name: LLM_KEY\n$1key: latest'));
    const r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('LLM_API_KEY')), r.problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: missing deploy file is reported', () => {
  const dir = copyDeploy();
  try {
    rmSync(path.join(dir, 'deploy/gcp/setup.sh'));
    const r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('missing file: deploy/gcp/setup.sh'), r.problems.join('\n'));
    assert.ok(DEPLOY_FILES.includes('deploy/gcp/setup.sh'));
    assert.ok(!DEPLOY_FILES.includes('deploy/gcp/schedules.sh'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: --env file lacking keys lists each missing name', () => {
  const dir = copyDeploy();
  try {
    const ex = parseEnvExample(readFileSync(path.join(ROOT, 'deploy/env.production.example'), 'utf8'));
    const keys = [...ex.SECRET, ...ex.ENV].filter((k) => k !== 'APP_JOB_TOKEN' && k !== 'BUSINESS_NAME');
    const envFile = path.join(dir, 'prod.env');
    writeFileSync(envFile, keys.map((k) => `${k}=v`).join('\n') + '\n');
    const r = checkDeploy({ root: ROOT, envFile });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('APP_JOB_TOKEN')));
    assert.ok(r.problems.some((p) => p.includes('BUSINESS_NAME')));

    writeFileSync(envFile, [...ex.SECRET, ...ex.ENV].map((k) => `${k}=v`).join('\n') + '\n');
    const ok = spawnSync(process.execPath, [SCRIPT, '--env', envFile], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout);
    assert.match(ok.stdout, /DEPLOY_CONFIG_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: no arguments is a usage error', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});

test('deploy-config: service.yaml scales to zero with throttled CPU and the demo cost env', () => {
  const text = readFileSync(path.join(ROOT, 'deploy/gcp/service.yaml'), 'utf8');
  const a = parseServiceAnnotations(text);
  assert.deepEqual(SCALE_RULES, {
    'autoscaling.knative.dev/minScale': '0',
    'run.googleapis.com/cpu-throttling': 'true',
  });
  assert.equal(a['autoscaling.knative.dev/minScale'], '0');
  assert.equal(a['autoscaling.knative.dev/maxScale'], '1');
  assert.equal(a['run.googleapis.com/cpu-throttling'], 'true');
  assert.equal(a['run.googleapis.com/startup-cpu-boost'], 'true');
  assert.match(text, /containerConcurrency: 40\n/);
  assert.match(text, /memory: 512Mi\n/);
  assert.match(text, /- name: APP_WORKER\n\s+value: "0"\n/);
  assert.match(text, /- name: APP_DEMO\n\s+value: "1"\n/);
  const s = parseServiceEnv(text);
  assert.equal(s.values.APP_WORKER, '0');
  assert.equal(s.values.APP_SCHEDULER_OFF, '1');
  assert.equal(s.values.APP_FREE_COLLECTS, '5');
  assert.equal(s.values.APP_DAY_START_MAX_MS, '240000');
  assert.equal(s.values.APP_LOG_LEVEL, 'info');
  assert.equal(s.values.APP_SECRET, undefined);
  assert.deepEqual(ENV_VALUE_RULES, { APP_SCHEDULER_OFF: '1', APP_WORKER: '0' });
  assert.ok(REQUIRED_ENV.includes('APP_SCHEDULER_OFF'));
  assert.ok(REQUIRED_ENV.includes('APP_FREE_COLLECTS'));
  for (const k of [
    'APP_DEMO', 'APP_DEMO_EMAIL_DOMAIN', 'APP_PLATFORM_ADMIN_EMAILS', 'TURNSTILE_SITE_KEY',
    'APP_DAILY_MAX_EMAIL', 'APP_DAILY_MAX_LLM', 'APP_DAILY_MAX_SIGNUP', 'APP_DAILY_MAX_DEMO_LOGIN',
    'APP_RATE_SCALE', 'APP_BODY_LIMIT_BYTES', 'APP_REQUEST_TIMEOUT_MS',
  ]) {
    assert.ok(REQUIRED_ENV.includes(k), k);
    assert.ok(s.plain.includes(k), k);
  }
  assert.ok(s.secrets.some((x) => x.env === 'TURNSTILE_SECRET_KEY'));
});

test('deploy-config: parseServiceAnnotations reads quoted and bare values, skips comments', () => {
  const a = parseServiceAnnotations(
    'metadata:\n  annotations:\n    # x: "9"\n    run.googleapis.com/ingress: all\n    autoscaling.knative.dev/minScale: "0"\n    b: \'2\'\nspec:\n  x: 1\n',
  );
  assert.equal(a['run.googleapis.com/ingress'], 'all');
  assert.equal(a['autoscaling.knative.dev/minScale'], '0');
  assert.equal(a.b, '2');
  assert.equal(a.x, undefined);
  assert.equal(a['# x'], undefined);
});

test('deploy-config: minScale "1" is reported (library and CLI exit 1)', () => {
  const dir = copyDeploy();
  try {
    edit(dir, 'deploy/gcp/service.yaml', (t) => t.replace('autoscaling.knative.dev/minScale: "0"', 'autoscaling.knative.dev/minScale: "1"'));
    const r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('service.yaml annotation autoscaling.knative.dev/minScale must be 0'), r.problems.join('\n'));
    const cli = spawnSync(process.execPath, [SCRIPT, '--example', '--root', dir], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /MISSING service\.yaml annotation autoscaling\.knative\.dev\/minScale must be 0/);
    assert.doesNotMatch(cli.stdout, /DEPLOY_CONFIG_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: cpu-throttling "false" is reported', () => {
  const dir = copyDeploy();
  try {
    edit(dir, 'deploy/gcp/service.yaml', (t) => t.replace('run.googleapis.com/cpu-throttling: "true"', 'run.googleapis.com/cpu-throttling: "false"'));
    const r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('cpu-throttling must be true')), r.problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: maxScale above 1 or missing is reported, 1 is allowed', () => {
  const dir = copyDeploy();
  try {
    assert.deepEqual(checkDeploy({ root: dir, example: true }).problems, []);
    edit(dir, 'deploy/gcp/service.yaml', (t) => t.replace('autoscaling.knative.dev/maxScale: "1"', 'autoscaling.knative.dev/maxScale: "2"'));
    let r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('maxScale')), r.problems.join('\n'));
    const cli = spawnSync(process.execPath, [SCRIPT, '--example', '--root', dir], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /maxScale/);
    edit(dir, 'deploy/gcp/service.yaml', (t) => t.replace(/ +autoscaling\.knative\.dev\/maxScale: "2"\n/, ''));
    r = checkDeploy({ root: dir, example: true });
    assert.ok(r.problems.some((p) => p.includes('maxScale')), r.problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: a recreated schedules.sh is a forbidden file (library and CLI exit 1)', () => {
  assert.deepEqual(FORBIDDEN_FILES, ['deploy/gcp/schedules.sh']);
  const dir = copyDeploy();
  try {
    writeFileSync(path.join(dir, 'deploy/gcp/schedules.sh'), '#!/usr/bin/env bash\n');
    const r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('forbidden file: deploy/gcp/schedules.sh'), r.problems.join('\n'));
    const cli = spawnSync(process.execPath, [SCRIPT, '--example', '--root', dir], { encoding: 'utf8' });
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /forbidden file/);
    assert.doesNotMatch(cli.stdout, /DEPLOY_CONFIG_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: APP_SCHEDULER_OFF "0" or APP_WORKER "1" in service.yaml is reported', () => {
  const dir = copyDeploy();
  try {
    edit(dir, 'deploy/gcp/service.yaml', (t) => t.replace(/(- name: APP_SCHEDULER_OFF\n\s+value: )"1"/, '$1"0"'));
    let r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.includes('service.yaml env APP_SCHEDULER_OFF must be 1'), r.problems.join('\n'));
    edit(dir, 'deploy/gcp/service.yaml', (t) => t.replace(/(- name: APP_WORKER\n\s+value: )"0"/, '$1"1"'));
    r = checkDeploy({ root: dir, example: true });
    assert.ok(r.problems.includes('service.yaml env APP_WORKER must be 0'), r.problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: APP_SCHEDULER_OFF missing from service.yaml is reported', () => {
  const dir = copyDeploy();
  try {
    edit(dir, 'deploy/gcp/service.yaml', (t) => t.replace(/ +- name: APP_SCHEDULER_OFF\n +value: "1"\n/, ''));
    const r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes('APP_SCHEDULER_OFF')), r.problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: scheduler text in setup.sh, README or service.yaml is reported', () => {
  assert.deepEqual(FORBIDDEN_TEXT.map(([rel]) => rel), ['deploy/gcp/setup.sh', 'deploy/README.md', 'deploy/gcp/service.yaml']);
  const dir = copyDeploy();
  try {
    edit(dir, 'deploy/gcp/setup.sh', (t) => t.replace('run.googleapis.com ', 'run.googleapis.com cloudscheduler.googleapis.com '));
    let r = checkDeploy({ root: dir, example: true });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.startsWith('forbidden text in deploy/gcp/setup.sh')), r.problems.join('\n'));
    edit(dir, 'deploy/README.md', (t) => `${t}\nbash deploy/gcp/schedules.sh\n`);
    r = checkDeploy({ root: dir, example: true });
    assert.ok(r.problems.some((p) => p.startsWith('forbidden text in deploy/README.md')), r.problems.join('\n'));
    edit(dir, 'deploy/gcp/service.yaml', (t) => `# Cloud Scheduler calls the jobs\n${t}`);
    r = checkDeploy({ root: dir, example: true });
    assert.ok(r.problems.some((p) => p.startsWith('forbidden text in deploy/gcp/service.yaml')), r.problems.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deploy-config: example ENV section lists every new first-visit variable', () => {
  const ex = parseEnvExample(readFileSync(path.join(ROOT, 'deploy/env.production.example'), 'utf8'));
  for (const k of [
    'APP_SCHEDULER_OFF', 'APP_FREE_COLLECTS', 'APP_DAY_START_MAX_MS',
    'APP_DAY_START_KICK_WAIT_MS', 'APP_DAY_START_CLAIM_TTL_MS', 'APP_DAY_START_RESET_WAIT_MS',
  ]) assert.ok(ex.ENV.includes(k), k);
});
