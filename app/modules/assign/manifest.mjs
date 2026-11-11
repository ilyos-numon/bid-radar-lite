import { MENU, TEXT } from './view.mjs';
import { registerRoutes } from './routes.mjs';
import { badgeFor, getItem } from './service.mjs';

export default {
  id: 'assign',
  title: MENU.title,
  group: '매일',
  order: 12,
  path: '/assign',
  help: MENU.help,
  schema: new URL('./schema.sql', import.meta.url),
  routes: registerRoutes,
  async decorate(ctx, bidId, member) {
    const item = await getItem(ctx.db, bidId, ctx.members);
    return badgeFor(bidId, item ? { name: item.name || TEXT.unknownMember, status: item.status } : null);
  },
};
