// 공고 요약: 순수 로직과 저장

export const STATUSES = ['ready', 'unverified', 'no_text', 'failed'];
export const FIELDS = ['what', 'qualification', 'documents'];
export const MAX_LEN = 200;
const MAX_TEXT = 12000;

/** 요약 요청 지시문 (화면에 나가지 않는다) */
export const INSTRUCTIONS = [
  '당신은 공공 입찰 공고문을 읽고 세 줄로 정리하는 도우미입니다.',
  '입력 JSON 의 text 는 공고문 첨부에서 뽑은 원문입니다. 원문에 있는 내용만 씁니다. 추측하지 않습니다.',
  '다음 JSON 하나만 돌려줍니다:',
  '{"what":"무슨 사업인지 한 문장","qualification":"참가에 필요한 자격 한 문장","documents":"제출 서류 한 문장","evidence":[{"field":"what|qualification|documents","quote":"원문에서 그대로 옮긴 짧은 구절"}]}',
  '각 문장은 200자 이하입니다. evidence 는 세 항목마다 최소 1개씩, quote 는 원문 글자를 바꾸지 않고 그대로 옮깁니다.',
  '원문에 없는 항목은 "공고문에 적혀 있지 않음" 이라고 쓰고 그 항목의 evidence 는 넣지 않습니다.',
  '입찰서나 제안서는 쓰지 않습니다.',
].join('\n');

/**
 * 요약 응답 data 검사
 * @param {any} data
 * @returns {string[]} 오류 목록 (빈 배열이면 통과)
 */
export function validateSummary(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['data must be an object'];
  for (const f of FIELDS) {
    const v = data[f];
    if (typeof v !== 'string' || v.trim() === '') errors.push(`${f} missing`);
    else if (v.length > MAX_LEN) errors.push(`${f} longer than ${MAX_LEN}`);
  }
  if (!Array.isArray(data.evidence) || data.evidence.length === 0) {
    errors.push('evidence needs at least one item');
  } else {
    data.evidence.forEach((e, i) => {
      if (!e || typeof e !== 'object') {
        errors.push(`evidence[${i}] must be an object`);
        return;
      }
      if (!FIELDS.includes(e.field)) errors.push(`evidence[${i}].field invalid`);
      if (typeof e.quote !== 'string' || e.quote.trim() === '') errors.push(`evidence[${i}].quote missing`);
    });
  }
  return errors;
}

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** 응답 결과 → 저장할 행 */
export function rowFromResult(result) {
  if (!result || !result.ok) {
    return { status: 'failed', what: null, qualification: null, documents: null, evidence: null, error: String((result && result.error) || 'ERROR') };
  }
  const d = result.data;
  const missing = new Set((result.missingQuotes || []).map(norm));
  const evidence = d.evidence.map((e) => ({ field: e.field, quote: String(e.quote), found: !missing.has(norm(e.quote)) }));
  return {
    status: result.verified ? 'ready' : 'unverified',
    what: d.what,
    qualification: d.qualification,
    documents: d.documents,
    evidence,
    error: null,
  };
}

/** @param {object} ctx */
export function createStore(ctx) {
  const db = ctx.db;
  return {
    /** @returns {null | {bidId, status, what, qualification, documents, evidence: Array<{field,quote,found}>, error, updatedAt}} */
    async get(bidId) {
      const row = await db.get('SELECT * FROM summary_items WHERE bid_id = $1', [String(bidId)]);
      if (!row) return null;
      let evidence = [];
      try {
        evidence = row.evidence ? JSON.parse(row.evidence) : [];
      } catch {
        evidence = [];
      }
      return {
        bidId: row.bid_id,
        status: row.status,
        what: row.what,
        qualification: row.qualification,
        documents: row.documents,
        evidence: Array.isArray(evidence) ? evidence : [],
        error: row.error,
        updatedAt: row.updated_at,
      };
    },
    async save(bidId, r) {
      await db.run(
        `INSERT INTO summary_items (bid_id, status, what, qualification, documents, evidence, error, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, bid_id) DO UPDATE SET status = excluded.status, what = excluded.what,
           qualification = excluded.qualification, documents = excluded.documents,
           evidence = excluded.evidence, error = excluded.error, updated_at = excluded.updated_at`,
        [
          String(bidId),
          r.status,
          r.what ?? null,
          r.qualification ?? null,
          r.documents ?? null,
          r.evidence ? JSON.stringify(r.evidence) : null,
          r.error ?? null,
          ctx.now().toISOString(),
        ],
      );
    },
  };
}

const errText = (err) => (err && err.message ? err.message : String(err));

/**
 * 공고 하나 요약. 원문이 없으면 호출 없이 no_text, 실패는 failed.
 * @returns {Promise<string|null>} 저장한 상태. 공고가 없으면 null
 */
export async function summarize(ctx, bidId) {
  const store = createStore(ctx);
  const bid = await ctx.bids.get(bidId);
  if (!bid) return null;
  let row;
  try {
    const t = await ctx.bidText.get(bid.bidId);
    const text = t && t.status === 'ok' ? String(t.text ?? '').slice(0, MAX_TEXT) : '';
    if (text.trim() === '') {
      row = { status: 'no_text', error: t && t.status ? String(t.status) : null };
    } else {
      const result = await ctx.llm.complete({
        task: 'summary',
        system: INSTRUCTIONS,
        input: { bidId: bid.bidId, title: bid.title, org: bid.org ?? undefined, text },
        schema: validateSummary,
        textForEvidence: text,
      });
      row = rowFromResult(result);
      if (!result.ok) ctx.log('summary', `summary ${bid.bidId} failed: ${result.error}${result.detail ? ' ' + result.detail : ''}`);
    }
  } catch (err) {
    ctx.log('summary', `summary ${bid.bidId} error: ${errText(err)}`);
    row = { status: 'failed', error: 'ERROR' };
  }
  await store.save(bid.bidId, row);
  return row.status;
}

/** afterMatch 대상: matched + maybe (중복 제거) */
export function targetsOf(matched, maybe) {
  const ids = [];
  for (const m of [...(Array.isArray(matched) ? matched : []), ...(maybe ? [maybe] : [])]) {
    if (m && m.bidId && !ids.includes(m.bidId)) ids.push(m.bidId);
  }
  return ids;
}

/** 일일 매칭 뒤: 이미 ready 는 건너뛰고, 하나가 실패해도 나머지는 계속 */
export async function afterMatch(ctx, { matched, maybe, dry } = {}) {
  if (dry) return;
  const store = createStore(ctx);
  for (const bidId of targetsOf(matched, maybe)) {
    try {
      const cur = await store.get(bidId);
      if (cur && cur.status === 'ready') continue;
      await summarize(ctx, bidId);
    } catch (err) {
      ctx.log('summary', `afterMatch ${bidId} error: ${errText(err)}`);
    }
  }
}
