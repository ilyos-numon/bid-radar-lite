// In-process mock servers for app E2E tests. All listen on port 0.
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closer(server) {
  let closed = false;
  return () =>
    new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Generic HTTP mock. Unknown paths answer 404 `{}`.
 * @returns {Promise<{ baseUrl: string, set(path: string, opts: ((req: object, query: Record<string,string>) => {status?: number, body?: string|Buffer|object, contentType?: string}) | {status?: number, body?: string|Buffer|object, contentType?: string}): void, requests: Array<{method: string, path: string, query: Record<string,string>}>, close(): Promise<void> }>}
 */
export async function startMockHttp() {
  const routes = new Map();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    await readBody(req).catch(() => Buffer.alloc(0));
    const u = new URL(req.url, 'http://localhost');
    requests.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams) });
    const r = routes.get(u.pathname);
    if (!r) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    // 함수형 라우트: handler(req, query) => {status, body, contentType}
    const out = typeof r === 'function' ? { status: 200, contentType: 'application/json', ...(await r(req, Object.fromEntries(u.searchParams))) } : r;
    const body =
      typeof out.body === 'string' || Buffer.isBuffer(out.body) ? out.body : out.body === undefined ? '' : JSON.stringify(out.body);
    res.writeHead(out.status, { 'content-type': out.contentType });
    res.end(body);
  });
  const port = await listen(server);
  return {
    baseUrl: `http://localhost:${port}`,
    set(p, opts = {}) {
      if (typeof opts === 'function') {
        routes.set(p, opts);
        return;
      }
      const { status = 200, body, contentType = 'application/json' } = opts;
      routes.set(p, { status, body, contentType });
    },
    requests,
    close: closer(server),
  };
}

/**
 * Mock chat-completions endpoint. Picks `${fixtureDir}/${task}.${bidId}.json`, then `${task}.default.json`, else 500.
 * @param {{ fixtureDir: string }} opts
 * @returns {Promise<{ baseUrl: string, calls: Array<{task: string|null, bidId: string|null}>, close(): Promise<void> }>}
 */
export async function startMockLlm({ fixtureDir }) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const raw = await readBody(req).catch(() => Buffer.alloc(0));
    const u = new URL(req.url, 'http://localhost');
    if (req.method !== 'POST' || u.pathname !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    let task = null;
    let bidId = null;
    try {
      const body = JSON.parse(raw.toString('utf8'));
      const messages = Array.isArray(body.messages) ? body.messages : [];
      const system = messages.find((m) => m.role === 'system');
      const firstLine = String(system?.content ?? '').split('\n')[0];
      const m = /^\[task:([^\]]+)\]/.exec(firstLine);
      task = m ? m[1] : null;
      const user = messages.find((x) => x.role === 'user');
      try {
        const input = JSON.parse(String(user?.content ?? ''));
        bidId = input && input.bidId !== undefined && input.bidId !== null ? String(input.bidId) : null;
      } catch {
        bidId = null;
      }
    } catch {
      // not JSON; falls through to 500 below
    }
    calls.push({ task, bidId });
    const candidates = [];
    if (task && bidId) candidates.push(path.join(fixtureDir, `${task}.${bidId}.json`));
    if (task) candidates.push(path.join(fixtureDir, `${task}.default.json`));
    const file = candidates.find((f) => existsSync(f));
    if (!file) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no fixture', task, bidId }));
      return;
    }
    const content = readFileSync(file, 'utf8');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] }));
  });
  const port = await listen(server);
  return { baseUrl: `http://localhost:${port}`, calls, close: closer(server) };
}
