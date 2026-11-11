// 추천 키워드 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).

export const MENU = {
  title: '추천 키워드',
  help: '지금 키워드와 비슷한 말을 제안하고, 채택한 말로 관련 가능성 있는 공고를 1건까지 더 찾습니다.',
};

export const TEXT = {
  findButton: '비슷한 키워드 찾기',
  emptyMessage: '제안받은 키워드가 없습니다.',
  currentKeywords: '지금 키워드',
  currentHelp: '알림 설정의 업종 키워드입니다. 비슷한 말은 정확한 조건 매칭에 영향을 주지 않습니다.',
  suggestedCount: (n) => `${n}개 · 쓸 말은 채택을 눌러 주세요`,
  on: '켜짐',
  off: '꺼짐',
  noKeywords: '알림 설정에 키워드가 없습니다',
  suggestedTitle: '제안받은 말',
  acceptedTitle: '쓰는 중',
  rejectedTitle: '쓰지 않기로 한 말',
  noSuggested: '새로 제안받은 말이 없습니다.',
  noAccepted: '아직 채택한 말이 없습니다. 제안받은 말에서 채택을 누르면 여기에 옵니다.',
  accept: '채택',
  reject: '거절',
  stopUsing: '그만 쓰기',
  useAgain: '다시 쓰기',
  similarOf: (kw) => `${kw} 의 비슷한 말`,
  maybeTitle: '관련 가능성 있음',
  maybeOn: '켜짐 — 쓰는 중인 말로 조건에 안 맞은 공고 중 1건까지 오늘의 공고 맨 아래에 더 보여 줍니다.',
  maybeOff: '꺼짐 — 오늘의 공고와 알림에 관련 가능성 있는 공고를 더 보여 주지 않습니다.',
  turnOn: '켜기',
  turnOff: '끄기',
  added: (n) => `비슷한 키워드 ${n}개를 새로 받았습니다. 쓸 말은 채택을 눌러 주세요.`,
  addedNone: '새로 받은 비슷한 키워드가 없습니다. 이미 있는 말과 지금 키워드는 건너뜁니다.',
  failed: '추천 키워드를 가져오지 못했습니다',
  failedNext: '잠시 후 다시 눌러 주세요',
  notReady: '비슷한 키워드 찾기 준비가 안 됐습니다',
  notReadyNext: '운영자가 자동 제안 연결을 마친 뒤 다시 눌러 주세요',
};

/** 제안 실패 결과 → 화면 오류 문구. 영문 코드는 보여 주지 않는다 */
export function suggestError(code) {
  return code === 'NO_KEY' ? { message: TEXT.notReady, next: TEXT.notReadyNext } : { message: TEXT.failed, next: TEXT.failedNext };
}

const BTN = {
  accept: 'secondary small',
  reject: 'secondary small quiet',
};

function actionButton(h, word, action, label, cls) {
  const href = `/keywords/${encodeURIComponent(word)}/${action}`;
  return `<form method="post" action="${h.esc(href)}" style="display:inline;margin:0"><button type="submit" class="${cls}" aria-label="${h.esc(`${word} ${label}`)}">${h.esc(label)}</button></form>`;
}

function buttons(h, s, actions, cls) {
  return actions.map(([action, label, c]) => actionButton(h, s.word, action, label, c || cls)).join(' ');
}

// 제안받은 말: 한 카드 안의 줄. li.card[data-word] 는 그대로 두고 줄 모양으로 덮어쓴다
const ROW_CARD =
  'margin:0;border:0;border-radius:0;border-bottom:1px solid var(--divider);padding:18px 24px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px 20px';

function row(h, s, actions, last) {
  const forText = s.forKeyword ? ` <span class="for hint" style="font-size:14px">· ${h.esc(TEXT.similarOf(s.forKeyword))}</span>` : '';
  const why = s.why ? `<p class="why hint" style="margin:0;font-size:14px">${h.esc(s.why)}</p>` : '';
  return `<li class="card" data-word="${h.esc(s.word)}" style="${ROW_CARD}${last ? ';border-bottom:0' : ''}"><div style="display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 360px"><p style="margin:0;font-size:16px"><strong class="word">${h.esc(s.word)}</strong>${forText}</p>${why}</div><div style="display:flex;gap:8px;flex-wrap:wrap">${buttons(h, s, actions, BTN.reject)}</div></li>`;
}

// 쓰는 중·쓰지 않기로 한 말: 작은 줄
const SMALL_CARD = 'margin:0;border:0;border-radius:0;padding:0;background:transparent;display:flex;justify-content:space-between;align-items:center;gap:12px';

function smallRow(h, s, actions, struck) {
  const forText = s.forKeyword ? ` <span class="for hint">· ${h.esc(TEXT.similarOf(s.forKeyword))}</span>` : '';
  const wordStyle = struck ? 'font-size:15px;color:var(--ink-2);text-decoration:line-through' : 'font-size:15px;font-weight:500';
  return `<li class="card" data-word="${h.esc(s.word)}" style="${SMALL_CARD}"><span style="min-width:0"><span class="word" style="${wordStyle}">${h.esc(s.word)}</span>${forText}</span>${buttons(h, s, actions, BTN.reject)}</li>`;
}

