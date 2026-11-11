// 사업자 정보: 환경변수(BUSINESS_*, PRIVACY_OFFICER)에서만 읽는다. 실제 값은 어떤 파일에도 쓰지 않는다.
import { esc } from '../html.mjs';

export const BUSINESS_FIELDS = [
  'BUSINESS_NAME',
  'BUSINESS_REP',
  'BUSINESS_REG_NO',
  'BUSINESS_MAIL_ORDER_NO',
  'BUSINESS_ADDRESS',
  'BUSINESS_EMAIL',
  'BUSINESS_PHONE',
  'PRIVACY_OFFICER',
];
export const UNSET = '미설정';

const KEYS = {
  name: 'BUSINESS_NAME',
  rep: 'BUSINESS_REP',
  regNo: 'BUSINESS_REG_NO',
  mailOrderNo: 'BUSINESS_MAIL_ORDER_NO',
  address: 'BUSINESS_ADDRESS',
  email: 'BUSINESS_EMAIL',
  phone: 'BUSINESS_PHONE',
  privacyOfficer: 'PRIVACY_OFFICER',
};

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ name: string, rep: string, regNo: string, mailOrderNo: string, address: string, email: string, phone: string, privacyOfficer: string, configured: boolean }}
 *   빈 값은 UNSET. configured 는 모든 항목이 채워졌을 때 true
 */
export function businessInfo(env = {}) {
  const out = {};
  let configured = true;
  for (const [k, name] of Object.entries(KEYS)) {
    const v = String(env?.[name] ?? '').trim();
    if (!v) configured = false;
    out[k] = v || UNSET;
  }
  return { ...out, configured };
}

/** 모든 화면 아래의 사업자 정보 줄과 약관 링크 */
export function footerHtml(env = {}) {
  const b = businessInfo(env);
  const item = (label, value) => `<span>${esc(label)} ${esc(value)}</span>`;
  const items = [
    item('상호', b.name),
    item('대표', b.rep),
    item('사업자등록번호', b.regNo),
    item('통신판매업 신고', b.mailOrderNo),
    item('주소', b.address),
    item('문의', b.email === UNSET && b.phone === UNSET ? UNSET : [b.email, b.phone].filter((v) => v !== UNSET).join(' · ')),
  ].join('<span class="sep" aria-hidden="true">·</span>');
  const note = b.configured ? '' : '<span class="unset">사업자 정보 미설정</span>';
  return `<footer class="legal"><p class="biz">${items}${note}</p><p class="links"><a href="/terms">이용약관</a><span class="sep" aria-hidden="true">·</span><a href="/privacy">개인정보처리방침</a></p></footer>`;
}
