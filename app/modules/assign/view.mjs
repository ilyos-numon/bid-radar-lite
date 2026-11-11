// 업무 분배 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).
import { STATUSES, statusLabel, formatTime } from './service.mjs';

export const MENU = {
  title: '업무 분배',
  help: '공고를 담당자에게 넘기고 검토중 · 참여 · 패스를 함께 봅니다.',
};

export const TEXT = {
  emptyMessage: '담당자를 정한 공고가 없습니다.',
  emptyLink: '오늘의 공고에서 고르기',
  groupEmpty: '이 상태의 공고가 없습니다.',
  membersLink: '구성원 보기',
  boardLink: '업무 분배로 돌아가기',
  assignee: '담당자',
  status: '상태',
  note: '메모',
  save: '저장',
  updated: '마지막 수정',
  noTitle: '제목 없는 공고',
  unknownMember: '미정',
  notFound: '공고를 찾지 못했습니다',
  notFoundNext: '오늘의 공고에서 다시 골라 주세요',
  badStatus: '상태는 검토중 / 참여 / 패스 중 하나입니다',
  badStatusNext: '상태를 다시 골라 저장해 주세요',
  badAssignee: '담당자를 고르지 않았습니다',
  badAssigneeNext: '구성원 목록에서 담당자를 골라 저장해 주세요',
  membersTitle: '구성원',
  membersHelp: '함께 쓰는 사람을 초대 링크로 추가합니다. 대표를 포함해 5명까지 둘 수 있습니다.',
  role: { owner: '대표', staff: '구성원' },
  name: '이름',
  invite: '초대 링크 만들기',
  ownerOnly: '구성원 초대는 대표만 할 수 있습니다',
  ownerOnlyNext: '초대가 필요하면 대표에게 요청해 주세요',
  ownerOnlyNotice: '구성원 초대는 대표만 할 수 있습니다.',
  limit: '구성원은 5명까지 둘 수 있습니다',
  limitNext: '지금 있는 구성원과 함께 써 주세요',
  noName: '이름을 적지 않았습니다',
  noNameNext: '초대할 사람의 이름을 적은 뒤 다시 눌러 주세요',
  inviteFailed: '초대 링크를 만들지 못했습니다',
  inviteFailedNext: '잠시 뒤 다시 눌러 주세요',
  created: (name) => `${name} 님의 초대 링크를 만들었습니다.`,
  onlyNow: '이 링크는 지금만 보입니다. 복사해서 전해 주세요.',
  linkLabel: '초대 링크',
  memberCount: (n) => `구성원 ${n}명`,
  memberMax: '대표를 포함해 5명까지',
  inviteHint: '이름을 적고 누르면 그 사람만 쓸 수 있는 초대 링크가 한 번 보입니다.',
  boardNote: '담당을 한 번이라도 정한 공고만 여기에 나옵니다.',
  boardNoteNew: (link) => `새 공고는 ${link}를 눌러 넘깁니다.`,
  boardNoteLink: '오늘의 공고에서 담당자 정하기',
  pending: '초대 대기',
  remove: '내보내기',
  removeOwnerOnly: '구성원 내보내기는 대표만 할 수 있습니다.',
  removeOwnerOnlyNext: '내보내야 할 사람이 있으면 대표에게 요청해 주세요',
  removeSelf: '본인은 내보낼 수 없습니다',
  removeSelfNext: '다른 구성원을 골라 주세요',
  removeOwner: '대표는 내보낼 수 없습니다',
  removeOwnerNext: '구성원 목록에서 다른 사람을 골라 주세요',
  removeNotFound: '구성원을 찾지 못했습니다',
  removeNotFoundNext: '구성원 목록을 새로 열어 다시 골라 주세요',
  removeFailed: '구성원을 내보내지 못했습니다',
  removeFailedNext: '잠시 뒤 다시 눌러 주세요',
  removed: (name) => `${name} 님을 내보냈습니다.`,
};

function bidTitle(item) {
  return item.title || TEXT.noTitle;
}

