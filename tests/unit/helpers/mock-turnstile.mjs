// 테스트용 Turnstile 검증 모의 서버(siteverify 모양). 받은 요청(form)을 기록한다. 포트 0(빈 포트), localhost 만.
// success 를 바꾸면 응답의 success 가 바뀐다. status 를 바꾸면 그 상태 코드로 답한다. delayMs 만큼 늦게 답한다.
import http from 'node:http';

/** @returns {Promise<{ url: string, requests: Array<{ method: string, path: string, form: Record<string,string> }>, success: boolean, status: number, delayMs: number, close(): Promise<void> }>} */
export async function startMockTurnstile() {
  const state = { requests: [], success: true, status: 200, delayMs: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(raw));
      state.requests.push({ method: req.method, path: req.url, form });
      const reply = () => {
        res.writeHead(state.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(state.success ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }));
      };
      if (state.delayMs > 0) setTimeout(reply, state.delayMs);
      else reply();
    });
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address();
  return Object.assign(state, {
    url: `http://localhost:${port}/turnstile/v0/siteverify`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  });
}
