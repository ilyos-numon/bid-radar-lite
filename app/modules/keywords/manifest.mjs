import { MENU } from './view.mjs';
import { registerRoutes } from './routes.mjs';
import { pickMaybe } from './service.mjs';

export default {
  id: 'keywords',
  title: MENU.title,
  group: '더 넓게',
  order: 31,
  path: '/keywords',
  help: MENU.help,
  schema: new URL('./schema.sql', import.meta.url),
  routes: registerRoutes,
  pickMaybe,
};
