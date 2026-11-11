import { MENU } from './view.mjs';
import { registerRoutes } from './routes.mjs';

export default {
  id: 'connections',
  title: MENU.title,
  group: '설정',
  order: 41,
  path: '/connections',
  help: MENU.help,
  // 회사별 인증키 저장소가 있을 때(워크스페이스 모드)만 메뉴를 보인다
  when: (ctx) => Boolean(ctx.keys && ctx.keys.enabled),
  routes: registerRoutes,
};
