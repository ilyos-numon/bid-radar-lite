// 서버 여러 대가 함께 쓰는 속도 제한 저장소(hono-rate-limiter Store, Postgres rate_limits 표)와 클라이언트 IP 키
import { createHash } from 'node:crypto';

// 창이 지났으면 1부터 다시, 아니면 +1. 시각은 DB 의 now() 하나로 센다(서버 시계 차이 없음)
const INCREMENT_SQL = `INSERT INTO rate_limits (key, hits, reset_at)
  VALUES ($1, 1, now() + ($2::double precision * interval '1 millisecond'))
  ON CONFLICT (key) DO UPDATE SET
    hits = CASE WHEN rate_limits.reset_at <= now() THEN 1 ELSE rate_limits.hits + 1 END,
    reset_at = CASE WHEN rate_limits.reset_at <= now() THEN excluded.reset_at ELSE rate_limits.reset_at END
  RETURNING hits, reset_at`;
const DECREMENT_SQL = 'UPDATE rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1 AND reset_at > now()';
const GET_SQL = 'SELECT hits, reset_at FROM rate_limits WHERE key = $1 AND reset_at > now()';
const RESET_SQL = 'DELETE FROM rate_limits WHERE key = $1';

/** 저장 키: IP 원문을 남기지 않는다 */
export function rateKey(key) {
  return createHash('sha256').update(String(key)).digest('hex').slice(0, 16);
}

/**
 * @param {{ db: { admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, windowMs?: number }} opts
 *   windowMs 가 없으면 rateLimiter 옵션(init)의 windowMs
 */
export function createPgRateStore({ db, windowMs } = {}) {
  if (!db || typeof db.admin !== 'function') throw new Error('db is required');
  let win = Number(windowMs) > 0 ? Number(windowMs) : 0;
  const info = (row) => ({ totalHits: Number(row.hits), resetTime: new Date(row.reset_at) });
  return {
    localKeys: false,
    init(options) {
      if (!win && options && Number(options.windowMs) > 0) win = Number(options.windowMs);
    },
    async get(key) {
      const r = await db.admin(GET_SQL, [rateKey(key)]);
      return r.rows[0] ? info(r.rows[0]) : undefined;
    },
    async increment(key) {
      const r = await db.admin(INCREMENT_SQL, [rateKey(key), win || 60000]);
      return info(r.rows[0]);
    },
    async decrement(key) {
      await db.admin(DECREMENT_SQL, [rateKey(key)]);
    },
    async resetKey(key) {
      await db.admin(RESET_SQL, [rateKey(key)]);
    },
  };
}

/**
 * 속도 제한 키용 클라이언트 IP.
 * hops=0: 소켓 주소(@hono/node-server 의 env.incoming). hops≥1: X-Forwarded-For 를 ',' 로 나눈 배열의 [len - hops]
 * (앞에 있는 프록시 수만큼 뒤에서 센다 — 클라이언트가 앞쪽에 적은 값은 쓰지 않는다). 없으면 소켓 주소
 * @param {number|string} hops
 */
export function clientIp(hops) {
  const n = Number.isInteger(Number(hops)) && Number(hops) > 0 ? Number(hops) : 0;
  return (c) => {
    if (n > 0) {
      const fwd = c.req.header('x-forwarded-for');
      if (fwd) {
        const list = fwd.split(',').map((s) => s.trim());
        const v = list[list.length - n];
        if (v) return v;
      }
    }
    const addr = c.env && c.env.incoming && c.env.incoming.socket ? c.env.incoming.socket.remoteAddress : null;
    return addr || 'local';
  };
}
