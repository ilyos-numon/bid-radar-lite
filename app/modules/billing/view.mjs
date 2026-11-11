// 요금제 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).
// 카드 번호·결제 키는 화면에 쓰지 않는다. 카드는 카드사와 뒤 4자리 요약만 보인다.
import { PLANS, LIMIT_KINDS } from '../../core/billing/plans.mjs';
import { LIMIT_TEXT } from '../../core/billing/limits.mjs';

export const MENU = {
  title: '요금제',
  help: '지금 쓰는 요금제와 결제 상태를 보고, 카드 등록·요금제 변경·해지를 합니다.',
};

export const SDK_URL = 'https://js.tosspayments.com/v2/standard';

export const TEXT = {
  current: '지금 요금제',
  perPeriod: (price) => `30일 ${price.toLocaleString('ko-KR')}원`,
  free: '무료 14일',
  limitLine: (kind, n) => `${LIMIT_TEXT[kind]} ${n}${kind === 'members' ? '명' : '개'}`,
  choose: '이 요금제로',
  chooseBusy: '바꾸는 중…',
  trialing: (n) => `무료 체험 ${n}일 남음`,
  trialAfter: '체험이 끝나면 고른 요금제로 결제합니다. 카드가 없으면 이용이 멈춥니다.',
  active: (d) => `다음 결제일 ${d}`,
  autoChargeOff: '자동 결제가 꺼져 있습니다. 결제는 카드 등록 때 한 번만 일어납니다.',
  cancelAt: (d) => `${d}에 해지됩니다. 그날까지는 그대로 씁니다.`,
  pastDue: (d) => `결제가 밀렸습니다. ${d}에 다시 결제합니다.`,
  pastDueNext: '카드를 바꾸면 바로 다시 결제합니다.',
  locked: '이용이 멈췄습니다',
  lockedNext: '요금제를 고르고 카드를 등록하면 다시 쓸 수 있습니다',
  lockedReason: { trial_expired: '무료 체험이 끝났습니다.', past_due_expired: '결제가 여러 번 실패해 이용이 멈췄습니다.', canceled: '해지한 요금제의 기간이 끝났습니다.' },
  statusTitle: '결제 상태',
  cardTitle: '결제 카드',
  noCard: '등록된 카드 없음',
  addCard: '카드 등록',
  changeCard: '카드 바꾸기',
  notReady: '결제 준비 안 됨. 운영자가 결제 연결을 마치면 카드를 등록할 수 있습니다.',
  ownerOnlyNotice: '요금제와 카드는 대표만 바꿀 수 있습니다',
  ownerOnly: '요금제와 카드는 대표만 바꿀 수 있습니다',
  ownerOnlyNext: '대표에게 요청해 주세요',
  cancel: '해지',
  cancelBusy: '해지하는 중…',
  cancelHint: '해지하면 이번 결제 기간이 끝날 때 멈춥니다. 돈을 돌려주지는 않습니다.',
  resume: '해지 취소',
  resumeBusy: '되돌리는 중…',
  historyTitle: '최근 결제',
  historyEmpty: '아직 결제한 내역이 없습니다',
  col: { date: '날짜', plan: '요금제', amount: '금액', status: '결과' },
  payStatus: { paid: '결제됨', failed: '실패', canceled: '취소됨', ready: '대기' },
  won: (n) => `${Number(n).toLocaleString('ko-KR')}원`,
  savedPlan: (name) => `${name} 요금제로 바꿨습니다.`,
  savedPlanNoCard: (name) => `${name} 요금제를 골랐습니다. 카드를 등록해 주세요.`,
  paid: '결제를 마쳤습니다.',
  chargeFailed: '결제하지 못했습니다',
  chargeFailedNext: '카드를 확인하거나 다른 카드로 바꿔 주세요',
  cardSaved: '카드를 등록했습니다.',
  canceled: '해지를 예약했습니다.',
  resumed: '해지를 취소했습니다.',
  badPlan: '고를 수 없는 요금제입니다',
  badPlanNext: '아래 카드에서 다시 골라 주세요',
  cardPageTitle: '카드 등록',
  cardPageHelp: '카드 정보는 결제 대행사 화면에서 입력합니다. 이 서비스에는 카드사와 뒤 4자리만 남습니다.',
  cardStart: '카드 정보 입력하기',
  cardStartBusy: '여는 중…',
  cardOpenFailed: '카드 입력 화면을 열지 못했습니다. 잠시 뒤 다시 눌러 주세요.',
  back: '요금제로 돌아가기',
  cardFailed: '카드를 등록하지 못했습니다',
  cardFailedNext: '카드 정보를 확인한 뒤 다시 시도해 주세요',
  failCode: (code) => `오류 코드: ${code}`,
  mismatch: '다른 회사의 카드 등록 요청입니다',
  mismatchNext: '요금제 화면에서 다시 시작해 주세요',
  noAuth: '카드 등록 결과를 받지 못했습니다',
  noAuthNext: '요금제 화면에서 다시 시작해 주세요',
};

