import { MENU } from './view.mjs';
import { registerRoutes } from './routes.mjs';
import { adapter as rss } from './adapters/rss.mjs';

export default {
  id: 'sources',
  title: MENU.title,
  group: '더 넓게',
  order: 32,
  path: '/sources',
  help: MENU.help,
  routes: registerRoutes,
  adapters: [rss],
};
