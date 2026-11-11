// 앱 조립: ctx 기본 키 → 코어 파일(있으면) → app/modules/<id>/manifest.mjs 스캔·검증 → 스키마·훅·라우트
import { existsSync, readdirSync, statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDb, LEGACY_WS } from './db.mjs';
import { createRouter } from './router.mjs';
import { createHtml, GROUPS } from './html.mjs';
import { createAuth, hashInvite, MSG, MAX_MEMBERS } from './auth.mjs';
import { layeredEnv, legacyKeys } from './keys.mjs';
import { createSafeFetch, checkUrl } from './safe-fetch.mjs';
import { logger } from './log.mjs';
import { createHealth } from './health.mjs';
import { createLegalPages } from './legal/pages.mjs';
import { createHttpGuard } from './http-guard.mjs';
import { createOpsStats } from './ops/stats.mjs';
import { registerStatusRoutes } from './ops/status-routes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODULES_DIR = path.resolve(HERE, '..', 'modules');
const CORE_PARTS = ['criteria', 'bids', 'sources', 'bidtext', 'llm', 'notify', 'jobs'];
const JOB_NAMES = ['reminders', 'support'];

function createSettings(db) {
  return {
    async get(key) {
      const row = await db.get('SELECT value FROM settings WHERE key = $1', [String(key)]);
      return row ? row.value : null;
    },
    async set(key, value) {
      await db.run(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value',
        [String(key), String(value)],
      );
    },
  };
}

// 해석 없이 실패하는 lookup: 모의 fetch 를 주입한 실행(테스트)에서 저장 검사가 실제 DNS 를 쓰지 않게 한다
const offlineLookup = (host, opts, cb) => cb(Object.assign(new Error(`offline lookup: ${host}`), { code: 'ENOTFOUND' }));

/** APP_FETCH_ALLOW_HOSTS(쉼표 구분)·APP_FETCH_MAX_BYTES → safe-fetch 설정 */
export function fetchOptions(env) {
  const allowHosts = String(env.APP_FETCH_ALLOW_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const max = Number(env.APP_FETCH_MAX_BYTES);
  return { allowHosts, maxBytes: Number.isInteger(max) && max > 0 ? max : 5 * 1024 * 1024 };
}

function toMember(row) {
  return row ? { id: Number(row.id), name: row.name, role: row.role } : null;
}

// 레거시 MembersStore: members 표가 단일 출처
function createMembers(db, now, workspace) {
  return {
    async list() {
      return (await db.all('SELECT id, name, role FROM members ORDER BY id')).map(toMember);
    },
    async get(id) {
      const n = Number(id);
      if (!Number.isInteger(n)) return null;
      return toMember(await db.get('SELECT id, name, role FROM members WHERE id = $1', [n]));
    },
    async count() {
      return Number((await db.get('SELECT COUNT(*) AS n FROM members')).n);
    },
    /** @returns {Promise<{member: {id:number,name:string,role:string}, inviteToken: string}>} */
    async create({ name, role = 'staff' }) {
      const clean = String(name ?? '').trim();
      if (!clean) throw Object.assign(new Error('이름을 적지 않았습니다. 이름을 적은 뒤 다시 눌러 주세요.'), { code: 'MEMBER_NAME' });
      if (role !== 'owner' && role !== 'staff') throw Object.assign(new Error(`bad role: ${role}`), { code: 'MEMBER_ROLE' });
      if ((await this.count()) >= MAX_MEMBERS) throw Object.assign(new Error(MSG.memberLimit), { code: 'MEMBER_LIMIT' });
      const inviteToken = randomBytes(24).toString('base64url');
      const info = await db.run(
        'INSERT INTO members (name, role, token_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [clean, role, hashInvite(inviteToken), now().toISOString()],
      );
      const member = { id: Number(info.rows[0].id), name: clean, role };
      if (workspace) await registerInvite(db, workspace, member, hashInvite(inviteToken));
      return { member, inviteToken };
    },
    /** 행을 지우고 맡은 업무 분배 항목을 비운다. 지웠으면 true */
    async remove(id) {
      const n = Number(id);
      if (!Number.isInteger(n)) return false;
      const assign = await db.get("SELECT to_regclass('assign_items') IS NOT NULL AS ok");
      if (assign && assign.ok) await db.run('UPDATE assign_items SET assignee_id = NULL WHERE assignee_id = $1', [n]);
      const info = await db.run('DELETE FROM members WHERE id = $1', [n]);
      return info.rowCount > 0;
    },
  };
}

// 워크스페이스 모드: 초대를 플랫폼에 등록. 실패하면 방금 넣은 members 행을 지운다
async function registerInvite(db, workspace, member, tokenHash) {
  const rollback = () => db.run('DELETE FROM members WHERE id = $1', [member.id]);
  const fail = (cause) =>
    Object.assign(new Error('초대를 등록하지 못했습니다. 잠시 뒤 다시 시도해 주세요.'), { code: 'INVITE_REGISTER', cause });
  let result;
  try {
    result = workspace.onInvite({ memberId: member.id, name: member.name, role: member.role, tokenHash });
  } catch (err) {
    await rollback();
    throw fail(err);
  }
  // 비동기 등록은 기다리지 않는다(기존 동작 유지). 실패하면 뒤에서 행을 지우고 기록만 남긴다
  if (result && typeof result.then === 'function') {
    result.then(undefined, async (err) => {
      try {
        await rollback();
      } catch {
        // db 가 이미 닫힌 경우
      }
      logger.warn({ module: 'core', memberId: member.id, code: err && err.code ? err.code : 'error' }, 'invite register failed');
    });
  }
}

function makeClock(fakeNow) {
  const fixed = typeof fakeNow === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fakeNow) ? new Date(`${fakeNow}T12:00:00+09:00`) : null;
  const now = () => (fixed ? new Date(fixed.getTime()) : new Date());
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = () => fmt.format(now());
  return { now, today };
}

