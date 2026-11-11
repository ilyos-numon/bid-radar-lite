// 계정 화면: 첫 화면·가입·로그인·메일 확인 안내·비밀번호·내 계정·회사 만들기·초대 수락.
// 화면에 나가는 글자는 전부 TEXT 에 있다. 이 파일은 화면 용어 검사 대상과 같은 규칙을 따른다 (주석 포함).
// 각 함수는 layout/page 에 넘길 옵션 { title, help, heading, body, chrome, ... } 을 돌려준다.
import { esc, error, notice, empty } from './html.mjs';
import { MSG } from './auth.mjs';
import { consentChecks } from './legal/pages.mjs';
import { DEMO_TEXT } from './demo/fixture.mjs';

const CONSENT_REQUIRED = '이용약관과 개인정보 수집·이용에 모두 동의해야 가입할 수 있습니다';

export const TEXT = {
  brand: '입찰 레이더',
  landing: {
    title: '입찰 레이더',
    help: '작은 회사를 위한 공고 알리미입니다.',
    lines: [
      '우리 회사에 맞는 입찰 공고를 매일 아침 골라 알려 줍니다.',
      '관심 공고와 마감일을 함께 챙기고, 할 일을 구성원에게 나눕니다.',
      '공고문이 길면 핵심만 짧게 요약해 줍니다.',
    ],
    signup: '가입하기',
    login: '로그인',
    privacy: '가입할 때는 이메일, 비밀번호, 회사 이름, 내 이름만 받습니다. 그 밖의 개인정보는 모으지 않습니다.',
    deleted: '계정과 데이터를 삭제했습니다.',
    badLink: '링크가 만료되었거나 맞지 않습니다. 다시 로그인해 주세요.',
  },
  signup: {
    title: '가입하기',
    help: '이메일로 가입한 뒤 메일함에서 가입 확인 링크를 누르면 시작할 수 있습니다.',
    email: '이메일',
    password: '비밀번호',
    passwordHint: '8자 이상',
    name: '내 이름',
    code: '가입 코드',
    codeHint: '운영자에게 받은 코드',
    submit: '가입하기',
    busy: '가입하는 중…',
    invited: '초대받은 회사에 들어가려면 먼저 가입하거나 로그인하세요.',
    consentRequired: CONSENT_REQUIRED,
    haveAccount: '이미 가입했다면',
    toLogin: '로그인',
  },
  verifyNotice: {
    title: '메일을 확인해 주세요',
    body: '메일함에서 "입찰 레이더 가입 확인" 메일의 링크를 눌러 주세요.',
    sentTo: '보낸 곳',
    notArrived: '메일이 오지 않았다면 스팸함을 확인하거나 잠시 뒤 다시 가입해 주세요.',
    toLogin: '로그인으로',
  },
  login: {
    title: '로그인',
    help: '가입한 이메일과 비밀번호를 적어 주세요.',
    submit: '로그인',
    busy: '확인하는 중…',
    forgot: '비밀번호를 잊었다면',
    toReset: '비밀번호 다시 정하기',
    noAccount: '아직 가입하지 않았다면',
    toSignup: '가입하기',
  },
  reset: {
    title: '비밀번호 다시 정하기',
    help: '가입한 이메일을 적으면 비밀번호를 다시 정하는 링크를 메일로 보냅니다.',
    submit: '메일 보내기',
    busy: '보내는 중…',
    sent: '메일을 보냈습니다. 가입한 이메일이라면 곧 도착합니다.',
    toLogin: '로그인으로',
  },
  password: {
    title: '비밀번호 바꾸기',
    help: '지금 비밀번호를 확인한 뒤 새 비밀번호로 바꿉니다.',
    helpRecovery: '메일 링크로 들어왔습니다. 새 비밀번호를 두 번 적어 주세요.',
    current: '지금 비밀번호',
    next: '새 비밀번호',
    next2: '새 비밀번호 한 번 더',
    submit: '바꾸기',
    busy: '바꾸는 중…',
    back: '내 계정으로',
  },
  account: {
    title: '내 계정',
    help: '로그인 정보와 소속 회사를 확인하고 비밀번호를 바꾸거나 계정을 삭제할 수 있습니다.',
    email: '이메일',
    companies: '소속 회사',
    current: '지금 보는 회사',
    owner: '대표',
    staff: '구성원',
    switchTo: '이 회사로',
    noCompany: '아직 소속된 회사가 없습니다',
    newCompany: '회사 만들기',
    addCompany: '회사 하나 더 만들기',
    changePassword: '비밀번호 바꾸기',
    logout: '나가기',
    saved: '비밀번호를 바꿨습니다.',
    deleteTitle: '계정 삭제',
    deleteHelp: '계정을 삭제하면 되돌릴 수 없습니다. 삭제하려면 비밀번호를 한 번 더 적어 주세요.',
    deletePassword: '비밀번호',
    deleteConfirm: '내가 대표인 회사의 모든 데이터도 삭제됩니다',
    deleteSubmit: '계정 삭제',
    deleteBusy: '삭제하는 중…',
  },
  me: {
    title: '내 정보',
    help: '이름과 역할, 회사 이름을 확인하고 나갈 수 있습니다.',
    name: '이름',
    role: '역할',
    company: '회사',
    emptyCompany: '비어 있음',
    account: '내 계정',
    logout: '나가기',
  },
  workspace: {
    title: '회사 만들기',
    help: '회사 이름과 내 이름만 적으면 바로 시작합니다. 조건은 다음 화면에서 정합니다.',
    company: '회사 이름',
    companyPlaceholder: '예: OO조경',
    name: '내 이름',
    submit: '시작하기',
    busy: '만드는 중…',
    foot: '만들면 이 회사의 대표가 됩니다. 구성원은 나중에 업무 분배 메뉴에서 초대 링크로 부를 수 있습니다.',
    after: '이미 시작한 회사라면 대표에게 받은 초대 링크로 들어와 주세요.',
  },
  join: {
    title: '초대받은 회사',
    help: '대표가 보낸 초대 링크로 들어왔습니다.',
    body: '들어가기를 누르면 초대한 회사의 구성원이 됩니다.',
    submit: '들어가기',
    busy: '들어가는 중…',
    bad: MSG.badInvite,
  },
  forbidden: {
    title: '들어갈 수 없습니다',
    notMember: '그 회사의 구성원이 아닙니다. 내 계정에서 소속 회사를 골라 주세요.',
    toAccount: '내 계정으로',
  },
  errors: {
    EMAIL_TAKEN: '이미 가입한 이메일입니다',
    WEAK_PASSWORD: '비밀번호는 8자 이상으로 적어 주세요',
    PASSWORD_TOO_LONG: '비밀번호는 72자까지 적을 수 있습니다',
    BAD_CODE: '가입 코드가 맞지 않습니다',
    SIGNUP_CLOSED: '지금은 가입을 받지 않습니다. 초대 링크로 들어와 주세요',
    BAD_EMAIL: '이메일 주소 모양이 맞지 않습니다',
    BAD_NAME: '내 이름을 1자 이상 40자 이하로 적어 주세요',
    BAD_COMPANY: '회사 이름을 1자 이상 60자 이하로 적어 주세요',
    BAD_CREDENTIALS: '이메일 또는 비밀번호가 맞지 않습니다',
    EMAIL_NOT_CONFIRMED: '메일 인증이 아직 안 됐습니다. 메일함을 확인해 주세요',
    RATE_LIMIT: '너무 여러 번 시도했습니다. 15분 뒤 다시 해 주세요',
    BAD_CURRENT: '현재 비밀번호가 맞지 않습니다',
    PASSWORD_MISMATCH: '두 번 적은 새 비밀번호가 다릅니다',
    DELETE_PASSWORD: '비밀번호가 맞지 않습니다. 다시 적어 주세요',
    DELETE_CONFIRM: '삭제에 동의하는 칸을 체크해 주세요',
    WORKSPACE_LIMIT: (max) => `회사는 ${max}개까지 만들 수 있습니다. 운영자에게 문의해 주세요`,
    CONSENT_REQUIRED,
    UNKNOWN: '처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요',
  },
};

