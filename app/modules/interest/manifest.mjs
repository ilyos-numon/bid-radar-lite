import { MENU, badge } from './view.mjs';
import { registerRoutes } from './routes.mjs';
import { isInterested, reminders } from './service.mjs';

export default {
  id: 'interest',
  title: MENU.title,
  group: '매일',
  order: 11,
  path: '/interest',
  help: MENU.help,
  schema: new URL('./schema.sql', import.meta.url),
  routes: registerRoutes,
  async decorate(ctx, bidId) {
    return badge(bidId, await isInterested(ctx, bidId));
  },
  jobs: {
    reminders(ctx, opts) {
      return reminders(ctx, opts);
    },
  },
};
