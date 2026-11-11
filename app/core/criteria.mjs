// 알림 조건: settings 의 criteria(JSON) → 없으면 config/criteria.json
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'criteria.json');
const MAX_ITEMS_LIMIT = 20;

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isAmount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * @param {any} c
 * @returns {string[]} 사용자 문구 (비어 있으면 통과)
 */
function validate(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return ['조건 형식이 맞지 않습니다. 알림 설정에서 다시 저장해 주세요.'];
  const errors = [];
  if (!isStringArray(c.keywords) || c.keywords.filter((k) => k.trim() !== '').length === 0) {
    errors.push('업종 키워드를 하나 이상 적어 주세요.');
  }
  if (!isStringArray(c.regions)) errors.push('지역은 목록으로 적어 주세요. 전국이면 비워 두세요.');
  if (c.excludeKeywords !== undefined && !isStringArray(c.excludeKeywords)) {
    errors.push('제외 키워드는 목록으로 적어 주세요. 없으면 비워 두세요.');
  }
  if (!isAmount(c.budgetMin)) errors.push('최소 예산을 0 이상의 숫자로 적어 주세요.');
  if (!isAmount(c.budgetMax)) errors.push('최대 예산을 0 이상의 숫자로 적어 주세요.');
  if (isAmount(c.budgetMin) && isAmount(c.budgetMax) && c.budgetMin > c.budgetMax) {
    errors.push('최소 예산이 최대 예산보다 큽니다. 두 값을 다시 확인해 주세요.');
  }
  if (!Number.isInteger(c.maxItems) || c.maxItems < 1 || c.maxItems > MAX_ITEMS_LIMIT) {
    errors.push(`알림 건수는 1에서 ${MAX_ITEMS_LIMIT} 사이로 적어 주세요.`);
  }
  return errors;
}

function normalize(c) {
  const clean = (arr) => [...new Set(arr.map((s) => s.trim()).filter((s) => s !== ''))];
  const out = {
    keywords: clean(c.keywords),
    regions: clean(c.regions),
    budgetMin: c.budgetMin,
    budgetMax: c.budgetMax,
    maxItems: c.maxItems,
  };
  if (c.excludeKeywords !== undefined) out.excludeKeywords = clean(c.excludeKeywords);
  return out;
}


/** @param {{settings: {get(k:string):Promise<string|null>, set(k:string, v:string):Promise<void>}}} ctx */
export function create(ctx) {
  const criteria = {
    /** @returns {Promise<import('../../src/match.js').Criteria>} */
    async get() {
      const stored = await ctx.settings.get('criteria');
      if (stored) {
        try {
          const parsed = JSON.parse(stored);
          if (validate(parsed).length === 0) return parsed;
        } catch {
          // 저장값이 깨졌으면 기본 파일로 돌아간다
        }
      }
      return JSON.parse(readFileSync(DEFAULT_FILE, 'utf8'));
    },
    /**
     * 매칭에 쓰는 조건: 저장값 + excludeKeywords(없으면 []) + synonyms({}).
     * 채택한 비슷한 말은 본 매칭에 넣지 않는다 (추천 키워드 모듈의 '관련 가능성 있음' 1건에만 쓴다)
     * @returns {Promise<import('../../src/match.js').Criteria>}
     */
    async effective() {
      const c = await criteria.get();
      return { ...c, excludeKeywords: c.excludeKeywords ?? [], synonyms: {} };
    },
    /**
     * 검사를 통과하면 저장하고 빈 배열, 아니면 저장하지 않고 오류 문구 배열
     * @returns {Promise<string[]>}
     */
    async set(c) {
      const errors = validate(c);
      if (errors.length > 0) return errors;
      const clean = normalize(c);
      if (ctx.limits) {
        const lim = await ctx.limits.check('keywords', clean.keywords.length);
        if (!lim.ok) return [lim.message];
      }
      await ctx.settings.set('criteria', JSON.stringify(clean));
      return [];
    },
    validate,
  };
  return { criteria };
}
