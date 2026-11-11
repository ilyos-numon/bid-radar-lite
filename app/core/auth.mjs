// 로그인: 첫 설정(/setup)과 초대 링크(/join/:token). 비밀번호는 없다.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'br_session';
const MAX_AGE = 180 * 24 * 60 * 60;

export const MSG = {
  badInvite: '초대 링크가 맞지 않습니다. 대표에게 새 링크를 요청하세요.',
  memberLimit: '더 추가할 수 없습니다. 구성원은 대표를 포함해 5명까지입니다.',
};
export const MAX_MEMBERS = 5;

export function hashInvite(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function hmac(secret, id) {
  return createHmac('sha256', String(secret)).update(String(id)).digest('hex');
}

export function readCookie(req, name) {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * @param {{ ctx: object, secret: string }} deps
 */
export function createAuth({ ctx, secret }) {
  if (!secret) throw new Error('secret is required');

  function sign(id) {
    return `${id}.${hmac(secret, id)}`;
  }

  /** @returns {number|null} 서명이 맞으면 member id */
  function verify(value) {
    if (typeof value !== 'string') return null;
    const dot = value.lastIndexOf('.');
    if (dot <= 0) return null;
    const id = value.slice(0, dot);
    const sig = value.slice(dot + 1);
    if (!/^\d+$/.test(id)) return null;
    const expected = Buffer.from(hmac(secret, id), 'utf8');
    const given = Buffer.from(sig, 'utf8');
    if (expected.length !== given.length) return null;
    if (!timingSafeEqual(expected, given)) return null;
    return Number(id);
  }

  /** @returns {Promise<object|null>} */
  async function memberFrom(req) {
    const id = verify(readCookie(req, COOKIE_NAME));
    if (id === null) return null;
    return ctx.members.get(id);
  }

  function sessionCookie(id) {
    return `${COOKIE_NAME}=${sign(id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}`;
  }

  function clearCookie() {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  function redirectWithCookie(location, cookie) {
    return new Response(null, { status: 303, headers: { location, 'set-cookie': cookie } });
  }

  /** member 가 없으면 /welcome 으로 302 */
  function required(handler) {
    return (req, params, c, member) => {
      if (!member) return new Response(null, { status: 302, headers: { location: '/welcome' } });
      return handler(req, params, c, member);
    };
  }

  function setupForm({ company = '', name = '', message = '' } = {}) {
    const h = ctx.html;
    return `${message ? h.error(message, '두 칸을 채운 뒤 다시 눌러 주세요') : ''}
<form class="stack" method="post" action="/setup">
<label>회사 이름<input name="company" value="${h.esc(company)}" required autocomplete="organization" placeholder="예: OO조경"></label>
<label>내 이름<input name="name" value="${h.esc(name)}" required autocomplete="name"></label>
<button type="submit">시작하기</button>
</form>
<p class="bare-foot">${SETUP_FOOT}</p>
<p class="bare-after">${SETUP_AFTER}</p>`;
  }

  const SETUP_TITLE = '처음 시작하기';
  const SETUP_HELP = '회사 이름과 내 이름만 적으면 바로 시작합니다. 조건은 다음 화면에서 정합니다.';
  const SETUP_FOOT = '시작하면 이 회사의 대표가 됩니다. 구성원은 나중에 업무 분배 메뉴에서 초대 링크로 부를 수 있습니다.';
  const SETUP_AFTER = '이미 시작한 회사라면 대표에게 받은 초대 링크로 들어와 주세요.';
  const ME_HELP = '이름과 역할, 회사 이름을 확인하고 나갈 수 있습니다.';

  function welcomeBody(message) {
    const h = ctx.html;
    const top = message
      ? h.error(message, '')
      : h.notice('대표에게 받은 초대 링크를 열면 바로 들어올 수 있습니다.');
    return `${top}<p class="bare-foot">링크를 잃어버렸다면 대표에게 새 링크를 요청하세요.</p>`;
  }

  function registerRoutes(router) {
    router.get('/setup', async (req, params, c, member) => {
      if ((await ctx.members.count()) > 0) return ctx.html.redirect('/');
      return ctx.html.layout({ title: SETUP_TITLE, help: SETUP_HELP, body: setupForm(), member, chrome: 'bare' });
    });

    router.post('/setup', async (req, params, c, member) => {
      if ((await ctx.members.count()) > 0) {
        return ctx.html.page(409, {
          title: SETUP_TITLE,
          body: ctx.html.error('이미 시작한 회사입니다', '대표에게 받은 초대 링크로 들어와 주세요'),
          member,
          chrome: 'bare',
        });
      }
      let form;
      try {
        form = await req.formData();
      } catch {
        form = new FormData();
      }
      const company = String(form.get('company') ?? '').trim();
      const name = String(form.get('name') ?? '').trim();
      if (!company || !name) {
        return ctx.html.page(400, {
          title: SETUP_TITLE,
          help: SETUP_HELP,
          body: setupForm({ company, name, message: '회사 이름과 내 이름을 모두 적지 않았습니다' }),
          member,
          chrome: 'bare',
        });
      }
      const { member: owner } = await ctx.members.create({ name, role: 'owner' });
      await ctx.settings.set('company_name', company);
      return redirectWithCookie('/settings?first=1', sessionCookie(owner.id));
    });

    router.get('/join/:token', async (req, params, c, member) => {
      const row = await ctx.db.get('SELECT id FROM members WHERE token_hash = $1', [hashInvite(params.token)]);
      if (!row) {
        return ctx.html.page(403, { title: '어서 오세요', body: welcomeBody(MSG.badInvite), member: null, chrome: 'bare' });
      }
      return redirectWithCookie('/today', sessionCookie(Number(row.id)));
    });

    router.get('/welcome', (req, params, c, member) => {
      const body = member
        ? `${ctx.html.notice('이미 들어와 있습니다.')}<p><a class="button" href="/">첫 화면으로</a></p>`
        : welcomeBody(null);
      return ctx.html.layout({ title: '어서 오세요', help: '입찰 레이더는 대표가 보낸 초대 링크로 들어옵니다.', body, member, chrome: 'bare' });
    });

    router.get(
      '/me',
      required(async (req, params, c, member) => {
        const h = ctx.html;
        const company = await ctx.settings.get('company_name');
        const tile = (label, value) => `<div><dt>${label}</dt><dd>${h.esc(value)}</dd></div>`;
        const body = `<div class="card me-card"><dl class="tiles">${tile('이름', member.name)}${tile('역할', member.role === 'owner' ? '대표' : '구성원')}${tile('회사', company ? company : '비어 있음')}</dl><p><a class="button secondary" href="/logout">나가기</a></p></div>`;
        return h.layout({ title: '내 정보', eyebrow: false, help: ME_HELP, member, active: null, body });
      }),
    );

    router.get('/logout', () => redirectWithCookie('/welcome', clearCookie()));
  }

  return { sign, verify, memberFrom, sessionCookie, clearCookie, required, registerRoutes };
}
