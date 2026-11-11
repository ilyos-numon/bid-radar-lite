// 운영 배포 설정 검사. 의존성 없음 (service.yaml 은 정규식으로 name:/key: 만 읽는다).
// node scripts/check-deploy.mjs [--example | --env <file>]  → 맞으면 DEPLOY_CONFIG_OK exit 0, 아니면 빠진 항목 나열 exit 1
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEPLOY_FILES = [
  'deploy/README.md',
  'deploy/env.production.example',
  'deploy/gcp/service.yaml',
  'deploy/gcp/setup.sh',
  'deploy/supabase/PRODUCTION.md',
];

// 예약 실행 인프라를 쓰지 않는다: 이 파일이 다시 생기거나 아래 문구가 들어가면 오류
// (문자열을 쪼개 적는 것은 저장소 grep 검사에 이 파일 자체가 걸리지 않게 하려는 것)
const SCHED = 'sched' + 'ule';
export const FORBIDDEN_FILES = [`deploy/gcp/${SCHED}s.sh`];
export const FORBIDDEN_TEXT = [
  ['deploy/gcp/setup.sh', new RegExp(`cloud${SCHED}r`, 'i')],
  ['deploy/README.md', new RegExp(`${SCHED}s\\.sh|Cloud S${SCHED.slice(1)}r`)],
  ['deploy/gcp/service.yaml', new RegExp(`S${SCHED.slice(1)}r`)],
];

// service.yaml 평문 env 가 반드시 이 값이어야 하는 것
export const ENV_VALUE_RULES = { APP_SCHEDULER_OFF: '1', APP_WORKER: '0' };

export const REQUIRED_SECRETS = [
  'APP_SECRET',
  'APP_JOB_TOKEN',
  'SUPABASE_SERVICE_ROLE_KEY',
  'APP_DB_URL',
  'TOSS_SECRET_KEY',
  'EMAIL_API_KEY',
  'NARA_API_KEY',
  'LLM_API_KEY',
  'SUPPORT_API_KEY',
  'TURNSTILE_SECRET_KEY',
];

// 운영 env 에 반드시 있어야 하고 service.yaml 에도 평문 env 로 있어야 하는 이름
export const REQUIRED_ENV = [
  'APP_BASE_URL',
  'APP_TRUST_PROXY',
  'APP_COOKIE_SECURE',
  'APP_LOG_LEVEL',
  'APP_WORKER',
  'APP_SCHEDULER_OFF',
  'APP_FREE_COLLECTS',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'TOSS_CLIENT_KEY',
  'TOSS_API_BASE',
  'APP_TRIAL_DAYS',
  'APP_BILLING_RETRY_DAYS',
  'EMAIL_API_BASE',
  'EMAIL_FROM',
  'LEGAL_TERMS_VERSION',
  'LEGAL_PRIVACY_VERSION',
  'BUSINESS_NAME',
  'BUSINESS_REP',
  'BUSINESS_REG_NO',
  'BUSINESS_MAIL_ORDER_NO',
  'BUSINESS_ADDRESS',
  'BUSINESS_EMAIL',
  'BUSINESS_PHONE',
  'PRIVACY_OFFICER',
  'APP_DEMO',
  'APP_DEMO_EMAIL_DOMAIN',
  'APP_PLATFORM_ADMIN_EMAILS',
  'TURNSTILE_SITE_KEY',
  'APP_DAILY_MAX_EMAIL',
  'APP_DAILY_MAX_LLM',
  'APP_DAILY_MAX_SIGNUP',
  'APP_DAILY_MAX_DEMO_LOGIN',
  'APP_RATE_SCALE',
  'APP_BODY_LIMIT_BYTES',
  'APP_REQUEST_TIMEOUT_MS',
];

