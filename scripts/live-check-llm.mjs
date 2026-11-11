// 실제 자동 요약 API 를 한 번 호출해 응답 형식을 확인한다 (synonyms 태스크, 키워드 ['조경']).
// 사용: npm run smoke:live:llm  (값은 .env 에서 읽는다. 키 값은 출력하지 않는다)
import { pathToFileURL } from 'node:url';

const DEFAULT_MODEL = 'qwen3.7-flash';
const TIMEOUT_MS = 30000;
const SYSTEM =
  'You suggest related Korean search words for public tender titles. ' +
  'Reply with JSON only: {"suggestions":[{"word":string,"forKeyword":string,"why":string}]} (at most 10, word 1-20 chars).';

function redact(text, key) {
  return key ? String(text).split(key).join('***') : String(text);
}

async function main() {
  const key = process.env.LLM_API_KEY || '';
  const base = process.env.LLM_API_BASE || '';
  if (!key || !base) {
    console.log('LIVE_SKIP LLM_API_KEY missing');
    process.exit(2);
  }
  const model = process.env.LLM_MODEL || DEFAULT_MODEL;
  const body = {
    model,
    temperature: 0,
    enable_thinking: false,
    messages: [
      { role: 'system', content: '[task:synonyms]\n' + SYSTEM },
      { role: 'user', content: JSON.stringify({ title: '추천 키워드', keywords: ['조경'], text: '' }) },
    ],
  };
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const raw = await res.text();
    if (!res.ok) {
      console.log(`LIVE_FAIL HTTP_${res.status} ${redact(raw.slice(0, 200), key)}`);
      process.exit(1);
    }
    let content;
    try {
      content = JSON.parse(raw).choices[0].message.content;
    } catch {
      console.log('LIVE_FAIL BAD_JSON response body');
      process.exit(1);
    }
    const s = String(content ?? '');
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    let data;
    try {
      data = a >= 0 && b > a ? JSON.parse(s.slice(a, b + 1)) : undefined;
    } catch {
      data = undefined;
    }
    if (!data || !Array.isArray(data.suggestions)) {
      console.log(`LIVE_FAIL SCHEMA ${redact(s.slice(0, 200), key)}`);
      process.exit(1);
    }
    console.log(`LIVE_OK model=${model} suggestions=${data.suggestions.length}`);
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
