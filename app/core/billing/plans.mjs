// 요금제 3단계와 한도. 가격은 원(KRW), 결제 주기는 30일 고정
export const PLANS = {
  trial: { id: 'trial', name: '무료 체험', price: 0, limits: { members: 3, sources: 2, keywords: 10, emails: 2 } },
  starter: { id: 'starter', name: '스타터', price: 29000, limits: { members: 3, sources: 3, keywords: 30, emails: 3 } },
  team: { id: 'team', name: '팀', price: 79000, limits: { members: 10, sources: 10, keywords: 100, emails: 10 } },
};
export const PAID_PLANS = ['starter', 'team'];
export const LIMIT_KINDS = ['members', 'sources', 'keywords', 'emails'];
export const PERIOD_DAYS = 30;

/** @param {string} id */
export function planOf(id) {
  return Object.hasOwn(PLANS, id) ? PLANS[id] : null;
}
