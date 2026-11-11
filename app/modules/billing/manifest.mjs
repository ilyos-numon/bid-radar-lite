import { MENU } from './view.mjs';
import { registerRoutes } from './routes.mjs';

export default {
  id: 'billing',
  title: MENU.title,
  group: '설정',
  order: 45,
  path: '/billing',
  help: MENU.help,
  // 가입 모드에서 tenant 가 결제 묶음(ctx.billing)을 넣었을 때만 메뉴를 보인다
  when: (ctx) => Boolean(ctx.billing),
  routes: registerRoutes,
};
