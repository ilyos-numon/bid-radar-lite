// 하루(KST) 비용 예산: 이메일·자동 요약·가입·데모 로그인 횟수. rate_limits 표에 날짜별 행 하나로 센다
import { rateKey } from './rate-store.mjs';

export const BUDGET_KINDS = { email: 'APP_DAILY_MAX_EMAIL', llm: 'APP_DAILY_MAX_LLM', signup: 'APP_DAILY_MAX_SIGNUP', demoLogin: 'APP_DAILY_MAX_DEMO_LOGIN' };
export const BUDGET_DEFAULTS = { email: 200, llm: 200, signup: 50, demoLogin: 500 };
export const BUDGET_TEXT = { llm: '오늘 자동 요약 한도를 다 썼습니다', signup: '오늘 가입 접수를 마감했습니다. 내일 다시 시도해 주세요.' };

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// rate-store 의 증가 문장과 같고, 1 대신 n 만큼 더한다
const INCREMENT_SQL = `INSERT INTO rate_limits (key, hits, reset_at)
  VALUES ($1, $3::integer, now() + ($2::double precision * interval '1 millisecond'))
  ON CONFLICT (key) DO UPDATE SET
    hits = CASE WHEN rate_limits.reset_at <= now() THEN $3::integer ELSE rate_limits.hits + $3::integer END,
    reset_at = CASE WHEN rate_limits.reset_at <= now() THEN excluded.reset_at ELSE rate_limits.reset_at END
  RETURNING hits, reset_at`;
const GET_SQL = 'SELECT hits FROM rate_limits WHERE key = $1 AND reset_at > now()';

/**
 * @param {{ db: { admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, env?: Record<string,string|undefined>, now?: () => Date }} deps
 */
export function createBudget({ db, env = {}, now = () => new Date() } = {}) {
  if (!db || typeof db.admin !== 'function') throw new Error('db is required');

  const kindOf = (kind) => {
    if (!Object.hasOwn(BUDGET_KINDS, kind)) throw new Error(`unknown budget kind: ${kind}`);
    return kind;
  };
  // 비었거나 숫자가 아니면 기본값, 0 은 무제한
  const maxOf = (kind) => {
    const raw = String(env[BUDGET_KINDS[kind]] ?? '').trim();
    const n = Number(raw);
    return raw !== '' && Number.isInteger(n) && n >= 0 ? n : BUDGET_DEFAULTS[kind];
  };

  /** @param {Date} d @returns {string} YYYY-MM-DD (KST) */
  function kstDate(d) {
    return new Date(d.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
  }
  // 다음 KST 자정까지 남은 ms
  const untilMidnight = (d) => {
    const shifted = d.getTime() + KST_OFFSET_MS;
    const next = Math.floor(shifted / DAY_MS) * DAY_MS + DAY_MS;
    return Math.max(1, next - shifted);
  };
  const keyOf = (kind, d) => rateKey(`budget:${kind}:${kstDate(d)}`);

  return {
    kstDate,
    /** @returns {Promise<{ ok: boolean, used: number, max: number }>} */
    async take(kind, { n = 1 } = {}) {
      kindOf(kind);
      const max = maxOf(kind);
      if (max === 0) return { ok: true, used: 0, max: 0 };
      const count = Number.isInteger(n) && n > 0 ? n : 1;
      const d = now();
      const r = await db.admin(INCREMENT_SQL, [keyOf(kind, d), untilMidnight(d), count]);
      const hits = Number(r.rows[0].hits);
      return { ok: hits <= max, used: Math.min(hits, max), max };
    },
    /** @returns {Promise<{ used: number, max: number }>} */
    async peek(kind) {
      kindOf(kind);
      const max = maxOf(kind);
      if (max === 0) return { used: 0, max: 0 };
      const r = await db.admin(GET_SQL, [keyOf(kind, now())]);
      const hits = r.rows[0] ? Number(r.rows[0].hits) : 0;
      return { used: Math.min(hits, max), max };
    },
  };
}