async function loadModules(modulesDir) {
  if (!existsSync(modulesDir)) return [];
  const names = readdirSync(modulesDir)
    .filter((n) => !n.startsWith('.'))
    .filter((n) => statSync(path.join(modulesDir, n)).isDirectory())
    .sort();
  const loaded = [];
  for (const dirName of names) {
    const file = path.join(modulesDir, dirName, 'manifest.mjs');
    if (!existsSync(file)) continue;
    const mod = await import(pathToFileURL(file).href);
    loaded.push({ dirName, dir: path.join(modulesDir, dirName), manifest: mod.default });
  }
  return loaded;
}

function validateModules(loaded) {
  const seen = new Map();
  for (const m of loaded) {
    const id = m.manifest && m.manifest.id;
    if (typeof id !== 'string' || id === '') throw new Error(`module manifest needs an id: ${m.dir}`);
    if (seen.has(id)) throw new Error(`duplicate module id '${id}': ${seen.get(id)} and ${m.dir}`);
    seen.set(id, m.dir);
  }
  const pickers = [];
  for (const m of loaded) {
    const mf = m.manifest;
    if (mf.id !== m.dirName) throw new Error(`module id '${mf.id}' must equal its directory name '${m.dirName}': ${m.dir}`);
    if (typeof mf.title !== 'string' || mf.title === '') throw new Error(`module '${mf.id}' needs a title: ${m.dir}`);
    if (typeof mf.path !== 'string' || !mf.path.startsWith('/')) throw new Error(`module '${mf.id}' needs a path starting with '/': ${m.dir}`);
    if (!GROUPS.includes(mf.group)) throw new Error(`module '${mf.id}' group must be one of ${GROUPS.join(', ')}: ${m.dir}`);
    if (typeof mf.routes !== 'function') throw new Error(`module '${mf.id}' needs routes(router, ctx): ${m.dir}`);
    if (mf.jobs) {
      for (const k of Object.keys(mf.jobs)) {
        if (!JOB_NAMES.includes(k)) throw new Error(`module '${mf.id}' job '${k}' is not one of ${JOB_NAMES.join(', ')}: ${m.dir}`);
      }
    }
    if (typeof mf.pickMaybe === 'function') pickers.push(m);
  }
  if (pickers.length > 1) {
    throw new Error(`only one module may define pickMaybe: ${pickers.map((p) => p.dir).join(' and ')}`);
  }
}