/** 예약 실행이 꺼진 운영이면 결제 줄 뒤에 `?` 안내 */
function autoChargeTip(h) {
  return h.schedulerOff ? ` ${h.tip(TEXT.autoChargeOff)}` : '';
}

function statusBlock(h, { sub, access }) {
  const parts = [];
  if (sub.status === 'trialing') {
    parts.push(`<p data-status="trialing" style="margin:0;font-weight:700">${h.esc(TEXT.trialing(access.trialDaysLeft ?? 0))}</p>`);
    parts.push(`<p style="margin:0;font-size:14px;color:var(--ink-2)">${h.esc(TEXT.trialAfter)}${autoChargeTip(h)}</p>`);
  } else if (sub.status === 'active') {
    parts.push(`<p data-status="active" style="margin:0;font-weight:700">${h.esc(TEXT.active(sub.nextDate))}${autoChargeTip(h)}</p>`);
    if (sub.cancelAtPeriodEnd) parts.push(h.notice(TEXT.cancelAt(sub.periodDate), { kind: 'warn' }));
  } else if (sub.status === 'past_due') {
    parts.push(`<p data-status="past_due" style="margin:0;font-weight:700">${h.esc(TEXT.pastDue(sub.nextDate))}</p>`);
    parts.push(`<p style="margin:0;font-size:14px;color:var(--ink-2)">${h.esc(TEXT.pastDueNext)}</p>`);
  } else {
    parts.push(`<p data-status="locked" style="margin:0;font-weight:700">${h.esc(TEXT.locked)}</p>`);
    const why = TEXT.lockedReason[access.reason];
    if (why) parts.push(`<p style="margin:0;font-size:14px;color:var(--ink-2)">${h.esc(why)}</p>`);
  }
  return `<section class="card" id="billing-status" style="display:flex;flex-direction:column;gap:8px;margin:0 0 16px">
<h2 style="margin:0;font-size:18px;font-weight:700">${TEXT.statusTitle}</h2>
${parts.join('\n')}
</section>`;
}

function planCard(h, plan, { current, canEdit }) {
  const isCurrent = plan.id === current;
  const price = plan.price > 0 ? TEXT.perPeriod(plan.price) : TEXT.free;
  const limits = LIMIT_KINDS.map((k) => `<li>${h.esc(TEXT.limitLine(k, plan.limits[k]))}</li>`).join('');
  const button =
    plan.price > 0
      ? `<form method="post" action="/billing/plan" style="margin:0"><input type="hidden" name="plan" value="${h.esc(plan.id)}"><button type="submit"${isCurrent ? ' class="secondary"' : ''}${canEdit ? '' : ' disabled'} data-busy="${TEXT.chooseBusy}">${TEXT.choose}</button></form>`
      : '';
  return `<section class="card" data-plan="${h.esc(plan.id)}"${isCurrent ? ' data-current="1" aria-current="true"' : ''} style="display:flex;flex-direction:column;gap:10px;margin:0">
<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px"><h3 style="margin:0;font-size:17px;font-weight:700">${h.esc(plan.name)}</h3>${isCurrent ? h.badge({ label: TEXT.current, kind: 'ok' }) : ''}</div>
<p style="margin:0;font-size:20px;font-weight:700">${h.esc(price)}</p>
<ul style="margin:0;padding-left:18px;font-size:14px;color:var(--ink-body)">${limits}</ul>
${button}
</section>`;
}

function cardBlock(h, { sub, tossReady, canEdit }) {
  const can = tossReady && canEdit;
  const label = sub.cardSummary ? TEXT.changeCard : TEXT.addCard;
  const link = can
    ? `<a class="button secondary" id="billing-card-link" href="/billing/card">${label}</a>`
    : `<button type="button" class="secondary" id="billing-card-link" disabled>${label}</button>`;
  return `<section class="card" id="billing-card" style="display:flex;flex-direction:column;gap:10px;margin:0 0 16px">
<h2 style="margin:0;font-size:18px;font-weight:700">${TEXT.cardTitle}</h2>
<p data-card style="margin:0">${h.esc(sub.cardSummary || TEXT.noCard)}</p>
${tossReady ? '' : `<div data-not-ready>${h.notice(TEXT.notReady, { kind: 'warn' })}</div>`}
<p style="margin:0">${link}</p>
</section>`;
}

function cancelBlock(h, { sub, canEdit }) {
  if (sub.status !== 'active') return '';
  const off = canEdit ? '' : ' disabled';
  const form = sub.cancelAtPeriodEnd
    ? `<form method="post" action="/billing/resume" style="margin:0"><button type="submit" class="secondary"${off} data-busy="${TEXT.resumeBusy}">${TEXT.resume}</button></form>`
    : `<form method="post" action="/billing/cancel" style="margin:0"><button type="submit" class="secondary quiet"${off} data-busy="${TEXT.cancelBusy}">${TEXT.cancel}</button></form>
<p style="margin:0;font-size:13px;color:var(--ink-2)">${TEXT.cancelHint}</p>`;
  return `<section class="card" id="billing-cancel" style="display:flex;flex-direction:column;gap:8px;margin:0 0 16px">${form}</section>`;
}

