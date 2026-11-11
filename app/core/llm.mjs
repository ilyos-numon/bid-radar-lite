// 자동 요약용 외부 호출 + 근거 인용 검증
const DEFAULT_MODEL = 'qwen3.7-flash';
const DEFAULT_TIMEOUT_MS = 60000;

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 첫 '{' ~ 마지막 '}' 를 JSON 으로 읽는다. 실패하면 undefined */
function extractJson(content) {
  const s = String(content ?? '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return undefined;
  }
}

/** data.evidence[*].quote 가 원문에 들어 있는지 (공백 정규화 후 includes) */
function checkEvidence(data, textForEvidence) {
  if (textForEvidence === null || textForEvidence === undefined) return { verified: true, missingQuotes: [] };
  const hay = norm(textForEvidence);
  const list = data && Array.isArray(data.evidence) ? data.evidence : [];
  const missingQuotes = [];
  for (const e of list) {
    const q = norm(e && e.quote);
    if (!q || !hay.includes(q)) missingQuotes.push(String((e && e.quote) ?? ''));
  }
  return { verified: missingQuotes.length === 0, missingQuotes };
}

/** @param {{env: Record<string,string|undefined>, fetch: typeof fetch, demo?: object|null, budget?: { take(kind: string): Promise<{ ok: boolean }> }|null}} ctx */
export function create(ctx) {
  const llm = {
    /**
     * @param {{task:string, system:string, input:object, schema?:(data:any)=>string[], textForEvidence?:string|null}} opts
     * @returns {Promise<{ok:true,data:any,verified:boolean,missingQuotes:string[]}|{ok:false,error:string,detail?:string}>}
     */
    async complete({ task, system, input, schema, textForEvidence = null }) {
      // 데모 회사는 외부 호출 없이 거절, 하루 예산을 넘으면 거절
      if (ctx.demo) return { ok: false, error: 'DEMO' };
      if (ctx.budget && !(await ctx.budget.take('llm')).ok) return { ok: false, error: 'BUDGET' };
      const env = ctx.env || {};
      const base = String(env.LLM_API_BASE || '').trim();
      const key = String(env.LLM_API_KEY || '').trim();
      if (!base || !key) return { ok: false, error: 'NO_KEY' };
      const model = String(env.LLM_MODEL || '').trim() || DEFAULT_MODEL;
      const t = Number(env.LLM_TIMEOUT_MS);
      const timeoutMs = Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS;

      const body = {
        model,
        temperature: 0,
        enable_thinking: false,
        messages: [
          { role: 'system', content: `[task:${task}]\n` + String(system ?? '') },
          { role: 'user', content: JSON.stringify(input ?? {}) },
        ],
      };

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      let res;
      let raw;
      try {
        res = await ctx.fetch(`${base.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal: ac.signal,
        });
        raw = await res.text();
      } catch (err) {
        if (ac.signal.aborted) return { ok: false, error: 'TIMEOUT' };
        return { ok: false, error: 'NETWORK', detail: err && err.message ? String(err.message).slice(0, 200) : undefined };
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) return { ok: false, error: `HTTP_${res.status}`, detail: String(raw ?? '').slice(0, 200) };

      let content;
      try {
        const j = JSON.parse(raw);
        content = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : undefined;
      } catch {
        return { ok: false, error: 'BAD_JSON', detail: 'response body is not JSON' };
      }
      const data = extractJson(content);
      if (data === undefined) return { ok: false, error: 'BAD_JSON', detail: String(content ?? '').slice(0, 200) };

      if (typeof schema === 'function') {
        let errors;
        try {
          errors = schema(data);
        } catch (err) {
          errors = [err && err.message ? err.message : String(err)];
        }
        if (Array.isArray(errors) && errors.length > 0) return { ok: false, error: 'SCHEMA', detail: errors.join('; ') };
      }

      const { verified, missingQuotes } = checkEvidence(data, textForEvidence);
      return { ok: true, data, verified, missingQuotes };
    },
  };
  return { llm };
}
