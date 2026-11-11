// Hono 래퍼. 핸들러는 (req: Request, params, ctx, member) → Response 형태만 안다.
import { Hono } from 'hono';

/**
 * @param {{ ctx: object, memberFrom: (req: Request) => object|null, onNotFound: (req: Request, member: object|null) => Response, onError: (err: Error, req: Request, member: object|null) => Response }} deps
 */
export function createRouter({ ctx, memberFrom, onNotFound, onError }) {
  const app = new Hono();

  function safeMember(req) {
    try {
      return memberFrom(req);
    } catch {
      return null;
    }
  }

  function wrap(handler) {
    return async (c) => {
      const req = c.req.raw;
      const member = safeMember(req);
      return handler(req, c.req.param(), ctx, member);
    };
  }

  function check(path, handler) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`route path must start with '/': ${path}`);
    if (typeof handler !== 'function') throw new Error(`route handler must be a function: ${path}`);
  }

  const router = {
    get(path, handler) {
      check(path, handler);
      app.get(path, wrap(handler));
      return router;
    },
    post(path, handler) {
      check(path, handler);
      app.post(path, wrap(handler));
      return router;
    },
    /**
     * 모듈 전용 라우터: 자기 path 아래와 /api/<id>/ 아래만 등록할 수 있다.
     * @param {{id:string, path:string}} mod
     */
    forModule(mod) {
      const base = mod.path.replace(/\/+$/, '');
      const api = `/api/${mod.id}`;
      const allowed = (p) => p === base || p.startsWith(base + '/') || p === api || p.startsWith(api + '/');
      const guard = (method) => (path, handler) => {
        if (typeof path !== 'string' || !allowed(path)) {
          throw new Error(`module '${mod.id}' may not register ${method.toUpperCase()} ${path} (allowed: ${base}, ${api}/)`);
        }
        router[method](path, handler);
        return scoped;
      };
      const scoped = { get: guard('get'), post: guard('post') };
      return scoped;
    },
    /** 모든 경로에 거는 Hono 미들웨어. 라우트보다 먼저 불러야 한다 */
    use(middleware) {
      if (typeof middleware !== 'function') throw new Error('middleware must be a function');
      app.use('*', middleware);
      return router;
    },
    fetch: (request, env, executionCtx) => app.fetch(request, env, executionCtx),
  };

  app.notFound((c) => onNotFound(c.req.raw, safeMember(c.req.raw)));
  app.onError((err, c) => onError(err, c.req.raw, safeMember(c.req.raw)));

  return router;
}
