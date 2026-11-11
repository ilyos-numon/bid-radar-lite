// 요금제 한도 검사 (구성원·공고 소스·키워드·알림 이메일). 서버가 저장 전에 부른다
import { PLANS, LIMIT_KINDS, planOf } from './plans.mjs';

export const LIMIT_TEXT = { members: '구성원', sources: '공고 소스', keywords: '키워드', emails: '알림 이메일' };

/** 한도 초과 문구 */
export function planLimitMessage(kind, max, plan) {
  const name = (planOf(plan) ?? PLANS.trial).name;
  return `${LIMIT_TEXT[kind] ?? kind}은(는) ${name} 요금제에서 ${max}개까지입니다. 요금제를 올리면 더 쓸 수 있습니다.`;
}

/**
 * @param {{ getPlan: () => Promise<string>|string }} opts
 */
export function createLimits({ getPlan }) {
  if (typeof getPlan !== 'function') throw new Error('getPlan is required');
  const current = async () => planOf(await getPlan()) ?? PLANS.trial;

  return {
    async max(kind) {
      if (!LIMIT_KINDS.includes(kind)) return Infinity;
      return (await current()).limits[kind];
    },
    async check(kind, nextCount) {
      if (!LIMIT_KINDS.includes(kind)) return { ok: true, max: Infinity };
      const p = await current();
      const max = p.limits[kind];
      if (Number(nextCount) <= max) return { ok: true, max };
      return { ok: false, code: 'PLAN_LIMIT', kind, max, plan: p.id, message: planLimitMessage(kind, max, p.id) };
    },
    async summary() {
      const p = await current();
      return { plan: p.id, limits: { ...p.limits } };
    },
  };
}

/** 기존 모드·테스트: 항상 통과 */
export function unlimitedLimits() {
  return {
    async max() {
      return Infinity;
    },
    async check() {
      return { ok: true, max: Infinity };
    },
    async summary() {
      return { plan: null, limits: Object.fromEntries(LIMIT_KINDS.map((k) => [k, Infinity])) };
    },
  };
}