/** 오류 코드 → 사용자 문구 (한 곳) */
export function errorText(code, { max = 50 } = {}) {
  const v = Object.prototype.hasOwnProperty.call(TEXT.errors, code) ? TEXT.errors[code] : TEXT.errors.UNKNOWN;
  return typeof v === 'function' ? v(max) : v;
}

function errorBox(code, opts) {
  return code ? error(errorText(code, opts), '') : '';
}

const bare = (o) => ({ ...o, chrome: 'bare' });

export function landingView({ message = null, kind = 'error', demo = false } = {}) {
  const t = TEXT.landing;
  let top = '';
  if (message && kind === 'error') top = error(message, '');
  else if (message) top = notice(message, { kind: 'success', role: 'status' });
  const lines = t.lines.map((l) => `<li>${esc(l)}</li>`).join('');
  // 예시 회사로 바로 들어가는 버튼은 가입하기 위에 둔다
  const demoBox = demo
    ? `<form method="post" action="/demo/login" style="margin:0"><button type="submit" style="width:100%">${esc(DEMO_TEXT.button)}</button></form><p class="help" style="margin:0">${esc(DEMO_TEXT.caption)}</p>`
    : '';
  const body = `${top}<div class="card"><ul style="margin:0;padding-left:1.2em;display:grid;gap:6px">${lines}</ul></div>
<div class="card" style="display:grid;gap:12px">${demoBox}<a class="button" href="/signup">${esc(t.signup)}</a><a class="button secondary" href="/login">${esc(t.login)}</a></div>
<p class="bare-foot">${esc(t.privacy)}</p>`;
  return bare({ title: t.title, heading: t.title, help: t.help, body });
}

