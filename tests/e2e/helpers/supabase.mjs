// Supabase-mode E2E helpers. The local stack (`supabase start`) is read from `supabase status -o env`.
// Never print key values. Use `{ skip: skipIfDown }` as a node:test option when the stack is not running.
import { after } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { startApp } from './app.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAIL_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 8;

function parseEnv(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

function probe() {
  const down = { up: false, url: '', anonKey: '', serviceKey: '', jwtSecret: '', mailUrl: '', dbUrl: '' };
  let r;
  try {
    r = spawnSync('supabase', ['status', '-o', 'env'], { cwd: ROOT, encoding: 'utf8', timeout: 5000 });
  } catch {
    return down;
  }
  if (!r || r.status !== 0 || !r.stdout) return down;
  const e = parseEnv(r.stdout);
  const url = e.API_URL ?? '';
  const anonKey = e.ANON_KEY ?? '';
  const serviceKey = e.SERVICE_ROLE_KEY ?? '';
  const mailUrl = e.MAILPIT_URL || e.INBUCKET_URL || '';
  if (!url || !anonKey || !serviceKey || !mailUrl) return down;
  return { up: true, url, anonKey, serviceKey, jwtSecret: e.JWT_SECRET ?? '', mailUrl, dbUrl: e.DB_URL ?? '' };
}

/** @type {{ up: boolean, url: string, anonKey: string, serviceKey: string, jwtSecret: string, mailUrl: string, dbUrl: string }} */
export const SB = probe();

export const skipIfDown = SB.up ? false : 'supabase local stack is not running (run: supabase start)';

/**
 * startApp with SUPABASE_* from the local stack and APP_SHARED_KEYS=0.
 * The app reaches the shared Postgres as app_worker (startApp builds APP_DB_URL from `supabase status`).
 * @param {{ env?: Record<string,string> }} [opts]
 * @returns {Promise<{ baseUrl: string, stop(): Promise<void> }>}
 */
export async function startSbApp({ env = {} } = {}) {
  if (!SB.up) throw new Error(String(skipIfDown));
  // 속도 제한 횟수는 공유 Postgres(rate_limits)에 15분 동안 남는다. 앞선 실행의 횟수가 이 테스트를 막지 않게 비운다
  await withPg(adminDbUrl(), (c) => c.query('DELETE FROM public.rate_limits'));
  return startApp({
    env: {
      SUPABASE_URL: SB.url,
      SUPABASE_ANON_KEY: SB.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: SB.serviceKey,
      SUPABASE_JWT_SECRET: SB.jwtSecret,
      APP_SHARED_KEYS: '0',
      APP_MAX_WORKSPACES: '100000',
      ...env,
    },
  });
}

/** Connection string for the local Postgres as a given role (built at run time from `supabase status`; never logged). */
function dbUrlAs(user, password) {
  if (!SB.up || !SB.dbUrl) throw new Error(String(skipIfDown));
  const u = new URL(SB.dbUrl);
  if (user) {
    u.username = user;
    u.password = password;
  }
  return u.toString();
}

/** Superuser connection string (to check rows regardless of RLS) */
export const adminDbUrl = () => dbUrlAs();

/** app_worker connection string (RLS applies; set `app.workspace_id` per transaction) */
export const workerDbUrl = () => dbUrlAs('app_worker', 'app_worker');

/**
 * Run `fn(client)` on a fresh pg connection and close it afterwards.
 * @template T
 * @param {string} url @param {(client: import('pg').Client) => Promise<T>} fn @returns {Promise<T>}
 */
export async function withPg(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Addresses this test process created (strings only). cleanupCreatedUsers() deletes exactly these users.
const createdEmails = new Set();

/** @returns {string} e2e-<tag>-<hex6>@example.com */
export function randomEmail(tag) {
  const email = `e2e-${tag}-${randomBytes(3).toString('hex')}@example.com`;
  createdEmails.add(email);
  return email;
}

/**
 * Delete the auth users whose address this process created (randomEmail / signupAndVerify).
 * Workspaces, members and keys go with them (on delete cascade + Vault trigger). Never prints addresses or keys.
 * @returns {Promise<number>} number of users deleted
 */
export async function cleanupCreatedUsers() {
  if (!SB.up || createdEmails.size === 0) return 0;
  const admin = createClient(SB.url, SB.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const ids = [];
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.status ?? ''}`);
    const users = data?.users ?? [];
    for (const u of users) if (u.email && createdEmails.has(u.email.toLowerCase())) ids.push(u.id);
    if (users.length < perPage) break;
  }
  let deleted = 0;
  for (const id of ids) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (!error) deleted += 1;
  }
  createdEmails.clear();
  if (deleted < ids.length) process.stderr.write(`warning: e2e cleanup deleted ${deleted} of ${ids.length} test user(s)\n`);
  return deleted;
}

// Each test file runs in its own process, so this root hook runs once per file after all its suites.
// Cleanup failure never fails the run; it leaves one warning line on stderr.
after(async () => {
  try {
    await cleanupCreatedUsers();
  } catch {
    process.stderr.write('warning: e2e cleanup failed (deleted 0 test user(s))\n');
  }
});

/** init + Origin header (hono/csrf rejects form POSTs without it) */
export function withOrigin(baseUrl, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set('origin', new URL(baseUrl).origin);
  return { ...init, headers };
}

// --- cookie jar ("a=1; b=2") ------------------------------------------------
function parseJar(cookie) {
  const jar = new Map();
  for (const part of String(cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    jar.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return jar;
}

function mergeSetCookies(jar, res) {
  for (const sc of res.headers.getSetCookie()) {
    const first = sc.split(';')[0];
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    const expired = /;\s*max-age=0\b/i.test(sc) || /;\s*expires=thu, 01 jan 1970/i.test(sc);
    if (expired || value === '') jar.delete(name);
    else jar.set(name, value);
  }
  return jar;
}

const jarString = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** Playwright cookies for context.addCookies() from a "a=1; b=2" string */
export function toPlaywrightCookies(baseUrl, cookie) {
  return [...parseJar(cookie)].map(([name, value]) => ({ name, value, url: baseUrl, httpOnly: true, sameSite: 'Lax' }));
}

// --- mail -------------------------------------------------------------------
function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function firstLink(text, html) {
  const fromText = /https?:\/\/[^\s"'<>)\]]+/.exec(String(text ?? ''));
  if (fromText) return decodeEntities(fromText[0]);
  const fromHref = /href="(https?:\/\/[^"]+)"/i.exec(String(html ?? ''));
  return fromHref ? decodeEntities(fromHref[1]) : null;
}

async function mailpitLatest(email, subjectIncludes) {
  const q = new URLSearchParams({ query: `to:"${email}"` });
  const res = await fetch(`${SB.mailUrl}/api/v1/search?${q}`);
  if (!res.ok) return { api: res.status === 404 ? 'missing' : 'ok', link: null };
  const body = await res.json();
  const list = (body.messages ?? [])
    .filter((m) => !subjectIncludes || String(m.Subject ?? '').includes(subjectIncludes))
    .sort((a, b) => String(b.Created ?? '').localeCompare(String(a.Created ?? '')));
  if (list.length === 0) return { api: 'ok', link: null };
  const msg = await (await fetch(`${SB.mailUrl}/api/v1/message/${encodeURIComponent(list[0].ID)}`)).json();
  return { api: 'ok', link: firstLink(msg.Text, msg.HTML) };
}

// Inbucket (older CLI): /api/v1/mailbox/<local part>
async function inbucketLatest(email, subjectIncludes) {
  const box = encodeURIComponent(email.split('@')[0]);
  const res = await fetch(`${SB.mailUrl}/api/v1/mailbox/${box}`);
  if (!res.ok) return null;
  const list = (await res.json())
    .filter((m) => !subjectIncludes || String(m.subject ?? '').includes(subjectIncludes))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  if (list.length === 0) return null;
  const msg = await (await fetch(`${SB.mailUrl}/api/v1/mailbox/${box}/${encodeURIComponent(list[0].id)}`)).json();
  return firstLink(msg.body?.text, msg.body?.html);
}

/**
 * Newest mail to `email` (optionally with subject containing subjectIncludes) → first http(s) link. Polls 10s.
 * @returns {Promise<string>}
 */
export async function latestMailLink(email, { subjectIncludes } = {}) {
  const deadline = Date.now() + MAIL_TIMEOUT_MS;
  let api = 'unknown';
  while (Date.now() < deadline) {
    try {
      const r = await mailpitLatest(email, subjectIncludes);
      api = r.api;
      if (r.link) return r.link;
      if (api === 'missing') {
        const link = await inbucketLatest(email, subjectIncludes);
        if (link) return link;
      }
    } catch {
      // the mail server may still be starting; keep polling
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no mail link for ${email} within ${MAIL_TIMEOUT_MS}ms (api: ${api})`);
}

/**
 * Follow redirects by hand, sending the app cookie jar only to the app origin.
 * @returns {Promise<{ jar: Map<string,string>, location: string|null, status: number }>}
 */
async function follow(startUrl, baseUrl, jar) {
  const appOrigin = new URL(baseUrl).origin;
  let url = startUrl;
  for (let i = 0; i < MAX_REDIRECTS; i += 1) {
    const sameApp = new URL(url).origin === appOrigin;
    const headers = sameApp && jar.size ? { cookie: jarString(jar) } : {};
    const res = await fetch(url, { redirect: 'manual', headers });
    if (sameApp) mergeSetCookies(jar, res);
    const loc = res.headers.get('location');
    await res.arrayBuffer().catch(() => {});
    if (!loc || res.status < 300 || res.status >= 400) return { jar, location: null, status: res.status, url };
    const next = new URL(loc, url).href;
    // stop once the app has answered the callback with its own redirect
    if (sameApp && new URL(url).pathname === '/auth/callback') return { jar, location: new URL(next).pathname + new URL(next).search, status: res.status, url };
    url = next;
  }
  throw new Error(`too many redirects from ${startUrl}`);
}

async function postForm(baseUrl, pathname, fields, cookie = '') {
  const init = withOrigin(baseUrl, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual' });
  if (cookie) init.headers.set('cookie', cookie);
  return fetch(`${baseUrl}${pathname}`, init);
}

/**
 * POST /signup, open the confirmation mail link (manual redirects) and return the session cookie.
 * `location` is where the app sent the user after the callback (normally /workspaces/new).
 * @returns {Promise<{ cookie: string, location: string|null }>}
 */
export async function signupAndVerify(baseUrl, { email, password, name }) {
  createdEmails.add(String(email).toLowerCase());
  const res = await postForm(baseUrl, '/signup', { email, password, name, agree_terms: '1', agree_privacy: '1' });
  const body = await res.text();
  if (res.status !== 303) throw new Error(`signup failed: status ${res.status} ${body.slice(0, 200)}`);
  const jar = mergeSetCookies(new Map(), res);
  const link = await latestMailLink(email, { subjectIncludes: '가입 확인' });
  const out = await follow(link, baseUrl, jar);
  if (!out.location) throw new Error(`mail link did not reach /auth/callback (last status ${out.status})`);
  return { cookie: jarString(out.jar), location: out.location };
}

/** @returns {Promise<{ cookie: string }>} */
export async function login(baseUrl, { email, password }) {
  const res = await postForm(baseUrl, '/login', { email, password });
  const body = await res.text();
  if (res.status !== 303) throw new Error(`login failed: status ${res.status} ${body.slice(0, 200)}`);
  return { cookie: jarString(mergeSetCookies(new Map(), res)) };
}

/** POST /workspaces/new → cookie including br_ws. @returns {Promise<{ cookie: string, workspaceId: string }>} */
export async function createWorkspace(baseUrl, cookie, { company, name }) {
  const res = await postForm(baseUrl, '/workspaces/new', { company, name }, cookie);
  const body = await res.text();
  if (res.status !== 303) throw new Error(`createWorkspace failed: status ${res.status} ${body.slice(0, 200)}`);
  const jar = mergeSetCookies(parseJar(cookie), res);
  return { cookie: jarString(jar), workspaceId: jar.get('br_ws') ?? '' };
}