const PANEL = 'flex:1 1 360px;min-width:0;margin:0;padding:20px 24px;display:flex;flex-direction:column;gap:12px';

/**
 * @param {object} h ctx.html
 * @param {{ keywords: string[], suggested: object[], accepted: object[], rejected: object[], maybeOn: boolean, error?: {message:string,next:string}|null, notice?: string|null }} data
 */
export function keywordsBody(h, { keywords, suggested, accepted, rejected, maybeOn, error = null, notice = null }) {
  const parts = [];
  if (error) parts.push(h.error(error.message, error.next));
  if (notice) parts.push(h.notice(notice, { kind: 'success', role: 'status' }));

  const chips =
    keywords.length > 0
      ? `<div class="chips" style="display:flex;flex-wrap:wrap;gap:6px">${keywords
          .map((k) => `<span class="chip" style="padding:4px 12px;border-radius:8px;background:var(--chip-bg);font-size:15px;font-weight:500">${h.esc(k)}</span>`)
          .join('')}</div>`
      : `<p style="margin:0">${TEXT.noKeywords}</p>`;
  parts.push(`<section id="suggest" class="card" aria-labelledby="kw-now" style="margin:0;padding:24px 28px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:16px 24px">
<div style="display:flex;flex-direction:column;gap:10px;min-width:0">
<h2 id="kw-now" style="margin:0;font-size:15px;font-weight:700;color:var(--ink-body)">${TEXT.currentKeywords}</h2>
${chips}
<p class="hint" style="margin:0">${TEXT.currentHelp}</p>
</div>
<form method="post" action="/keywords/suggest" style="margin:0"><button type="submit">${TEXT.findButton}</button></form>
</section>`);

  const none = suggested.length === 0 && accepted.length === 0 && rejected.length === 0;
  if (none) parts.push(h.empty(TEXT.emptyMessage, { href: '#suggest', label: TEXT.findButton }));

  if (!none) {
    const suggestedList =
      suggested.length > 0
        ? `<ul class="card" style="list-style:none;margin:0;padding:0;overflow:hidden">${suggested
            .map((s, i) => row(h, s, [['accept', TEXT.accept, BTN.accept], ['reject', TEXT.reject, BTN.reject]], i === suggested.length - 1))
            .join('')}</ul>`
        : `<p style="margin:0">${TEXT.noSuggested}</p>`;
    parts.push(`<section aria-labelledby="kw-suggested" style="display:flex;flex-direction:column;gap:12px">
<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px"><h2 id="kw-suggested" style="margin:0;font-size:18px;font-weight:700">${TEXT.suggestedTitle}</h2><span class="hint" style="font-size:14px">${h.esc(TEXT.suggestedCount(suggested.length))}</span></div>
${suggestedList}
</section>`);

    const acceptedList =
      accepted.length > 0
        ? `<ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px">${accepted.map((s) => smallRow(h, s, [['reject', TEXT.stopUsing]], false)).join('')}</ul>`
        : `<p style="margin:0;font-size:14px;color:var(--ink-2)">${TEXT.noAccepted}</p>`;
    const columns = [
      `<section class="card" aria-labelledby="kw-accepted" style="${PANEL}"><h2 id="kw-accepted" style="margin:0;font-size:16px;font-weight:700">${TEXT.acceptedTitle}</h2>${acceptedList}</section>`,
    ];
    if (rejected.length > 0) {
      columns.push(
        `<section class="card" aria-labelledby="kw-rejected" style="${PANEL}"><h2 id="kw-rejected" style="margin:0;font-size:16px;font-weight:700;color:var(--ink-2)">${TEXT.rejectedTitle}</h2><ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px">${rejected
          .map((s) => smallRow(h, s, [['accept', TEXT.useAgain]], true))
          .join('')}</ul></section>`,
      );
    }
    parts.push(`<div class="columns" style="display:flex;flex-wrap:wrap;gap:16px">${columns.join('')}</div>`);
  }

  const pill = maybeOn
    ? `<span class="pill on" style="font-weight:700"><span aria-hidden="true" style="width:6px;height:6px;border-radius:50%;background:currentColor"></span>${TEXT.on}</span>`
    : `<span class="pill" style="font-weight:700"><span aria-hidden="true" style="width:6px;height:6px;border-radius:50%;background:var(--muted-dot)"></span>${TEXT.off}</span>`;
  const toggle = `<form method="post" action="/keywords/maybe" style="margin:0"><input type="hidden" name="enabled" value="${maybeOn ? 'false' : 'true'}"><button type="submit" class="secondary">${maybeOn ? TEXT.turnOff : TEXT.turnOn}</button></form>`;
  parts.push(`<section class="card" aria-labelledby="kw-maybe" style="margin:0;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px 24px">
<div style="display:flex;flex-direction:column;gap:4px;flex:1 1 420px;min-width:0">
<div style="display:flex;align-items:center;gap:10px"><h2 id="kw-maybe" style="margin:0;font-size:16px;font-weight:700">${TEXT.maybeTitle}</h2>${pill}</div>
<p style="margin:0;font-size:14px;color:var(--ink-2)">${maybeOn ? TEXT.maybeOn : TEXT.maybeOff}</p>
</div>
${toggle}
</section>`);
  return parts.join('\n');
}
