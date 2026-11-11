// 예시 회사에서 막는 동작: 인증키·계정·회사 만들기·초대·공고 가져오기·소스 추가·자동 요약류·결제 카드 등록·요금제 변경·해지·재개
// (알림 받을 이메일·웹훅 주소 변경은 설정 화면이 막고, 매일 알림 발송은 tenant 의 deliver 가 건너뛴다)
import { DEMO_TEXT } from './fixture.mjs';

/** [method, pathPrefix]. 경로는 세그먼트 단위 접두사, '*' 는 한 세그먼트, 끝의 '/' 는 아래 경로가 하나 더 있어야 맞음 */
export const DEMO_BLOCKED = [
  ['POST', '/connections/'],
  ['POST', '/account/password'],
  ['POST', '/account/delete'],
  ['POST', '/workspaces/new'],
  ['POST', '/assign/members'],
  ['POST', '/today/run'],
  ['POST', '/sources'],
  ['POST', '/sources/'],
  ['POST', '/summary/*/run'],
  ['POST', '/keywords/suggest'],
  ['POST', '/company/verdict'],
  ['POST', '/settings/test'],
  ['POST', '/billing/card'], // TOSS_CLIENT_KEY 가 test_ck_ 로 시작하면 허용 (토스 테스트 모드, 실제 결제 없음)
  ['POST', '/billing/plan'],
  ['POST', '/billing/cancel'],
  ['POST', '/billing/resume'],
];

const CARD_PATH = '/billing/card';

function segments(p) {
  return String(p ?? '')
    .split('?')[0]
    .split('/')
    .filter((s) => s !== '');
}

function matchPrefix(pattern, pathname) {
  const needMore = pattern.endsWith('/');
  const want = segments(pattern);
  const got = segments(pathname);
  if (needMore ? got.length <= want.length : got.length < want.length) return false;
  return want.every((w, i) => w === '*' || w === got[i]);
}

function testKeyMode(env) {
  return String(env?.TOSS_CLIENT_KEY ?? '').startsWith('test_ck_');
}

/**
 * @param {string} method
 * @param {string} pathname
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
export function isBlockedForDemo(method, pathname, env = {}) {
  const m = String(method ?? '').toUpperCase();
  for (const [bm, prefix] of DEMO_BLOCKED) {
    if (bm !== m || !matchPrefix(prefix, pathname)) continue;
    if (prefix === CARD_PATH && testKeyMode(env)) continue;
    return true;
  }
  return false;
}

function wantsHtml(req) {
  return String(req?.headers?.get?.('accept') ?? '').includes('text/html');
}

/**
 * HTML 요청이면 403 안내 페이지(DEMO_TEXT.blocked), 그 외 403 { error: 'demo_blocked' }.
 * html(createHtml 결과)이 있으면 그 틀로 그린다(그때는 Promise<Response>).
 * @param {Request} req
 * @param {{ page(status: number, opts: object): Promise<Response>, error(message: string, next?: string): string } | null} html
 * @returns {Response | Promise<Response>}
 */
export function blockedResponse(req, html) {
  if (!wantsHtml(req)) {
    return new Response(JSON.stringify({ error: 'demo_blocked' }), {
      status: 403,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const back = '<p><a class="button secondary" href="/today">오늘의 공고로 돌아가기</a> <a class="button" href="/signup">' + DEMO_TEXT.bannerLink + '</a></p>';
  if (html && typeof html.page === 'function') {
    const box = typeof html.error === 'function' ? html.error(DEMO_TEXT.blocked, '') : `<p>${DEMO_TEXT.blocked}</p>`;
    return html.page(403, { title: '예시 회사', body: `${box}${back}` });
  }
  const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>예시 회사</title></head><body><main><p role="alert">${DEMO_TEXT.blocked}</p>${back}</main></body></html>`;
  return new Response(doc, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