export function signupView({ email = '', name = '', code: errCode = null, showCode = false, invited = false, agreed = {}, turnstileHtml = '', message = null } = {}) {
  const t = TEXT.signup;
  const codeField = showCode
    ? `<label>${esc(t.code)}<input name="code" required autocomplete="off"><span>${esc(t.codeHint)}</span></label>`
    : '';
  const body = `${invited ? notice(t.invited) : ''}${errorBox(errCode)}${message ? error(message, '') : ''}
<form class="stack" method="post" action="/signup">
<label>${esc(t.email)}<input type="email" name="email" value="${esc(email)}" required autocomplete="email"></label>
<label>${esc(t.password)}<input type="password" name="password" required minlength="8" maxlength="72" autocomplete="new-password"><span>${esc(t.passwordHint)}</span></label>
<label>${esc(t.name)}<input name="name" value="${esc(name)}" required maxlength="40" autocomplete="name"></label>
${codeField}${invited ? '<input type="hidden" name="invite" value="1">' : ''}
${consentChecks(agreed)}
${turnstileHtml}
<button type="submit" data-busy="${esc(t.busy)}">${esc(t.submit)}</button>
</form>
<p class="bare-foot">${esc(t.haveAccount)} <a href="/login">${esc(t.toLogin)}</a></p>`;
  return bare({ title: t.title, help: t.help, body });
}

export function signupClosedView() {
  const body = `${errorBox('SIGNUP_CLOSED')}<p class="bare-foot">${esc(TEXT.signup.haveAccount)} <a href="/login">${esc(TEXT.signup.toLogin)}</a></p>`;
  return bare({ title: TEXT.signup.title, body });
}

export function verifyNoticeView({ email = '' } = {}) {
  const t = TEXT.verifyNotice;
  const to = email ? `<p class="help">${esc(t.sentTo)}: <strong>${esc(email)}</strong></p>` : '';
  const body = `${notice(t.body)}${to}<p><a class="button secondary" href="/login">${esc(t.toLogin)}</a></p>
<p class="bare-foot">${esc(t.notArrived)}</p>`;
  return bare({ title: t.title, body });
}

