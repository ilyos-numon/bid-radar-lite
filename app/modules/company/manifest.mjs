import { MENU, VERDICT_LABEL, notifyLine, verdictKind } from './view.mjs';
import { registerRoutes } from './routes.mjs';
import { createService } from './service.mjs';

export default {
  id: 'company',
  title: MENU.title,
  group: '공고 더 알기',
  order: 21,
  path: '/company',
  help: MENU.help,
  schema: new URL('./schema.sql', import.meta.url),
  routes: registerRoutes,

  /** 오늘의 공고 뱃지: 판정 문구 → /company#<bidId>. 회사 정보가 비었거나 판정이 없으면 null */
  async decorate(ctx, bidId) {
    const svc = createService(ctx);
    if (svc.isEmpty(await svc.getProfile())) return null;
    const v = await svc.getVerdict(bidId);
    if (!v) return null;
    // kind(뱃지 뜻 = 판정 값)는 읽을 수 있되 열거되지 않게 붙인다 ({ label, href } 비교 유지)
    return Object.defineProperty(
      { label: VERDICT_LABEL[v.verdict] ?? VERDICT_LABEL.check, href: `/company#${bidId}` },
      'kind',
      { value: verdictKind(v.verdict), enumerable: false },
    );
  },

  /** 알림 한 줄: '자격: <판정> — <첫 근거>' */
  async notifyLines(ctx, bidId) {
    const svc = createService(ctx);
    if (svc.isEmpty(await svc.getProfile())) return [];
    const v = await svc.getVerdict(bidId);
    if (!v) return [];
    return [notifyLine(v.verdict, v.reasons[0] ?? '', v.basis)];
  },

  /** 추천된 공고(matched + maybe)마다 판정 저장. 미리보기(dry)는 아무것도 하지 않는다 */
  async afterMatch(ctx, { matched, maybe, candidates, dry }) {
    if (dry) return;
    const list = [...(matched || [])];
    if (maybe) list.push(maybe);
    await createService(ctx).judgeMany(list, candidates);
  },
};
