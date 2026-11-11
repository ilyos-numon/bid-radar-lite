// 약관·개인정보처리방침·재동의 화면. 두 모드(기존·가입) 공통이며 Response 를 돌려준다.
import { esc, error } from '../html.mjs';
import { termsHtml, privacyHtml } from './texts.mjs';
import { CONSENT_FIELDS } from './consent.mjs';

export const CONSENT_TEXT = {
  title: '약관 동의',
  help: '이용약관 또는 개인정보처리방침이 바뀌었습니다. 계속 이용하려면 다시 동의해 주세요.',
  terms: '이용약관에 동의합니다 (필수)',
  privacy: '개인정보 수집·이용에 동의합니다 (필수)',
  view: '보기',
  submit: '동의하고 계속하기',
  busy: '저장하는 중…',
  required: '필수 항목 두 개에 모두 동의해 주세요',
};

/** 동의 체크 2개(가입 화면과 재동의 화면이 같이 쓴다) */
export function consentChecks({ terms = false, privacy = false } = {}) {
  const t = CONSENT_TEXT;
  const box = (name, label, href, on) =>
    `<label class="check"><input type="checkbox" name="${name}" value="1" required${on ? ' checked' : ''}><span>${esc(label)} <a href="${href}" target="_blank" rel="noopener">${esc(t.view)}</a></span></label>`;
  return `<fieldset class="consents">${box(CONSENT_FIELDS.terms, t.terms, '/terms', terms)}${box(CONSENT_FIELDS.privacy, t.privacy, '/privacy', privacy)}</fieldset>`;
}

/**
 * @param {{ env?: object, html: { page(status: number, opts: object): Promise<Response> } }} deps
 */
export function createLegalPages({ env = {}, html }) {
  return {
    terms() {
      return html.page(200, { chrome: 'bare', title: '이용약관', body: termsHtml(env) });
    },
    privacy() {
      return html.page(200, { chrome: 'bare', title: '개인정보처리방침', body: privacyHtml(env) });
    },
    consent({ error: err } = {}) {
      const t = CONSENT_TEXT;
      const body = `${err ? error(t.required, '') : ''}
<form class="stack" method="post" action="/consent">
${consentChecks()}
<button type="submit" data-busy="${esc(t.busy)}">${esc(t.submit)}</button>
</form>`;
      return html.page(err ? 400 : 200, { chrome: 'bare', title: t.title, help: t.help, body });
    },
  };
}
