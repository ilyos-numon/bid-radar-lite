import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';
import { shot } from './helpers/app.mjs';
import { SB, skipIfDown, startSbApp, randomEmail, signupAndVerify, toPlaywrightCookies, withOrigin } from './helpers/supabase.mjs';

// Supabase 모드: 운영 스크립트 migrate-legacy 를 실제 로컬 스택에서 처음 실행한다
const PASSWORD = 'e2e-password-1';
const ADMIN_KEY = 'e2e-admin-key-91c4';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

let browser;
const cleanups = [];

function admin(args, env) {
  const r = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning', 'scripts/platform-admin.mjs', ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 90000,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('sb admin', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });
  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('sb-admin: migrate-legacy moves a single-company install into an account workspace', { skip: skipIfDown, timeout: 180000 }, async () => {
    // a. 옛 판의 SQLite 파일: 대표 + 구성원 2명. 앱은 이제 SQLite 를 쓰지 않으므로 옛 스키마의 필요한 표만 직접 만든다
    const legacyDir = mkdtempSync(path.join(tmpdir(), 'br-legacy-copy-'));
    cleanups.push(async () => rmSync(legacyDir, { recursive: true, force: true }));
    const seed = new DatabaseSync(path.join(legacyDir, 'legacy.sqlite'));
    try {
      seed.exec(`
        CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE members (id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('owner','staff')), token_hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL);
        INSERT INTO settings VALUES ('company_name', '이전 조경');
        INSERT INTO members VALUES (1, '이전대표', 'owner', 'h1', '2026-10-29T00:00:00.000Z'), (2, '구성원가', 'staff', 'h2', '2026-10-29T00:00:00.000Z'), (3, '구성원나', 'staff', 'h3', '2026-10-29T00:00:00.000Z');
      `);
    } finally {
      seed.close();
    }
    const legacyFile = path.join(legacyDir, 'legacy.sqlite');
    const countMembers = () => {
      const d = new DatabaseSync(legacyFile, { readOnly: true });
      try {
        return d.prepare('SELECT COUNT(*) AS n FROM members').get().n;
      } finally {
        d.close();
      }
    };
    assert.equal(countMembers(), 3);
    const mtimeBefore = statSync(legacyFile).mtimeMs;

    // b. Supabase 모드 대표 계정 (워크스페이스 없음)
    const app = await startSbApp();
    cleanups.push(() => app.stop());
    const ownerEmail = randomEmail('admo');
    const owner = await signupAndVerify(app.baseUrl, { email: ownerEmail, password: PASSWORD, name: '이전대표' });
    assert.equal(owner.location, '/workspaces/new');
    // 알려진 제약: 앱은 멤버십을 30초 캐시하므로 외부 이전 결과를 보려면 앱 재시작이 필요하다 (새 인스턴스로 대신한다)
    const app2 = await startSbApp();
    cleanups.push(() => app2.stop());

    // c. 스크립트 실행
    const env = {
      SUPABASE_URL: SB.url,
      SUPABASE_ANON_KEY: SB.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: SB.serviceKey,
      SUPABASE_JWT_SECRET: SB.jwtSecret,
      APP_BASE_URL: app2.baseUrl,
      APP_MAX_WORKSPACES: '100000',
      NARA_API_KEY: ADMIN_KEY,
    };
    const mig = admin(['migrate-legacy', '--db', legacyFile, '--owner-email', ownerEmail], env);
    assert.equal(mig.code, 0, `migrate exit ${mig.code}; output (no values):\n${mig.out.split(SB.serviceKey).join('***').split(ADMIN_KEY).join('***')}`);
    const links = [...mig.out.matchAll(/https?:\/\/\S+\/join\/[A-Za-z0-9_-]+/g)].map((m) => m[0]);
    assert.equal(links.length, 2, 'two invite links printed');
    assert.match(mig.out, /scripts\/migrate-sqlite\.mjs --from ".*legacy\.sqlite" --workspace /, 'output shows the data copy command');
    assert.ok(!mig.out.includes(ADMIN_KEY), 'output has no admin key');
    assert.ok(!mig.out.includes(SB.serviceKey), 'output has no service role key');
    assert.ok(!mig.out.includes(SB.anonKey), 'output has no anon key');
    assert.ok(!mig.out.includes(PASSWORD), 'output has no password');

    // d. 대표 화면
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    cleanups.push(() => ctx.close());
    await ctx.addCookies(toPlaywrightCookies(app2.baseUrl, owner.cookie));
    const page = await ctx.newPage();
    await page.goto(`${app2.baseUrl}/today`);
    assert.equal(new URL(page.url()).pathname, '/today', 'owner reaches /today without createWorkspace');
    await shot(page, 'sb-admin-today');
    await page.goto(`${app2.baseUrl}/assign/members`);
    const membersText = await page.locator('main').innerText();
    assert.ok(membersText.includes('구성원가') && membersText.includes('구성원나'), 'migrated members are listed');
    await shot(page, 'sb-admin-members');
    await page.goto(`${app2.baseUrl}/connections`);
    const connText = await page.locator('main').innerText();
    assert.match(connText, /나라장터[\s\S]*등록됨 /);
    assert.ok(!connText.includes(ADMIN_KEY), 'connections page does not show the key');
    await shot(page, 'sb-admin-connections');

    // 초대 링크 수락 (새 계정)
    const joiner = await signupAndVerify(app2.baseUrl, { email: randomEmail('admj'), password: PASSWORD, name: '구성원가' });
    const jctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    cleanups.push(() => jctx.close());
    await jctx.addCookies(toPlaywrightCookies(app2.baseUrl, joiner.cookie));
    const jpage = await jctx.newPage();
    await jpage.goto(links[0]);
    await jpage.waitForURL(/\/join\/[^/]+$/);
    await jpage.getByRole('button', { name: '들어가기' }).click();
    await jpage.waitForURL(`${app2.baseUrl}/today`);
    await shot(jpage, 'sb-admin-joined');

    // e. list 와 원본 불변
    const listed = admin(['list'], env);
    assert.equal(listed.code, 0, `list exit ${listed.code}`);
    assert.ok(listed.out.includes('이전 조경'), 'list shows the migrated workspace');
    assert.equal(countMembers(), 3, 'legacy members unchanged');
    assert.equal(statSync(legacyFile).mtimeMs, mtimeBefore, 'legacy file untouched');
  });
});