export function loginView({ email = '', code: errCode = null } = {}) {
  const t = TEXT.login;
  const body = `${errorBox(errCode)}
<form class="stack" method="post" action="/login">
<label>${esc(TEXT.signup.email)}<input type="email" name="email" value="${esc(email)}" required autocomplete="email"></label>
<label>${esc(TEXT.signup.password)}<input type="password" name="password" required autocomplete="current-password"></label>
<button type="submit" data-busy="${esc(t.busy)}">${esc(t.submit)}</button>
</form>
<p class="bare-foot">${esc(t.forgot)} <a href="/reset">${esc(t.toReset)}</a> · ${esc(t.noAccount)} <a href="/signup">${esc(t.toSignup)}</a></p>`;
  return bare({ title: t.title, help: t.help, body });
}

export function resetView({ sent = false, email = '', code: errCode = null } = {}) {
  const t = TEXT.reset;
  if (sent) {
    const body = `${notice(t.sent, { kind: 'success', role: 'status' })}<p><a class="button secondary" href="/login">${esc(t.toLogin)}</a></p>`;
    return bare({ title: t.title, body });
  }
  const body = `${errorBox(errCode)}
<form class="stack" method="post" action="/reset">
<label>${esc(TEXT.signup.email)}<input type="email" name="email" value="${esc(email)}" required autocomplete="email"></label>
<button type="submit" data-busy="${esc(t.busy)}">${esc(t.submit)}</button>
</form>
<p class="bare-foot"><a href="/login">${esc(t.toLogin)}</a></p>`;
  return bare({ title: t.title, help: t.help, body });
}

export function passwordView({ recovery = false, code: errCode = null } = {}) {
  const t = TEXT.password;
  const action = recovery ? '/account/password?recovery=1' : '/account/password';
  const current = recovery
    ? ''
    : `<label>${esc(t.current)}<input type="password" name="current" required autocomplete="current-password"></label>`;
  const body = `${errorBox(errCode)}
<form class="stack" method="post" action="${esc(action)}">
${current}<label>${esc(t.next)}<input type="password" name="next" required minlength="8" maxlength="72" autocomplete="new-password"><span>${esc(TEXT.signup.passwordHint)}</span></label>
<label>${esc(t.next2)}<input type="password" name="next2" required minlength="8" maxlength="72" autocomplete="new-password"></label>
<button type="submit" data-busy="${esc(t.busy)}">${esc(t.submit)}</button>
</form>
<p class="bare-foot"><a href="/account">${esc(t.back)}</a></p>`;
  return bare({ title: t.title, help: recovery ? t.helpRecovery : t.help, body });
}

/**
 * @param {{ email: string, list: Array<{workspaceId:string, workspaceName:string, role:string}>, currentId?: string|null, saved?: boolean, code?: string|null, demoUser?: boolean }} p
 *   demoUser: 예시 계정이면 비밀번호 바꾸기·계정 삭제 대신 안내 한 줄
 */
