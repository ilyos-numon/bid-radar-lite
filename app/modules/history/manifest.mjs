import { MENU, BADGE_LABEL } from './view.mjs';
import { registerRoutes } from './routes.mjs';
import { createService } from './service.mjs';

export default {
  id: 'history',
  title: MENU.title,
  group: '공고 더 알기',
  order: 23,
  path: '/history',
  help: MENU.help,
  schema: new URL('./schema.sql', import.meta.url),
  routes: registerRoutes,

  /** 오늘의 공고 뱃지: '지난 개찰 보기' → /history?q=<수요기관>. 인증키·수요기관이 없으면 null */
  async decorate(ctx, bidId) {
    const svc = createService(ctx);
    if (!svc.hasKey()) return null;
    const org = await svc.orgOf(bidId);
    if (!org) return null;
    return { label: BADGE_LABEL, href: `/history?q=${encodeURIComponent(org)}` };
  },
};