function sortMenus(list) {
  return list.sort(
    (a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.order - b.order || a.id.localeCompare(b.id),
  );
}

/**
 * @param {{ dbPath?: string, db?: object, modulesDir?: string, secret: string, jobToken: string, env?: Record<string,string|undefined>, fetchImpl?: typeof fetch, fakeNow?: string, coreDir?: string, workspace?: { id: string, memberFrom(req: Request): object|null|Promise<object|null>, onInvite(i: object): void, keys: object, members?: object } }} opts
 *   dbPath ':memory:' → PGlite 메모리, 그 밖 문자열 → PGlite 데이터 디렉토리. db 를 주면 그것을 쓰고 닫지 않는다
 * @returns {Promise<{ ctx: object, router: object, hooks: object, modules: object[], close(): Promise<void> }>}
 */
export async function createRuntime({
  dbPath,
  db: givenDb,
  modulesDir = DEFAULT_MODULES_DIR,
  secret,
  jobToken,
  env = process.env,
  fetchImpl,
  fakeNow,
  coreDir = HERE,
  workspace,
} = {}) {
  if (!dbPath && !givenDb) throw new Error('dbPath or db is required');
  if (!secret) throw new Error('secret is required');
  if (!jobToken) throw new Error('jobToken is required');
  if (workspace) {
    if (typeof workspace.id !== 'string' || workspace.id === '') throw new Error('workspace.id is required');
    if (typeof workspace.memberFrom !== 'function') throw new Error('workspace.memberFrom is required');
    if (typeof workspace.onInvite !== 'function') throw new Error('workspace.onInvite is required');
    if (!workspace.keys) throw new Error('workspace.keys is required');
  }

  const db = givenDb ?? (await openDb(dbPath === ':memory:' ? { memory: true } : { dataDir: dbPath }));
  let closing = null;
  const close = () => {
    if (!closing) closing = givenDb ? Promise.resolve() : db.close();
    return closing;
  };

  try {
    const { now, today } = makeClock(fakeNow ?? env.APP_FAKE_NOW);
    /** @type {Array<{id:string,title:string,group:string,order:number,path:string,help:string}>} */
    const menus = [];
    const hooks = {
      decorate: [],
      notifyLines: [],
      afterMatch: [],
      pickMaybe: null,
      jobs: { reminders: [], support: [] },
      adapters: [],
    };

    // 모의 fetch 를 주입하면 그대로 쓴다. 기본(또는 전역 fetch)은 내부 네트워크를 막는 safeFetch
    const fetchOpts = fetchOptions(env);
    const injected = typeof fetchImpl === 'function' && fetchImpl !== globalThis.fetch;
    const ctx = {
      db,
      now,
      today,
      env: workspace ? layeredEnv(env, workspace.keys) : env,
      keys: workspace ? workspace.keys : legacyKeys(),
      fetch: injected ? fetchImpl : createSafeFetch(fetchOpts),
      /** 저장 전 주소 검사 → { ok, host } | { ok:false, code, message } */
      checkUrl: (url) => checkUrl(url, { allowHosts: fetchOpts.allowHosts, ...(injected ? { lookup: offlineLookup } : {}) }),
      hooks,
      log(moduleId, message, fields) {
        logger.info({ ...(fields && typeof fields === 'object' ? fields : {}), module: moduleId }, `[${moduleId}] ${message}`);
      },
    };
    ctx.settings = createSettings(db);
    ctx.members = workspace && workspace.members ? workspace.members : createMembers(db, now, workspace);
    // 요금제 한도·결제: 가입 모드는 tenant 가 workspace 로 넣는다. 기존 모드는 ctx.limits 를 두지 않는다
    // (ctx.limits 가 없으면 한도 검사 생략·알림 이메일 5개 상한 — unlimitedLimits 를 넣으면 5개 상한이 사라진다)
    if (workspace?.limits) ctx.limits = workspace.limits;
    ctx.billing = workspace?.billing ?? null;
    // 예시 회사 표시·일일 예산: 가입 모드에서 tenant 가 넣는다. 없으면 null
    ctx.demo = workspace?.demo ?? null;
    ctx.budget = workspace?.budget ?? null;
    // 무료 가져오기 횟수: 가입 모드에서 tenant 가 넣는다. 기존 모드는 null
    ctx.credits = workspace?.credits ?? null;
    ctx.html = createHtml({
      menus: () => menus,
      companyName: () => ctx.settings.get('company_name'),
      logoutPost: Boolean(workspace),
      env,
      ...(typeof workspace?.banner === 'function' ? { banner: workspace.banner } : {}),
    });

    const auth = createAuth({ ctx, secret });
    ctx.auth = {
      required: auth.required,
      /** x-job-token 헤더가 jobToken 과 같은지 */
      checkJob(req) {
        const given = req.headers.get('x-job-token');
        return typeof given === 'string' && given === String(jobToken);
      },
    };

    // memberFrom 은 비동기일 수 있다. 실패는 비로그인(null)으로 본다
    const baseMemberFrom = workspace ? workspace.memberFrom : auth.memberFrom;
    const memberFrom = (req) => Promise.resolve().then(() => baseMemberFrom(req)).catch(() => null);
    const router = createRouter({
      ctx,
      memberFrom,
      onNotFound: async (req, member) =>
        ctx.html.page(404, {
          title: '페이지 없음',
          body: `${ctx.html.error('찾는 페이지가 없습니다', '위 메뉴에서 골라 주세요')}<p><a href="/today">오늘의 공고</a></p>`,
          member: await member,
        }),
      onError: async (err, req, member) => {
        ctx.log('core', `error ${new URL(req.url).pathname}: ${err && err.stack ? err.stack : err}`);
        return ctx.html.page(500, {
          title: '문제가 생겼습니다',
          body: `${ctx.html.error('화면을 열지 못했습니다', '잠시 뒤 다시 시도해 주세요')}<p><a href="/today">오늘의 공고</a></p>`,
          member: await member,
        });
      },
    });
    // 기존 모드: 요청 본문 크기 상한 (가입 모드는 tenant 앱이 앞에서 건다)
    if (!workspace) router.use(createHttpGuard({ db, env }).bodyLimit());
    // 라우터는 member 를 Promise 로 넘긴다. 핸들러에는 기다린 값을 준다 (forModule 도 이 get/post 를 쓴다)
    for (const method of ['get', 'post']) {
      const register = router[method];
      router[method] = (p, handler) => {
        if (typeof handler !== 'function') return register(p, handler);
        register(p, async (req, params, c, member) => handler(req, params, c, await member));
        return router;
      };
    }

    // 1) 코어 파일: 있으면 create(ctx) 결과를 합친다 (이 순서 고정)
    for (const name of CORE_PARTS) {
      const file = path.join(coreDir, `${name}.mjs`);
      if (!existsSync(file)) continue;
      const part = await import(pathToFileURL(file).href);
      if (typeof part.create !== 'function') throw new Error(`core file ${file} must export create(ctx)`);
      const added = await part.create(ctx);
      if (added && typeof added === 'object') Object.assign(ctx, added);
    }
    // 이메일 알림 채널(가입 모드 전용). 코어 파트(notify·settings) 뒤에 만든다
    ctx.emailAlerts = workspace?.emailAlerts ? workspace.emailAlerts(ctx) : { deliver: async () => ({ sent: false, reason: 'no_target' }) };

    // 2) 모듈 스캔·검증
    const loaded = await loadModules(path.resolve(modulesDir));
    validateModules(loaded);
    const ordered = [...loaded].sort(
      (a, b) => (a.manifest.order ?? 999) - (b.manifest.order ?? 999) || a.manifest.id.localeCompare(b.manifest.id),
    );

    // manifest.when(ctx) 가 false 인 모듈은 메뉴·훅·라우트를 등록하지 않는다
    const active = ordered.filter((m) => typeof m.manifest.when !== 'function' || m.manifest.when(ctx) === true);

    // 3) 모듈 스키마 (코어 스키마는 openDb 에서 먼저 적용됨). Postgres 는 마이그레이션이 만든다
    if (db.kind === 'pglite') {
      for (const m of loaded) {
        if (m.manifest.schema) await db.applySchema(m.manifest.schema);
      }
    }

    // 4) 메뉴·훅·어댑터
    for (const m of active) {
      const mf = m.manifest;
      const id = mf.id;
      menus.push({ id, title: mf.title, group: mf.group, order: Number(mf.order ?? 999), path: mf.path, help: mf.help ?? '' });
      if (typeof mf.decorate === 'function') hooks.decorate.push({ id, fn: mf.decorate });
      if (typeof mf.notifyLines === 'function') hooks.notifyLines.push({ id, fn: mf.notifyLines });
      if (typeof mf.afterMatch === 'function') hooks.afterMatch.push({ id, fn: mf.afterMatch });
      if (typeof mf.pickMaybe === 'function') hooks.pickMaybe = { id, fn: mf.pickMaybe };
      for (const name of JOB_NAMES) {
        if (mf.jobs && typeof mf.jobs[name] === 'function') hooks.jobs[name].push({ id, fn: mf.jobs[name] });
      }
      if (Array.isArray(mf.adapters)) hooks.adapters.push(...mf.adapters);
    }
    sortMenus(menus);

    // 5) 코어 라우트
    router.get('/healthz', () => Response.json({ status: 'ok' }));
    // 기존 모드: /readyz 는 db 만 점검 (가입 모드는 tenant 가 앞에서 받는다)
    if (!workspace) {
      const health = createHealth({ db, mode: 'legacy' });
      router.get('/readyz', () => health.response());
      // 공개 서비스 현황 (가입 모드는 tenant 가 앞에서 받는다)
      const stats = createOpsStats({
        db,
        workspaceIds: async () => [LEGACY_WS],
        readiness: async () => (await health.readyz()).status === 'ok',
        now,
      });
      registerStatusRoutes(router, { stats, page: (status, opts) => ctx.html.page(status, opts) });
    }
    // 워크스페이스 모드: 계정 화면(/setup /join /welcome /me /logout)은 플랫폼 라우트가 가진다
    if (workspace) router.get('/', () => ctx.html.redirect('/today'));
    else router.get('/', async (req, params, c, member) => {
      if (!member) return ctx.html.redirect((await ctx.members.count()) === 0 ? '/setup' : '/welcome');
      if (menus.some((m) => m.id === 'today')) return ctx.html.redirect('/today');
      return ctx.html.redirect(menus.length > 0 ? menus[0].path : '/welcome');
    });
    if (!workspace) auth.registerRoutes(router);
    // 기존 모드: 약관·개인정보처리방침 (가입 모드는 플랫폼 라우트가 가진다). 수신거부는 가입 모드 전용
    if (!workspace) {
      const legal = createLegalPages({ env, html: ctx.html });
      router.get('/terms', () => legal.terms());
      router.get('/privacy', () => legal.privacy());
    }

    const jobsFile = path.join(coreDir, 'routes-jobs.mjs');
    if (existsSync(jobsFile)) {
      const rj = await import(pathToFileURL(jobsFile).href);
      if (typeof rj.registerRoutes !== 'function') throw new Error(`core file ${jobsFile} must export registerRoutes(router, ctx)`);
      await rj.registerRoutes(router, ctx);
    }

    // 6) 모듈 라우트 (자기 path 와 /api/<id>/ 만)
    for (const m of active) {
      await m.manifest.routes(router.forModule(m.manifest), ctx);
    }

    const modules = active.map((m) => ({ ...m.manifest, dir: m.dir }));
    return { ctx, router, hooks, modules, close };
  } catch (err) {
    await close();
    throw err;
  }
}