// 유휴 비용을 0 에 가깝게: 인스턴스 0 까지 줄이고 요청이 없을 때 CPU 를 받지 않는다
export const SCALE_RULES = {
  'autoscaling.knative.dev/minScale': '0',
  'run.googleapis.com/cpu-throttling': 'true',
};
const MAX_SCALE_KEY = 'autoscaling.knative.dev/maxScale';
const MAX_SCALE_LIMIT = 1;

export const REQUIRED_DEPLOY = ['GCP_PROJECT_ID', 'GCP_REGION', 'GCP_WIF_PROVIDER', 'GCP_DEPLOY_SA', 'CLOUD_RUN_SERVICE', 'ARTIFACT_REPO'];

const KEY_RE = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/;

// 일반 .env 형식의 키 목록
export function parseEnvKeys(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = KEY_RE.exec(line);
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// env.production.example 의 구역(# === NAME)별 키 목록
export function parseEnvExample(text) {
  const out = { SECRET: [], ENV: [], DEPLOY: [], UNUSED: [] };
  let section = null;
  for (const line of text.split(/\r?\n/)) {
    const s = /^#\s*===\s*([A-Z]+)\s*$/.exec(line);
    if (s) {
      section = s[1];
      if (!out[section]) out[section] = [];
      continue;
    }
    if (/^\s*#/.test(line) || section === null) continue;
    const m = KEY_RE.exec(line);
    if (m) out[section].push(m[1]);
  }
  return out;
}

// service.yaml 의 env: 평문 이름·값(따옴표 제거)과 secretKeyRef (env 이름, 비밀 이름) 쌍
export function parseServiceEnv(text) {
  const plain = [];
  const secrets = [];
  const values = {};
  let current = null; // 가장 최근 `- name: X`
  let inRef = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const item = /^\s*-\s+name:\s*["']?([A-Za-z0-9_]+)["']?\s*$/.exec(line);
    if (item) {
      current = item[1];
      inRef = false;
      continue;
    }
    const val = /^\s*value:\s*(?:"([^"]*)"|'([^']*)'|(\S.*?))?\s*$/.exec(line);
    if (current && val) {
      plain.push(current);
      values[current] = val[1] ?? val[2] ?? val[3] ?? '';
      current = null;
      continue;
    }
    if (current && /^\s*secretKeyRef:\s*$/.test(line)) {
      inRef = true;
      continue;
    }
    const ref = /^\s*name:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/.exec(line);
    if (current && inRef && ref) {
      secrets.push({ env: current, secret: ref[1] });
      current = null;
      inRef = false;
    }
  }
  return { plain, secrets, values };
}

// service.yaml 의 annotations: 블록 안 `key: value` (따옴표 제거). 같은 키가 여러 번이면 마지막 값
export function parseServiceAnnotations(text) {
  const out = {};
  let indent = -1; // annotations: 줄의 들여쓰기. -1 이면 블록 밖
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const lead = line.length - line.trimStart().length;
    if (/^\s*annotations:\s*$/.test(line)) {
      indent = lead;
      continue;
    }
    if (indent < 0) continue;
    if (lead <= indent) {
      indent = -1;
      continue;
    }
    const m = /^\s*([A-Za-z0-9_.\/-]+):\s*(?:"([^"]*)"|'([^']*)'|(\S.*?))?\s*$/.exec(line);
    if (m) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}

function missing(need, have) {
  const set = new Set(have);
  return need.filter((k) => !set.has(k));
}

