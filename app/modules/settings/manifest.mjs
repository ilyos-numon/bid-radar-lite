import { MENU } from './view.mjs';
import { registerRoutes } from './routes.mjs';

export default {
  id: 'settings',
  title: MENU.title,
  group: '설정',
  order: 40,
  path: '/settings',
  help: MENU.help,
  routes: registerRoutes,
};
