// 실제 지원사업 API 를 한 번 호출해 응답 형식을 확인한다.
// 사용: npm run smoke:live:support  (값은 .env 에서 읽는다. 키 값은 출력하지 않는다)
import { pathToFileURL } from 'node:url';
import { buildSupportUrl, normalizeResponse, resultCodeError } from '../app/modules/support/service.mjs';

const TIMEOUT_MS = 20000;

function redact(text, key) {
  let s = String(text);
  if (key) s = s.split(key).join('***').split(encodeURIComponent(key)).join('***');
  return s;
}

async function main() {
  const key = (process.env.SUPPORT_API_KEY || '').trim();
  const base = (process.env.SUPPORT_API_BASE || '').trim();
  if (!key || !base) {
    console.log('LIVE_SKIP SUPPORT_API_KEY missing');
    process.exit(2);
  }
  try {
    const res = await fetch(buildSupportUrl(base, key), { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const raw = await res.text();
    if (!res.ok) {
      console.log(`LIVE_FAIL HTTP_${res.status} ${redact(raw.slice(0, 200), key)}`);
      process.exit(1);
    }
    let data;
    try {
      data = raw.trim() === '' ? null : JSON.parse(raw);
    } catch {
      console.log(`LIVE_FAIL BAD_JSON ${redact(raw.slice(0, 200), key)}`);
      process.exit(1);
    }
    const code = resultCodeError(data);
    if (code !== null) {
      console.log(`LIVE_FAIL API_${redact(code, key)}`);
      process.exit(1);
    }
    const items = normalizeResponse(data);
    console.log(`LIVE_OK items=${items.length}`);
    process.exit(0);
  } catch (err) {
    const name = err && err.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK';
    console.log(`LIVE_FAIL ${name} ${redact(err && err.message ? err.message : String(err), key)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
