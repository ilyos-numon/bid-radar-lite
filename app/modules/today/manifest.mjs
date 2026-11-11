import { MENU } from './view.mjs';
import { registerRoutes } from './routes.mjs';

export default {
  id: 'today',
  title: MENU.title,
  group: '매일',
  order: 10,
  path: '/today',
  help: MENU.help,
  routes: registerRoutes,
};
