// 결제(토스)·이메일 모의 서버. spawnSync 등으로 메인 스레드가 막혀도 응답하도록 worker_threads 에서 돈다.
// 둘 다 빈 포트에 열고, 받은 요청을 received 배열에 쌓는다(워커 -> 메인 메시지).
// toss : POST /v1/billing/authorizations/issue (authKey 가 'bad_' 로 시작하면 400), POST /v1/billing/:billingKey,
//        GET /v1/payments/:paymentKey. setFail(true) 면 결제(POST /v1/billing/:key)가 400 REJECT_CARD.
//        결제에 같은 Idempotency-Key 로 다시 오면 처음 응답을 그대로 돌려준다(실제 토스 동작).
//        cancelPayment(paymentKey) 이후 그 결제 조회는 status CANCELED.
// email: POST /emails -> 200 { id }. setFail(true) 면 500.
import http from 'node:http';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

function start(kind) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind } });
  const received = [];
  const pending = new Map();
  let seq = 0;
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', (msg) => {
      if (msg.type === 'record') received.push(msg.value);
      else if (msg.type === 'ack') {
        pending.get(msg.id)?.();
        pending.delete(msg.id);
      } else if (msg.type === 'listening') {
        // 워커로 보낸 명령이 처리됐음을 기다린다. 메시지는 순서대로 오므로 ack 가 오면 앞선 record 도 다 도착한 것이다
        const call = (cmd) =>
          new Promise((res) => {
            seq += 1;
            pending.set(seq, res);
            worker.postMessage({ ...cmd, id: seq });
          });
        resolve({
          baseUrl: `http://localhost:${msg.port}`,
          received,
          setFail: (on) => call({ type: 'fail', on: Boolean(on) }),
          cancelPayment: (paymentKey) => call({ type: 'cancel', paymentKey }),
          sync: () => call({ type: 'ping' }),
          close: () =>
            new Promise((res) => {
              worker.once('exit', () => res());
              worker.postMessage({ type: 'close' });
            }),
        });
      }
    });
  });
}

export const startMockToss = () => start('toss');
export const startMockEmail = () => start('email');

if (!isMainThread && workerData?.kind) {
  const { kind } = workerData;
  const state = { fail: false };
  const canceled = new Set();
  const payments = new Map();
  const replies = new Map();
  let n = 0;
  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      parentPort.postMessage({ type: 'record', value: { method: req.method, path, headers: req.headers, body } });
      if (kind === 'email') {
        if (req.method !== 'POST' || path !== '/emails') return send(res, 404, { name: 'not_found' });
        if (state.fail) return send(res, 500, { name: 'internal_server_error' });
        n += 1;
        return send(res, 200, { id: `mock-email-${n}` });
      }
      if (req.method === 'POST' && path === '/v1/billing/authorizations/issue') {
        if (!body?.authKey || String(body.authKey).startsWith('bad_')) return send(res, 400, { code: 'INVALID_AUTH_KEY', message: 'invalid' });
        n += 1;
        return send(res, 200, {
          customerKey: body.customerKey,
          billingKey: `bk_mock_${n}`,
          cardCompany: '신한',
          cardNumber: '43301234****1234',
          card: { issuerCode: '41', number: '43301234****1234', cardType: '신용' },
          authenticatedAt: new Date().toISOString(),
        });
      }
      const charge = req.method === 'POST' ? /^\/v1\/billing\/([^/]+)$/.exec(path) : null;
      if (charge) {
        const idem = req.headers['idempotency-key'];
        if (idem && replies.has(idem)) return send(res, ...replies.get(idem));
        const reply = (status, out) => {
          if (idem) replies.set(idem, [status, out]);
          return send(res, status, out);
        };
        if (state.fail) return reply(400, { code: 'REJECT_CARD', message: 'rejected' });
        n += 1;
        const p = {
          paymentKey: `pk_mock_${n}`,
          orderId: body?.orderId,
          status: 'DONE',
          approvedAt: new Date().toISOString(),
          totalAmount: Number(body?.amount),
        };
        payments.set(p.paymentKey, p);
        return reply(200, p);
      }
      const get = req.method === 'GET' ? /^\/v1\/payments\/([^/]+)$/.exec(path) : null;
      if (get) {
        const p = payments.get(get[1]);
        if (!p) return send(res, 404, { code: 'NOT_FOUND_PAYMENT', message: 'not found' });
        return send(res, 200, canceled.has(p.paymentKey) ? { ...p, status: 'CANCELED' } : p);
      }
      return send(res, 404, { code: 'NOT_FOUND', message: 'unknown route' });
    });
  });
  parentPort.on('message', (msg) => {
    if (msg.type === 'fail') state.fail = msg.on;
    if (msg.type === 'cancel') canceled.add(msg.paymentKey);
    if (msg.type === 'close') {
      server.closeAllConnections?.();
      server.close(() => process.exit(0));
      return;
    }
    if (msg.id) parentPort.postMessage({ type: 'ack', id: msg.id });
  });
  server.once('error', (e) => {
    throw e;
  });
  server.listen(0, 'localhost', () => parentPort.postMessage({ type: 'listening', port: server.address().port }));
}
