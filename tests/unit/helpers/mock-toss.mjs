// 테스트용 모의 토스페이먼츠 서버 (in-process http, 빈 포트). 받은 요청을 requests 에 기록한다.
// POST /v1/billing/authorizations/issue — authKey 가 'bad_' 로 시작하면 400 INVALID_AUTH_KEY
// POST /v1/billing/:billingKey          — amount === failAmount 이거나 헤더 x-mock-fail 이면 400 REJECT_CARD
//                                         같은 Idempotency-Key 로 다시 오면 처음 응답을 그대로 돌려준다(실제 토스 동작)
// GET  /v1/payments/:paymentKey         — 기록된 결제(없으면 404 NOT_FOUND_PAYMENT)
import http from 'node:http';

export const FAIL_AMOUNT = 13;

/**
 * @param {{ failAmount?: number }} [opts]
 * @returns {Promise<{ base: string, requests: object[], payments: Map<string, object>, failAmount: number, close(): Promise<void> }>}
 */
export async function startMockToss({ failAmount = FAIL_AMOUNT } = {}) {
  const requests = [];
  const payments = new Map();
  const replies = new Map();
  let seq = 0;
  const state = { failAmount };

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = null;
      }
      const url = new URL(req.url, 'http://mock');
      const path = decodeURIComponent(url.pathname);
      requests.push({ method: req.method, path, headers: req.headers, body });
      if (req.method === 'POST' && path === '/v1/billing/authorizations/issue') {
        if (!body?.authKey || String(body.authKey).startsWith('bad_')) return send(res, 400, { code: 'INVALID_AUTH_KEY', message: 'invalid' });
        seq += 1;
        return send(res, 200, {
          mId: 'tosspayments',
          customerKey: body.customerKey,
          billingKey: `bk_mock_${seq}`,
          cardCompany: '신한',
          cardNumber: '43301234****1234',
          card: { issuerCode: '41', number: '43301234****1234', cardType: '신용' },
          authenticatedAt: new Date().toISOString(),
        });
      }
      const charge = req.method === 'POST' ? path.match(/^\/v1\/billing\/([^/]+)$/) : null;
      if (charge) {
        const idem = req.headers['idempotency-key'];
        if (idem && replies.has(idem)) return send(res, ...replies.get(idem));
        const reply = (status, out) => {
          if (idem) replies.set(idem, [status, out]);
          return send(res, status, out);
        };
        if (Number(body?.amount) === Number(state.failAmount) || req.headers['x-mock-fail']) return reply(400, { code: 'REJECT_CARD', message: 'rejected' });
        seq += 1;
        const p = {
          paymentKey: `pk_mock_${seq}`,
          orderId: body?.orderId,
          status: 'DONE',
          approvedAt: new Date().toISOString(),
          totalAmount: Number(body?.amount),
          billingKey: charge[1],
        };
        payments.set(p.paymentKey, p);
        return reply(200, p);
      }
      const get = req.method === 'GET' ? path.match(/^\/v1\/payments\/([^/]+)$/) : null;
      if (get) {
        const p = payments.get(get[1]);
        return p ? send(res, 200, p) : send(res, 404, { code: 'NOT_FOUND_PAYMENT', message: 'not found' });
      }
      return send(res, 404, { code: 'NOT_FOUND', message: 'unknown route' });
    });
  });
  await new Promise((resolve) => server.listen(0, 'localhost', resolve));
  const { port } = server.address();
  return {
    base: `http://localhost:${port}`,
    requests,
    payments,
    get failAmount() {
      return state.failAmount;
    },
    set failAmount(v) {
      state.failAmount = v;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