function historyBlock(h, payments, ymd) {
  const body = payments.length
    ? `<table><thead><tr><th>${TEXT.col.date}</th><th>${TEXT.col.plan}</th><th>${TEXT.col.amount}</th><th>${TEXT.col.status}</th></tr></thead><tbody>${payments
        .map(
          (p) =>
            `<tr data-payment="${h.esc(p.status)}"><td>${h.esc(ymd(p.approvedAt || p.createdAt))}</td><td>${h.esc(PLANS[p.plan]?.name ?? p.plan)}</td><td>${h.esc(TEXT.won(p.amount))}</td><td>${h.esc(TEXT.payStatus[p.status] ?? p.status)}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : `<p style="margin:0;color:var(--ink-2)">${TEXT.historyEmpty}</p>`;
  return `<section class="card" id="billing-history" style="display:flex;flex-direction:column;gap:10px;margin:0">
<h2 style="margin:0;font-size:18px;font-weight:700">${TEXT.historyTitle}</h2>
${body}
</section>`;
}

/**
 * @param {object} h ctx.html
 * @param {{ sub: object, access: object, payments: object[], tossReady: boolean, canEdit: boolean, locked?: boolean, notice?: string, error?: {message:string,next:string}|null, ymd: (v: string) => string }} d
 */
export function billingBody(h, d) {
  const parts = [];
  if (d.locked || !d.access.active) parts.push(`<div data-locked>${h.error(TEXT.locked, TEXT.lockedNext)}</div>`);
  if (d.error) parts.push(h.error(d.error.message, d.error.next));
  if (d.notice) parts.push(h.notice(d.notice, { kind: 'success', role: 'status' }));
  if (!d.canEdit) parts.push(`<div data-owner-only>${h.notice(TEXT.ownerOnlyNotice, { kind: 'info' })}</div>`);
  parts.push(statusBlock(h, d));
  parts.push(
    `<div id="billing-plans" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin:0 0 16px">${Object.values(PLANS)
      .map((p) => planCard(h, p, { current: d.sub.plan, canEdit: d.canEdit }))
      .join('\n')}</div>`,
  );
  parts.push(cardBlock(h, d));
  parts.push(cancelBlock(h, d));
  parts.push(historyBlock(h, d.payments, d.ymd));
  return parts.filter(Boolean).join('\n');
}

/** JSON 을 script 안에 넣을 때: < > & 와 줄 구분 문자를 이스케이프 */
function scriptJson(v) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 카드 등록 화면. 인라인 스크립트에는 브라우저용 공개 키·customerKey·돌아올 주소만 넣는다
 * @param {object} h ctx.html
 * @param {{ ready: boolean, clientKey?: string, customerKey?: string, successUrl?: string, failUrl?: string }} d
 */
export function cardBody(h, d) {
  const back = `<p><a href="/billing">${TEXT.back}</a></p>`;
  if (!d.ready) {
    return `<div data-not-ready>${h.notice(TEXT.notReady, { kind: 'warn' })}</div>
<p><button type="button" id="card-start" disabled>${TEXT.cardStart}</button></p>
${back}`;
  }
  const cfg = scriptJson({ clientKey: d.clientKey, customerKey: d.customerKey, successUrl: d.successUrl, failUrl: d.failUrl });
  const failText = scriptJson(TEXT.cardOpenFailed);
  return `<p style="margin:0 0 12px;color:var(--ink-body)">${h.esc(TEXT.cardPageHelp)}</p>
<p><button type="button" id="card-start">${TEXT.cardStart}</button></p>
<p id="card-error" role="alert" hidden></p>
${back}
<script src="${SDK_URL}"></script>
<script>
(function () {
  var cfg = ${cfg};
  var btn = document.getElementById('card-start');
  var out = document.getElementById('card-error');
  btn.addEventListener('click', function () {
    btn.disabled = true;
    try {
      var payment = TossPayments(cfg.clientKey).payment({ customerKey: cfg.customerKey });
      Promise.resolve(payment.requestBillingAuth({ method: 'CARD', successUrl: cfg.successUrl, failUrl: cfg.failUrl })).catch(fail);
    } catch (e) {
      fail();
    }
    function fail() {
      btn.disabled = false;
      out.textContent = ${failText};
      out.hidden = false;
    }
  });
})();
</script>`;
}

/** 카드 등록 실패 (토스 fail 콜백·발급 실패) */
export function cardFailBody(h, code) {
  const codeLine = code ? `<p data-fail-code style="font-size:14px;color:var(--ink-2)">${h.esc(TEXT.failCode(code))}</p>` : '';
  return `${h.error(TEXT.cardFailed, TEXT.cardFailedNext)}${codeLine}<p><a href="/billing">${TEXT.back}</a></p>`;
}

/** 대표가 아닌 구성원 */
export function ownerOnlyBody(h) {
  return `${h.error(TEXT.ownerOnly, TEXT.ownerOnlyNext)}<p><a href="/billing">${TEXT.back}</a></p>`;
}

/** customerKey 불일치·authKey 없음 */
export function rejectBody(h, message, next) {
  return `${h.error(message, next)}<p><a href="/billing">${TEXT.back}</a></p>`;
}