// 구성원별 아바타 색 (구성원 목록 순서대로 돌려 쓴다)
const AVATAR_COLORS = [
  ['var(--primary-soft)', 'var(--primary)'],
  ['#E8F5EC', 'var(--ok)'],
  ['#F3EEFD', 'var(--summary)'],
  ['var(--check-bg)', 'var(--check)'],
  ['var(--chip-bg)', 'var(--ink-body)'],
];

// 상태 칸의 색 점
const STATUS_DOT = { review: 'var(--check)', go: 'var(--primary)', pass: 'var(--muted-dot)' };

function colorFor(members, id, name) {
  const i = members.findIndex((m) => String(m.id) === String(id));
  if (i >= 0) return AVATAR_COLORS[i % AVATAR_COLORS.length];
  const code = Array.from(String(name ?? '')).reduce((n, ch) => n + ch.codePointAt(0), 0);
  return AVATAR_COLORS[code % AVATAR_COLORS.length];
}

/** 색을 입힌 이니셜 아바타 (읽기 도구에서는 숨김: 옆에 이름 글자가 있다) */
function avatar(h, members, { id, name }, size, extra = '') {
  const [bg, fg] = colorFor(members, id, name);
  const first = Array.from(String(name ?? '').trim())[0] ?? '';
  return `<span class="avatar" aria-hidden="true" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.45)}px;background:${bg};color:${fg}${extra}">${h.esc(first)}</span>`;
}

function updatedLine(h, item) {
  const when = formatTime(item.updatedAt);
  if (!when) return '';
  return `<p class="updated" style="margin:0;font-size:12px;color:var(--ink-3);font-variant-numeric:tabular-nums">${TEXT.updated} ${h.esc(when)}${item.updatedByName ? ` (${h.esc(item.updatedByName)})` : ''}</p>`;
}

/** 예시 데이터 칩 (헬퍼에 없으면 빈 글자) */
function exampleTag(h, example) {
  if (!example || typeof h.exampleChip !== 'function') return '';
  return ` ${h.exampleChip()}`;
}

function itemCard(h, item, members, today, example = false) {
  const who = item.name || TEXT.unknownMember;
  const pass = item.status === 'pass';
  const dim = pass ? ';color:var(--ink-2)' : '';
  return `<li class="card" style="margin:0;padding:16px;border-radius:12px;display:flex;flex-direction:column;gap:10px">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">
<h3 class="title" style="margin:0;font-size:15px;line-height:1.45"><a href="/assign/${h.esc(encodeURIComponent(item.bidId))}" style="text-decoration:none;color:${pass ? 'var(--ink-2)' : 'var(--ink)'}">${h.esc(bidTitle(item))}</a>${exampleTag(h, example)}</h3>
${item.deadline ? h.ddayChip(item.deadline, today) : ''}
</div>
<p class="facts" style="margin:0;display:flex;align-items:center;gap:8px;font-size:14px${dim}">${avatar(h, members, { id: item.assigneeId, name: who }, 24)}담당 ${h.esc(who)}</p>
${item.note ? `<p class="note" style="margin:0;padding:8px 12px;border-radius:8px;background:var(--reasons-bg);font-size:14px;color:var(--ink-body)${dim}">${TEXT.note}: ${h.esc(item.note)}</p>` : ''}
${updatedLine(h, item)}
</li>`;
}

/** 제목 오른쪽: 구성원 아바타 묶음 + 인원 + 구성원 보기 (layout actions) */
export function boardActions(h, members = []) {
  const stack = members
    .slice(0, 5)
    .map((m, i) => avatar(h, members, m, 30, `;border:2px solid var(--bg)${i ? ';margin-left:-8px' : ''}`))
    .join('');
  return `<span class="avatars" style="display:inline-flex">${stack}</span>
<span class="member-count" style="font-size:14px;color:var(--ink-2)">${TEXT.memberCount(members.length)}</span>
<a class="button secondary" href="/assign/members" style="min-height:44px">${TEXT.membersLink}</a>`;
}

