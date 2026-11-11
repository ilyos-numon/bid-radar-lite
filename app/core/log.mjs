// 구조화 로그(pino). 비밀번호·토큰·쿠키·키 값은 redact 로 지운다
import pino from 'pino';

export const REDACT = ['password', 'token', 'authorization', 'cookie', 'apiKey', '*.password', '*.token', 'req.headers.cookie'];

/**
 * @param {{ level?: string, destination?: import('pino').DestinationStream }} [opts]
 *   level 이 없거나 pino 가 모르는 값이면 APP_LOG_LEVEL → 'info'
 */
export function createLogger({ level, destination } = {}) {
  const wanted = String(level ?? process.env.APP_LOG_LEVEL ?? '').trim();
  const opts = {
    level: wanted && (wanted === 'silent' || pino.levels.values[wanted] !== undefined) ? wanted : 'info',
    base: null,
    redact: REDACT,
  };
  // 기본 출력은 process.stdout (테스트가 process.stdout.write 로 줄을 볼 수 있다)
  return pino(opts, destination ?? process.stdout);
}

export const logger = createLogger();

/** 로그용 경로: 초대 토큰이 든 /join/<token> 은 감춘다(쿼리는 원래 남기지 않는다) */
export function safePath(pathname) {
  const p = String(pathname ?? '');
  return /^\/join\/[^/]+/.test(p) ? p.replace(/^\/join\/[^/]+/, '/join/:token') : p;
}

/** 요청 한 줄: {"msg":"request","method","path","status","ms","requestId","workspaceId"} */
export function logRequest({ method, path, status, ms, requestId, workspaceId }, log = logger) {
  const line = { method, path: safePath(path), status, ms, requestId };
  if (workspaceId) line.workspaceId = workspaceId;
  log.info(line, 'request');
}
