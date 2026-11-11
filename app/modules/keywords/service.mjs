// 추천 키워드: 비슷한 말 제안 저장·채택/거절, 채택한 말로 관련 가능성 있는 공고 1건 (규칙만으로 고른다)
import { matchBids } from '../../../src/match.js';

export const MAYBE_SETTING = 'keywords.maybe_enabled';
export const MAX_SUGGESTIONS = 10;
export const MAX_WORD = 20;
export const STATUSES = ['suggested', 'accepted', 'rejected'];

/** 비슷한 말 제안 요청에 붙이는 지시문 */
export const SYSTEM = [
  '당신은 공공 입찰 공고 검색을 돕습니다.',
  '입력 JSON 의 keywords 는 작은 회사가 공고 제목에서 찾는 업종 키워드입니다.',
  '각 키워드와 뜻이 비슷하거나 같은 업종의 공고 제목에 자주 함께 쓰이는 짧은 말을 제안하세요.',
  '이미 keywords 에 있는 말은 제안하지 마세요. 전체 10개 이하, 각 word 는 1~20자.',
  '반드시 JSON 하나만 답하세요: {"suggestions":[{"word":"...","forKeyword":"<원래 키워드>","why":"<한 문장 이유>"}]}',
].join('\n');

const norm = (s) => String(s ?? '').trim();
const key = (s) => norm(s).toLowerCase();

/**
 * synonyms 응답 검사: suggestions 배열 ≤ 10, word 1~20자, forKeyword·why 는 문자열
 * @returns {string[]} 오류 목록 (빈 배열이면 통과)
 */
export function validateSuggestions(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.suggestions)) return ['suggestions must be an array'];
  const errors = [];
  if (data.suggestions.length > MAX_SUGGESTIONS) errors.push(`suggestions must have at most ${MAX_SUGGESTIONS} items`);
  data.suggestions.forEach((s, i) => {
    if (!s || typeof s !== 'object') {
      errors.push(`suggestions[${i}] must be an object`);
      return;
    }
    if (typeof s.word !== 'string') errors.push(`suggestions[${i}].word must be a string`);
    else {
      const len = [...norm(s.word)].length;
      if (len < 1 || len > MAX_WORD) errors.push(`suggestions[${i}].word must be 1-${MAX_WORD} chars`);
    }
    if (typeof s.forKeyword !== 'string') errors.push(`suggestions[${i}].forKeyword must be a string`);
    if (typeof s.why !== 'string') errors.push(`suggestions[${i}].why must be a string`);
  });
  return errors;
}

function toRow(r) {
  return { word: r.word, forKeyword: r.for_keyword ?? '', why: r.why ?? '', status: r.status, createdAt: r.created_at ?? '' };
}

/** @returns {Promise<Array<{word:string, forKeyword:string, why:string, status:string, createdAt:string}>>} */
export async function listSynonyms(db, status) {
  const rows = status
    ? await db.all('SELECT * FROM keywords_synonyms WHERE status = $1 ORDER BY created_at, word', [status])
    : await db.all('SELECT * FROM keywords_synonyms ORDER BY created_at, word');
  return rows.map(toRow);
}

/**
 * 제안을 suggested 로 저장한다. 표에 이미 있는 말·지금 키워드와 같은 말·같은 응답 안의 중복은 건너뛴다.
 * @returns {Promise<{added: string[], skipped: string[]}>}
 */
export async function saveSuggestions(db, suggestions, currentKeywords, nowIso) {
  const taken = new Set((currentKeywords || []).map(key));
  for (const r of await db.all('SELECT word FROM keywords_synonyms')) taken.add(key(r.word));
  const insert = (...params) =>
    db.run(
      "INSERT INTO keywords_synonyms (word, for_keyword, why, status, created_at) VALUES ($1, $2, $3, 'suggested', $4) ON CONFLICT (workspace_id, word) DO NOTHING",
      params,
    );
  const added = [];
  const skipped = [];
  for (const s of suggestions || []) {
    const word = norm(s && s.word);
    if (word === '' || taken.has(key(word))) {
      skipped.push(word);
      continue;
    }
    taken.add(key(word));
    await insert(word, norm(s.forKeyword), norm(s.why), nowIso);
    added.push(word);
  }
  return { added, skipped };
}

/** @returns {Promise<boolean>} 바꾼 행이 있으면 true */
export async function setStatus(db, word, status) {
  if (!STATUSES.includes(status)) throw new Error(`bad status: ${status}`);
  const info = await db.run('UPDATE keywords_synonyms SET status = $1 WHERE word = $2', [status, norm(word)]);
  return Number(info.rowCount) > 0;
}

/** 설정값이 'false' 일 때만 꺼짐 (기본 켜짐) */
export async function maybeEnabled(settings) {
  return (await settings.get(MAYBE_SETTING)) !== 'false';
}

export async function setMaybeEnabled(settings, on) {
  await settings.set(MAYBE_SETTING, on ? 'true' : 'false');
}

/**
 * 제안 받기: 지금 키워드로 비슷한 말을 요청하고 저장한다. 실패하면 표를 건드리지 않는다.
 * @returns {Promise<{ok:true, added:string[], skipped:string[]}|{ok:false, error:string}>}
 */
export async function requestSuggestions(ctx) {
  const keywords = ((await ctx.criteria.get()).keywords || []).map(norm).filter(Boolean);
  const res = await ctx.llm.complete({
    task: 'synonyms',
    system: SYSTEM,
    input: { keywords },
    schema: validateSuggestions,
    textForEvidence: null,
  });
  if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'UNKNOWN' };
  const { added, skipped } = await saveSuggestions(ctx.db, res.data.suggestions, keywords, ctx.now().toISOString());
  return { ok: true, added, skipped };
}

/** reasons 의 키워드 일치 줄을 '직접 일치 없음' + 유사어 줄로 바꾸고 지역·예산 줄은 그대로 둔다 */
export function rewriteReasons(reasons, accepted) {
  const kwReason = /^키워드 '(.*)' 일치$/;
  const rest = [];
  let word = null;
  for (const r of reasons || []) {
    const m = kwReason.exec(r);
    if (m) {
      if (word === null) word = m[1];
    } else rest.push(r);
  }
  if (word === null) return [...(reasons || [])];
  const row = accepted.find((a) => a.word === word);
  const forKeyword = row ? row.forKeyword : '';
  return ['키워드 직접 일치 없음', `유사어 '${word}' 포함 (키워드 '${forKeyword}' 의 비슷한 말)`, ...rest];
}

/**
 * 일일 잡 훅: 조건에 안 맞은 공고 중 채택한 말로 1건
 * @returns {Promise<import('../../../src/match.js').MatchedBid|null>}
 */
export async function pickMaybe(ctx, { unmatched, criteria }) {
  if (!(await maybeEnabled(ctx.settings))) return null;
  const accepted = await listSynonyms(ctx.db, 'accepted');
  if (accepted.length === 0) return null;
  const found = matchBids(unmatched || [], { ...criteria, keywords: accepted.map((a) => a.word), maxItems: 1 });
  if (found.length === 0) return null;
  const first = found[0];
  return { ...first, reasons: rewriteReasons(first.reasons, accepted) };
}
