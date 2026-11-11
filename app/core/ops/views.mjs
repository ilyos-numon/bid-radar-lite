// 운영 현황·서비스 현황 화면. 각 함수는 page(status, opts) 에 넘길 옵션을 돌려준다(둘 다 bare).
import { esc, notice } from '../html.mjs';
import { OPS_TEXT } from './stats.mjs';

const SUB_LABEL = { trialing: '체험', active: '이용 중', past_due: '결제 밀림', canceled: '해지', expired: '만료' };
const JOB_LABEL = { daily: '오늘의 공고', reminders: '마감 알림', support: '지원사업' };
const NOT_FOUND = '페이지를 찾을 수 없습니다';

const won = (n) => `${Number(n || 0).toLocaleString('ko-KR')}원`;
const n = (v) => Number(v || 0).toLocaleString('ko-KR');

/** ISO 시각 → 'YYYY-MM-DD HH:MM' (Asia/Seoul). 비면 null */
function kstTime(v) {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function tile(label, value, sub) {
  return `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd>${sub ? `<p class="help">${esc(sub)}</p>` : ''}</div>`;
}

/** @param {Awaited<ReturnType<ReturnType<typeof import('./stats.mjs').createOpsStats>['adminSummary']>>} s */
export function adminView(s) {
  const [tWs, tSub, tMrr, tFail, tJobs, tQueue, tDemo] = OPS_TEXT.admin.tiles;
  const subs = Object.entries(s.subscriptions)
    .map(([k, v]) => `${SUB_LABEL[k] ?? k} ${n(v)}`)
    .join(' · ');
  const jobs = Object.entries(s.jobsToday)
    .map(([k, v]) => `${JOB_LABEL[k] ?? k} ${n(v.done)}/${n(v.failed + v.dead)}`)
    .join(' · ');
  const billing = s.billingToday ? `결제 ${n(s.billingToday.charged)} · 실패 ${n(s.billingToday.failed)} · 만료 ${n(s.billingToday.expired)}` : '오늘 결제 작업 전';
  const demo = s.demo ? (kstTime(s.demo.seededAt) ?? '아직 안 함') : '데모 꺼짐';
  const tiles = [
    tile(tWs, `${n(s.workspaces.total)}곳`, s.workspaces.demo ? `예시 회사 ${n(s.workspaces.demo)}곳 포함` : null),
    tile(tSub, `${n(s.subscriptions.active)}곳 이용 중`, subs),
    tile(tMrr, won(s.mrr)),
    tile(tFail, `${n(s.paymentFailures30d)}건`),
    tile(tJobs, jobs, `성공/실패 · ${billing}`),
    tile(tQueue, s.queueDepth === null ? '정보 없음' : `${n(s.queueDepth)}건`),
    tile(tDemo, demo, s.demo ? `초기화 ${n(s.demo.resetCount)}회` : null),
  ].join('');
  const ex = s.example ? notice(OPS_TEXT.status.example) : '';
  return {
    title: OPS_TEXT.admin.title,
    heading: OPS_TEXT.admin.title,
    help: `기준 시각 ${kstTime(s.at) ?? ''}`,
    chrome: 'bare',
    body: `${ex}<section class="card me-card ops-admin"><dl class="tiles">${tiles}</dl></section>`,
  };
}

/** @param {{ date: string, bids: number, lastRunAt: string|null, deliveries: number, status: 'ok'|'degraded', example: boolean, collect?: { trigger: string, state: string } }} s */
export function statusView(s) {
  const T = OPS_TEXT.status;
  const state = s.status === 'ok' ? T.ok : T.degraded;
  const tiles = [
    tile(T.bids, `${n(s.bids)}건`),
    tile(T.lastRun, kstTime(s.lastRunAt) ?? T.none),
    tile(T.deliveries, `${n(s.deliveries)}건`),
    s.collect?.trigger === 'first-visit' ? tile(T.collect.label, T.collect[s.collect.state] ?? T.collect.pending) : '',
  ].join('');
  const ex = s.example ? `<p class="pill example-figures">${esc(T.example)}</p>` : '';
  return {
    title: T.title,
    heading: T.title,
    help: `${s.date} · ${state}`,
    chrome: 'bare',
    body: `<section class="card me-card ops-status" data-status="${esc(s.status)}">${ex}<dl class="tiles">${tiles}</dl></section>`,
  };
}

export function notFoundView() {
  return { title: NOT_FOUND, heading: NOT_FOUND, chrome: 'bare', body: '<p><a href="/">처음으로</a></p>' };
}
