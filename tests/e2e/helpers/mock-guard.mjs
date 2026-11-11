// Mock servers for abuse-guard and demo E2E: a human-check verifier and a mail API that records every call.
import { startMockHttp } from './mock-ext.mjs';

/**
 * Human-check (siteverify style) mock. `setSuccess(false)` makes every verification fail.
 * @returns {Promise<{ verifyUrl: string, requests: Array<{method: string, path: string}>, setSuccess(ok: boolean): void, close(): Promise<void> }>}
 */
export async function startMockTurnstile({ success = false } = {}) {
  const mock = await startMockHttp();
  let ok = success;
  mock.set('/siteverify', () => ({ body: { success: ok } }));
  return {
    verifyUrl: `${mock.baseUrl}/siteverify`,
    requests: mock.requests,
    setSuccess(v) {
      ok = Boolean(v);
    },
    close: mock.close,
  };
}

/**
 * Mail API mock that only records. Any request at all means the app tried to send a mail.
 * @returns {Promise<{ baseUrl: string, requests: Array<{method: string, path: string}>, close(): Promise<void> }>}
 */
export async function startMockMailApi() {
  const mock = await startMockHttp();
  mock.set('/emails', { status: 200, body: { id: 'mock-mail' } });
  return { baseUrl: mock.baseUrl, requests: mock.requests, close: mock.close };
}
