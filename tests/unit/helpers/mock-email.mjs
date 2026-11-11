// 테스트용 이메일 API 모의 서버(Resend `POST /emails` 모양). 받은 요청을 기록한다. 포트 0(빈 포트).
// 헤더 `x-mock-fail: 1` 이거나 failNext > 0 이면 500.
import http from 'node:http';

/** @returns {Promise<{ url: string, requests: Array<{ method: string, path: string, headers: object, body: any }>, failNext: number, close(): Promise<void> }>} */
export async function startMockEmail() {
  const state = { requests: [], failNext: 0 };
  let seq = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      state.requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (req.method !== 'POST' || req.url !== '/emails') return send(404, { name: 'not_found' });
      if (req.headers['x-mock-fail'] === '1' || state.failNext > 0) {
        if (state.failNext > 0) state.failNext -= 1;
        return send(500, { name: 'internal_server_error' });
      }
      seq += 1;
      return send(200, { id: `mock-email-${seq}` });
    });
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address();
  return Object.assign(state, {
    url: `http://localhost:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  });
}
