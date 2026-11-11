// 데모 라우트: 가입 없이 예시 회사로 들어가는 POST /demo/login 과 매일 초기화 GET /api/jobs/demo-reset.
// APP_DEMO 가 '1' 이 아니면 둘 다 404. 데모 비밀번호는 응답·로그에 쓰지 않는다.
import { createHtml } from '../html.mjs';
import { kstDate } from '../day-start.mjs';
import { landingView } from '../platform-views.mjs';
import { DEMO_TEXT } from './fixture.mjs';
import { demoEmails, demoEnabled, demoPassword } from './seed.mjs';

const notFound = () => Response.json({ error: 'not_found' }, { status: 404 });

/** 응답 헤더를 고칠 수 있도록 복사하고 Set-Cookie 를 덧붙인다 */
function withCookies(res, cookies) {
  const list = (cookies ?? []).filter(Boolean);
  if (list.length === 0) return res;
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: new Headers(res.headers) });
  for (const c of list) out.headers.append('set-cookie', c);
  return out;
}

/** 양의 정수 환경변수(없거나 잘못되면 기본값) */
function intEnv(v, dflt) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : dflt;
}

function errorCode(err) {
  const code = err && typeof err.code === 'string' ? err.code : '';
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'error';
}

/**
 * @param {import('hono').Hono} app
 * @param {{ env: Record<string, string|undefined>, platform: object, demo: object, guard?: { ipLimiter(name: string): Function } | null,
 *   budget?: { take(kind: string): Promise<{ ok: boolean }> } | null, wsCookie: (id: string) => string, jobAuthorized: (req: Request) => boolean,
 *   dayStart?: { enabled: boolean, touch(kind: string, origin: string|null, opts?: { waitMs?: number }): Promise<object> } | null }} deps
 *   dayStart 가 켜져 있으면(예약 실행 없음 모드) 로그인 때 오늘 초기화가 안 됐으면 초기화를 걸고 잠깐 기다린다
 */
export function registerDemoRoutes(app, { env = {}, platform, demo, guard, budget, wsCookie, jobAuthorized, dayStart = null }) {
  const enabled = () => demoEnabled(env);
  const plain = createHtml({ menus: () => [], logoutPost: true, env });
  const landing = (status, message) => plain.page(status, landingView({ message }));
  const limiter = guard && typeof guard.ipLimiter === 'function' ? guard.ipLimiter('demoLogin') : null;

  // 꺼져 있으면 속도 규칙보다 먼저 404
  const gate = async (c, next) => {
    if (!enabled()) return notFound();
    if (limiter) return limiter(c, next);
    return next();
  };

  app.post('/demo/login', gate, async (c) => {
    if (budget && typeof budget.take === 'function') {
      const b = await budget.take('demoLogin');
      if (!b || !b.ok) return landing(429, DEMO_TEXT.closed);
    }
    // 예약 실행 없음: 오늘 아직 초기화(또는 최초 생성) 전이면 초기화 잡을 부르고 최대 APP_DAY_START_RESET_WAIT_MS 기다린다
    if (dayStart?.enabled) {
      try {
        const s = await demo.status();
        const today = kstDate(new Date());
        if (!s || !s.seededAt || kstDate(new Date(s.seededAt)) !== today) {
          await dayStart.touch('demoReset', null, { waitMs: intEnv(env.APP_DAY_START_RESET_WAIT_MS, 20000) });
        }
      } catch {
        // 초기화를 못 걸어도 로그인은 이어 간다(아래에서 준비 중이면 503)
      }
    }
    const demoWs = await demo.workspaceId();
    if (!demoWs) return landing(503, DEMO_TEXT.preparing);
    let r;
    try {
      r = await platform.auth.signIn({ email: demoEmails(env).owner, password: demoPassword(env.APP_SECRET) });
    } catch {
      r = null;
    }
    if (!r || !r.ok) return landing(503, DEMO_TEXT.preparing);
    const cookies = [...(r.setCookies ?? []), wsCookie(demoWs)];
    return withCookies(new Response(null, { status: 303, headers: { location: '/today' } }), cookies);
  });

  app.get('/api/jobs/demo-reset', async (c) => {
    if (!enabled()) return notFound();
    if (!jobAuthorized(c.req.raw)) return c.json({ error: 'forbidden' }, 403);
    try {
      return c.json(await demo.reset(), 200);
    } catch (err) {
      return c.json({ ok: false, error: errorCode(err) }, 500);
    }
  });
}