export function checkDeploy({ root = ROOT, example = false, envFile = null } = {}) {
  const problems = [];
  for (const rel of DEPLOY_FILES) {
    if (!existsSync(path.join(root, rel))) problems.push(`missing file: ${rel}`);
  }
  for (const rel of FORBIDDEN_FILES) {
    if (existsSync(path.join(root, rel))) problems.push(`forbidden file: ${rel}`);
  }
  for (const [rel, re] of FORBIDDEN_TEXT) {
    const p = path.join(root, rel);
    if (existsSync(p) && re.test(readFileSync(p, 'utf8'))) problems.push(`forbidden text in ${rel}: ${re.source}`);
  }
  const exPath = path.join(root, 'deploy/env.production.example');
  const svcPath = path.join(root, 'deploy/gcp/service.yaml');
  if (!existsSync(exPath) || !existsSync(svcPath)) return { ok: false, problems };

  const ex = parseEnvExample(readFileSync(exPath, 'utf8'));
  const svcText = readFileSync(svcPath, 'utf8');
  const svc = parseServiceEnv(svcText);

  const ann = parseServiceAnnotations(svcText);
  for (const [name, value] of Object.entries(SCALE_RULES)) {
    if (ann[name] !== value) problems.push(`service.yaml annotation ${name} must be ${value}`);
  }
  const maxScale = Number(ann[MAX_SCALE_KEY]);
  if (!Number.isInteger(maxScale) || maxScale < 1 || maxScale > MAX_SCALE_LIMIT) {
    problems.push(`service.yaml annotation ${MAX_SCALE_KEY} must be <= ${MAX_SCALE_LIMIT}`);
  }
  for (const [name, value] of Object.entries(ENV_VALUE_RULES)) {
    if (svc.values[name] !== value) problems.push(`service.yaml env ${name} must be ${value}`);
  }

  for (const k of missing(REQUIRED_SECRETS, ex.SECRET)) problems.push(`env.production.example SECRET section lacks: ${k}`);
  for (const k of missing(ex.SECRET, REQUIRED_SECRETS)) problems.push(`env.production.example SECRET section has unexpected: ${k}`);

  for (const { env, secret } of svc.secrets) {
    if (env !== secret) problems.push(`service.yaml secretKeyRef for ${env} points at ${secret} (must be ${env})`);
  }
  const refNames = svc.secrets.filter((s) => s.env === s.secret).map((s) => s.env);
  for (const k of missing(ex.SECRET, refNames)) problems.push(`service.yaml lacks secretKeyRef: ${k}`);
  for (const k of missing(refNames, ex.SECRET)) problems.push(`service.yaml secretKeyRef not in example SECRET section: ${k}`);

  for (const k of missing(svc.plain, ex.ENV)) problems.push(`service.yaml env not in example ENV section: ${k}`);
  for (const k of missing(REQUIRED_ENV, svc.plain)) problems.push(`service.yaml lacks env: ${k}`);
  for (const k of svc.plain.filter((k) => REQUIRED_SECRETS.includes(k))) problems.push(`service.yaml has secret as plain env: ${k}`);

  const need = [...REQUIRED_SECRETS, ...REQUIRED_ENV];
  if (example) {
    for (const k of missing(need, [...ex.SECRET, ...ex.ENV])) problems.push(`env.production.example lacks: ${k}`);
    for (const k of missing(REQUIRED_DEPLOY, ex.DEPLOY)) problems.push(`env.production.example DEPLOY section lacks: ${k}`);
  }
  if (envFile) {
    if (!existsSync(envFile)) problems.push(`missing env file: ${envFile}`);
    else for (const k of missing(need, parseEnvKeys(readFileSync(envFile, 'utf8')))) problems.push(`${path.basename(envFile)} lacks: ${k}`);
  }
  return { ok: problems.length === 0, problems };
}

export function main(argv) {
  let example = false;
  let envFile = null;
  let root = ROOT;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--example') example = true;
    else if (argv[i] === '--env') envFile = argv[++i] ?? null;
    else if (argv[i] === '--root') root = path.resolve(argv[++i] ?? ROOT);
  }
  if (!example && !envFile) {
    console.error('usage: node scripts/check-deploy.mjs [--example | --env <file>]');
    return 2;
  }
  const r = checkDeploy({ root, example, envFile: envFile ? path.resolve(envFile) : null });
  if (!r.ok) {
    for (const p of r.problems) console.log(`MISSING ${p}`);
    console.log(`deploy config failed: ${r.problems.length} problem(s)`);
    return 1;
  }
  console.log('DEPLOY_CONFIG_OK');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
