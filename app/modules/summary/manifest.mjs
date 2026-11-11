import { MENU, badgeFor, extraLines } from './view.mjs';
import { registerRoutes } from './routes.mjs';
import { createStore, afterMatch } from './service.mjs';

export default {
  id: 'summary',
  title: MENU.title,
  group: '공고 더 알기',
  order: 20,
  path: '/summary',
  help: MENU.help,
  schema: new URL('./schema.sql', import.meta.url),
  routes: registerRoutes,
  async decorate(ctx, bidId) {
    return badgeFor(await createStore(ctx).get(bidId), bidId);
  },
  async notifyLines(ctx, bidId) {
    return extraLines(await createStore(ctx).get(bidId));
  },
  afterMatch,
};