/**
 * @param {object} h ctx.html
 * @param {{ groups: Array<{status:string,label:string,items:object[]}>, members?: object[], today?: string, example?: boolean }} data
 */
export function boardBody(h, { groups, members = [], today = '', example = false }) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  if (total === 0) return h.empty(TEXT.emptyMessage, { href: '/today', label: TEXT.emptyLink });
  const cols = groups.map((g) => {
    const list = g.items.length
      ? `<ol class="bids" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px">${g.items.map((i) => itemCard(h, i, members, today, example)).join('')}</ol>`
      : `<p style="margin:0;padding:12px 6px;font-size:14px;color:var(--ink-2)">${TEXT.groupEmpty}</p>`;
    return `<section aria-labelledby="g-${g.status}" style="flex:1 1 260px;min-width:0;background:#ECEFF3;border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:10px">
<div style="display:flex;align-items:center;gap:8px;padding:4px 6px">
<span aria-hidden="true" style="width:8px;height:8px;border-radius:50%;background:${STATUS_DOT[g.status] ?? 'var(--muted-dot)'}"></span>
<h2 id="g-${g.status}" style="margin:0;font-size:15px;font-weight:700">${h.esc(g.label)}</h2>
<span class="count" style="font-size:14px;color:var(--ink-2)">${g.items.length}</span>
</div>
${list}
</section>`;
  });
  return `<div class="board" style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start">
${cols.join('\n')}
</div>
<p class="board-note" style="font-size:14px;color:var(--ink-2)">${TEXT.boardNote} ${TEXT.boardNoteNew(`<a href="/today" style="font-weight:500">${TEXT.boardNoteLink}</a>`)}</p>`;
}

/** boardBody 의 다른 이름 */
export function assignBoardBody(h, data) {
  return boardBody(h, data);
}

/**
 * @param {object} h ctx.html
 * @param {{ bid: object, members: Array<{id:number,name:string,role:string}>, values: {assignee: string, status: string, note: string}, item: object|null, error?: {message:string,next:string}|null, today?: string }} data
 */
export function formBody(h, { bid, members, values, item, error, today = '' }) {
  const parts = [];
  if (error) parts.push(h.error(error.message, error.next));
  const when = item ? formatTime(item.updatedAt) : '';
  parts.push(`<div class="card" style="margin:0;display:flex;flex-direction:column;gap:4px">
<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px">
<div style="min-width:0"><h2 class="title" style="margin:0">${h.esc(bid.title || TEXT.noTitle)}</h2>${bid.org ? `<p class="org" style="margin:0">${h.esc(bid.org)}</p>` : ''}</div>
${bid.deadline ? h.ddayChip(bid.deadline, today) : ''}
</div>
${when ? `<p class="updated" style="margin:4px 0 0;font-size:13px;color:var(--ink-2)">${TEXT.updated} ${h.esc(when)}${item.updatedByName ? ` (${h.esc(item.updatedByName)})` : ''}</p>` : ''}
</div>`);
  const memberOptions = members
    .map((m) => `<option value="${m.id}"${String(m.id) === String(values.assignee) ? ' selected' : ''}>${h.esc(m.name)} (${h.esc(TEXT.role[m.role] ?? '')})</option>`)
    .join('');
  const statusOptions = STATUSES.map(
    (s) => `<option value="${s}"${s === values.status ? ' selected' : ''}>${h.esc(statusLabel(s))}</option>`,
  ).join('');
  parts.push(`<form class="stack card" method="post" action="/assign/${h.esc(encodeURIComponent(bid.bidId))}" style="margin:0;max-width:none">
<label>${TEXT.assignee}<select name="assignee" required>${memberOptions}</select></label>
<label>${TEXT.status}<select name="status" required>${statusOptions}</select></label>
<label>${TEXT.note}<textarea name="note" rows="3">${h.esc(values.note)}</textarea></label>
<div style="display:flex;flex-wrap:wrap;gap:12px"><button type="submit">${TEXT.save}</button> <a class="button secondary" href="/assign">${TEXT.boardLink}</a></div>
</form>`);
  return parts.join('\n');
}

