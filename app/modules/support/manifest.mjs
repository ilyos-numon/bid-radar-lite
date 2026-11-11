import { MENU } from './view.mjs';
import { registerRoutes } from './routes.mjs';
import { runSupportJob } from './service.mjs';

export default {
  id: 'support',
  title: MENU.title,
  group: '더 넓게',
  order: 30,
  path: '/support',
  help: MENU.help,
  schema: new URL('./schema.sql', import.meta.url),
  routes: registerRoutes,
  jobs: {
    support: (ctx, opts) => runSupportJob(ctx, opts),
  },
};