export function accountView({ email, list = [], currentId = null, saved = false, code: errCode = null, demoUser = false }) {
  const t = TEXT.account;
  const rows = list
    .map((m) => {
      const role = m.role === 'owner' ? t.owner : t.staff;
      const isCurrent = m.workspaceId === currentId;
      const action = isCurrent
        ? `<span class="pill on">${esc(t.current)}</span>`
        : `<form method="post" action="/workspaces/switch" style="margin:0"><input type="hidden" name="workspace" value="${esc(m.workspaceId)}"><button type="submit" class="secondary small">${esc(t.switchTo)}</button></form>`;
      return `<tr><td>${esc(m.workspaceName)}</td><td>${esc(role)}</td><td>${action}</td></tr>`;
    })
    .join('');
  const companies = list.length
    ? `<table><tbody>${rows}</tbody></table><p style="margin:12px 0 0"><a href="/workspaces/new">${esc(t.addCompany)}</a></p>`
    : empty(t.noCompany, { href: '/workspaces/new', label: t.newCompany });
  const passwordLink = demoUser
    ? `<p class="help" style="margin:0">${esc(DEMO_TEXT.accountLocked)}</p>`
    : `<p style="display:flex;flex-wrap:wrap;gap:12px"><a class="button secondary" href="/account/password">${esc(t.changePassword)}</a></p>`;
  const deleteSection = demoUser
    ? ''
    : `
<section class="card" id="delete"><h2 style="margin:0 0 8px;font-size:18px">${esc(t.deleteTitle)}</h2><p class="help" style="margin:0 0 12px">${esc(t.deleteHelp)}</p>
${errorBox(errCode)}<form class="stack" method="post" action="/account/delete">
<label>${esc(t.deletePassword)}<input type="password" name="password" required autocomplete="current-password"></label>
<label style="display:flex;gap:8px;align-items:center;font-weight:500"><input type="checkbox" name="confirm" value="1" required>${esc(t.deleteConfirm)}</label>
<p style="margin:0"><button type="submit" class="secondary" style="color:var(--no);border-color:var(--no-line)" data-busy="${esc(t.deleteBusy)}">${esc(t.deleteSubmit)}</button></p>
</form></section>`;
  const body = `${saved ? notice(t.saved, { kind: 'success', role: 'status' }) : ''}
<div class="card me-card"><dl class="tiles"><div><dt>${esc(t.email)}</dt><dd>${esc(email ?? '')}</dd></div></dl>
${passwordLink}
<form method="post" action="/logout" style="margin:12px 0 0"><button type="submit" class="secondary quiet">${esc(t.logout)}</button></form></div>
<section class="card"><h2 style="margin:0 0 12px;font-size:18px">${esc(t.companies)}</h2>${companies}</section>${deleteSection}`;
  return { title: t.title, help: t.help, eyebrow: false, active: null, body };
}

export function meView({ member, company }) {
  const t = TEXT.me;
  const tile = (label, value) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
  const body = `<div class="card me-card"><dl class="tiles">${tile(t.name, member.name)}${tile(t.role, member.role === 'owner' ? TEXT.account.owner : TEXT.account.staff)}${tile(t.company, company ? company : t.emptyCompany)}</dl>
<div style="display:flex;flex-wrap:wrap;gap:12px"><a class="button secondary" href="/account">${esc(t.account)}</a><form method="post" action="/logout" style="margin:0"><button type="submit" class="secondary">${esc(t.logout)}</button></form></div></div>`;
  return { title: t.title, eyebrow: false, help: t.help, active: null, body };
}

export function workspaceNewView({ company = '', name = '', code: errCode = null, max = 50 } = {}) {
  const t = TEXT.workspace;
  const body = `${errorBox(errCode, { max })}
<form class="stack" method="post" action="/workspaces/new">
<label>${esc(t.company)}<input name="company" value="${esc(company)}" required maxlength="60" autocomplete="organization" placeholder="${esc(t.companyPlaceholder)}"></label>
<label>${esc(t.name)}<input name="name" value="${esc(name)}" required maxlength="40" autocomplete="name"></label>
<button type="submit" data-busy="${esc(t.busy)}">${esc(t.submit)}</button>
</form>
<p class="bare-foot">${esc(t.foot)}</p>
<p class="bare-after">${esc(t.after)}</p>`;
  return bare({ title: t.title, help: t.help, body });
}

export function joinView({ token }) {
  const t = TEXT.join;
  const body = `${notice(t.body)}
<form class="stack" method="post" action="/join/${encodeURIComponent(token)}">
<button type="submit" data-busy="${esc(t.busy)}">${esc(t.submit)}</button>
</form>`;
  return bare({ title: t.title, help: t.help, body });
}

export function joinBadView() {
  const body = `${error(TEXT.join.bad, '')}<p class="bare-foot"><a href="/login">${esc(TEXT.login.title)}</a></p>`;
  return bare({ title: TEXT.join.title, body });
}

export function notMemberView() {
  const t = TEXT.forbidden;
  const body = `${error(t.notMember, '')}<p><a class="button secondary" href="/account">${esc(t.toAccount)}</a></p>`;
  return bare({ title: t.title, body });
}