export function notFoundBody(h) {
  return `${h.error(TEXT.notFound, TEXT.notFoundNext)}<p><a class="button secondary" href="/today">${TEXT.emptyLink}</a></p>`;
}

// 내보내기 버튼: 대표 화면에서만, 본인과 다른 대표는 빼고
function removeCell(h, m, canRemove, selfId) {
  if (!canRemove) return '';
  const show = m.role !== 'owner' && String(m.id) !== String(selfId);
  const form = show
    ? `<form method="post" action="/assign/members/${h.esc(encodeURIComponent(String(m.id)))}/remove" style="margin:0"><button type="submit" class="secondary" aria-label="${h.esc(m.name)} ${TEXT.remove}">${TEXT.remove}</button></form>`
    : '';
  return `<td style="padding:12px 20px;text-align:right">${form}</td>`;
}

function memberTable(h, members, canRemove = false, selfId = null) {
  const rowsHtml = members
    .map(
      (m) => `<tr><td style="padding:12px 20px"><span style="display:inline-flex;align-items:center;gap:10px">${avatar(h, members, m, 28)}<span style="font-weight:500">${h.esc(m.name)}</span></span></td><td style="padding:12px 20px"><span class="pill${m.role === 'owner' ? ' on' : ''}">${h.esc(TEXT.role[m.role] ?? '')}</span>${m.pending ? ` <span class="pill pending">${TEXT.pending}</span>` : ''}</td>${removeCell(h, m, canRemove, selfId)}</tr>`,
    )
    .join('');
  const removeHead = canRemove ? '<th scope="col" style="padding:12px 20px"></th>' : '';
  return `<div class="card" style="margin:0;padding:0;overflow:hidden"><table><thead><tr><th scope="col" style="padding:12px 20px;font-size:13px;font-weight:500;color:var(--ink-2)">${TEXT.name}</th><th scope="col" style="padding:12px 20px;font-size:13px;font-weight:500;color:var(--ink-2)">역할</th>${removeHead}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
}

/**
 * @param {object} h ctx.html
 * @param {{ members: object[], canInvite: boolean, selfId?: number|null, name?: string, error?: {message:string,next:string}|null, created?: {name:string, link:string}|null, removed?: {name:string}|null }} data
 */
export function membersBody(h, { members, canInvite, selfId = null, name = '', error = null, created = null, removed = null }) {
  const parts = [];
  if (error) parts.push(h.error(error.message, error.next));
  if (removed) {
    parts.push(`<div class="notice success" role="status" style="margin:0"><p>${h.icon('check-circle')}${h.esc(TEXT.removed(removed.name))}</p></div>`);
  }
  if (created) {
    parts.push(`<div class="notice success" role="status" style="margin:0;display:flex;flex-direction:column;gap:10px">
<p>${h.icon('check-circle')}${h.esc(TEXT.created(created.name))}</p>
<label style="color:var(--ink)">${TEXT.linkLabel}<input type="text" readonly value="${h.esc(created.link)}" onfocus="this.select()"></label>
<p style="color:var(--ink-body);font-weight:400">${TEXT.onlyNow}</p>
</div>`);
  }
  parts.push(`<p class="list-meta" style="font-size:14px;color:var(--ink-2)">${TEXT.memberCount(members.length)} · ${TEXT.memberMax}</p>`);
  parts.push(memberTable(h, members, canInvite, selfId));
  if (canInvite) {
    parts.push(`<form class="stack card" method="post" action="/assign/members" style="margin:0;max-width:none">
<label>${TEXT.name}<input name="name" value="${h.esc(name)}" required autocomplete="off"><span>${TEXT.inviteHint}</span></label>
<div><button type="submit">${TEXT.invite}</button></div>
</form>`);
  } else if (!error) {
    parts.push(h.notice(TEXT.ownerOnlyNotice));
  }
  parts.push(`<p><a class="button secondary" href="/assign">${TEXT.boardLink}</a></p>`);
  return parts.join('\n');
}
