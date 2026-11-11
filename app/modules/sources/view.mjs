// 공고 소스 화면. 화면에 나가는 글자는 전부 이 파일에 둔다 (화면 용어 검사 대상, 주석 포함).
import { fieldName } from './service.mjs';

export const MENU = {
  title: '공고 소스',
  help: '나라장터 외에 지자체·기관 게시판을 더 붙이고 가져온 결과를 확인합니다.',
};

export const TEXT = {
  listTitle: '공고를 가져오는 곳',
  listCount: (n, on) => `${n}곳 · 켜짐 ${on}`,
  defaultChip: '기본',
  lastRun: '마지막 실행',
  busy: '가져오는 중…',
  addHelp: '지자체·기관 게시판 주소를 붙이면 다음 수집부터 오늘의 공고 후보에 들어갑니다.',
  fetchNow: '지금 가져오기',
  turnOn: '켜기',
  turnOff: '끄기',
  remove: '삭제',
  on: '켜짐',
  off: '꺼짐',
  neverRun: '아직 가져온 적 없음',
  failed: '가져오지 못함',
  count: (n) => `${n}건`,
  history: '실행 기록 (최근 5건)',
  historyEmpty: '실행 기록이 없습니다.',
  addTitle: '소스 추가',
  addButton: '소스 추가',
  typeLabel: '종류',
  typeChange: '이 종류로 바꾸기',
  nameLabel: '목록에 보일 이름',
  nameHint: '비워 두면 기관 이름으로 저장합니다.',
  requiredMark: '(필수)',
  optionalMark: '(선택)',
  notSaved: '소스를 추가하지 않았습니다',
  notSavedNext: '아래 내용을 고친 뒤 다시 눌러 주세요',
  actionFailed: '요청을 처리하지 못했습니다',
  actionFailedNext: '목록을 새로 고친 뒤 다시 눌러 주세요',
  added: '소스를 추가했습니다. 지금 가져오기로 바로 확인해 보세요.',
  fetchedOk: (name, n) => `${name}: 공고 ${n}건을 가져왔습니다.`,
  ownerOnly: '공고 소스 추가와 변경은 대표만 할 수 있습니다.',
};

const kstFmt = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function when(iso) {
  const t = Date.parse(String(iso ?? ''));
  return Number.isNaN(t) ? '' : kstFmt.format(new Date(t));
}

function errorBox(h, message, next, items) {
  const box = h.error(message, next);
  if (!items || items.length === 0) return box;
  return box.replace(/<\/div>$/, `<ul>${items.map((e) => `<li>${h.esc(e)}</li>`).join('')}</ul></div>`);
}

// 이름 옆 상태 점: 켜짐 초록, 꺼짐 회색
function stateDot(enabled) {
  const color = enabled ? 'var(--ok)' : 'var(--ink-2)';
  const dot = enabled ? 'var(--ok)' : 'var(--muted-dot)';
  return `<span class="state" style="display:inline-flex;align-items:center;gap:5px;font-size:13px;font-weight:700;color:${color}"><span aria-hidden="true" style="width:6px;height:6px;border-radius:50%;background:${dot}"></span>${enabled ? TEXT.on : TEXT.off}</span>`;
}

function lastRunText(h, row) {
  const type = `<span class="type">${h.esc(row.typeLabel)}</span>`;
  if (!row.lastRun) return `<p class="last-run facts" style="margin:0">${type} · ${TEXT.neverRun}</p>`;
  const r = row.lastRun;
  const text = h.esc(`${r.when} · ${r.ok ? TEXT.count(r.count) : TEXT.failed}`);
  const tail = r.ok ? `<span class="when">${text}</span>` : `<strong class="when" style="color:var(--no);font-weight:700">${text}</strong>`;
  return `<p class="last-run facts" style="margin:0">${type} · ${TEXT.lastRun} ${tail}</p>`;
}

function historyBlock(h, runs) {
  const list =
    runs && runs.length > 0
      ? `<ul style="list-style:none;margin:4px 0 0;padding:0;font-size:13px;color:var(--ink-2);font-variant-numeric:tabular-nums;display:flex;flex-direction:column;gap:2px">${runs
          .map((r) => `<li>${h.esc(when(r.ranAt))} · ${h.esc(r.ok ? TEXT.count(r.count) : `${TEXT.failed} — ${r.error || ''}`)}</li>`)
          .join('')}</ul>`
      : `<p style="margin:4px 0 0;font-size:13px;color:var(--ink-2)">${TEXT.historyEmpty}</p>`;
  return `<details style="border-top:1px solid var(--divider);padding-top:6px"><summary style="min-height:40px;display:flex;align-items:center;font-size:14px;font-weight:500;color:var(--ink-2)">${TEXT.history}</summary>${list}</details>`;
}

function rowCard(h, row, runs, canEdit = true) {
  const id = h.esc(encodeURIComponent(row.id));
  const btn = (action, label, cls, extra = '') =>
    `<form method="post" action="/sources/${id}/${action}" style="display:inline;margin:0"><button type="submit" class="${cls}"${extra}>${h.esc(label)}<span class="skip"> (${h.esc(row.name)})</span></button></form>`;
  const actions = [
    btn('fetch', TEXT.fetchNow, 'secondary small', ` data-busy="${TEXT.busy}"`),
    canEdit ? btn('toggle', row.enabled ? TEXT.turnOff : TEXT.turnOn, row.enabled ? 'secondary small quiet' : 'secondary small') : '',
    canEdit && row.removable ? btn('delete', TEXT.remove, 'secondary small quiet', ' style="color:var(--no)"') : '',
  ]
    .filter(Boolean)
    .join(' ');
  const failed = row.lastRun && !row.lastRun.ok;
  const errorBoxHtml = failed
    ? `<p class="run-error" style="margin:0;padding:10px 14px;border-radius:10px;background:var(--no-bg);font-size:14px;color:var(--no-ink)">${h.esc(row.lastRun.error || '')}</p>`
    : '';
  const chip = row.removable
    ? ''
    : `<span class="chip default" style="font-size:12px;font-weight:500;padding:1px 8px;border-radius:6px;background:var(--chip-bg);color:var(--ink-2)">${TEXT.defaultChip}</span>`;
  const cardStyle = `margin:0;padding:20px 24px;display:flex;flex-direction:column;gap:12px${row.enabled ? '' : ';background:#FAFBFC'}`;
  return `<li class="card source-row" data-source-id="${h.esc(row.id)}" style="${cardStyle}">
<div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:12px 20px">
<div style="display:flex;flex-direction:column;gap:4px;min-width:0">
<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><h3 class="title" style="margin:0;font-size:17px${row.enabled ? '' : ';color:var(--ink-2)'}">${h.esc(row.name)}</h3>${chip}${stateDot(row.enabled)}</div>
${lastRunText(h, row)}
</div>
<div class="actions" style="display:flex;gap:8px;flex-wrap:wrap">${actions}</div>
</div>
${errorBoxHtml}
${historyBlock(h, runs)}
</li>`;
}

function typeChooser(h, adapters, current) {
  if (!adapters || adapters.length < 2) return '';
  const options = adapters
    .map((a) => `<option value="${h.esc(a.type)}"${a.type === current.type ? ' selected' : ''}>${h.esc(a.label)}</option>`)
    .join('');
  return `<form method="get" action="/sources" style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;max-width:560px">
<label for="type" style="flex:1 1 240px">${TEXT.typeLabel}<select id="type" name="type">${options}</select></label>
<button type="submit" class="secondary small" style="min-height:48px">${TEXT.typeChange}</button>
</form>`;
}

function addForm(h, adapter, values, errors) {
  const v = values || {};
  const input = (id, name, label, value, { required = false, placeholder = '', hint = '', grow = '' } = {}) =>
    `<label for="${id}"${grow ? ` style="flex:${grow}"` : ''}><span>${h.esc(label)} ${required ? TEXT.requiredMark : TEXT.optionalMark}</span><input id="${id}" name="${name}" value="${h.esc(value ?? '')}"${placeholder ? ` placeholder="${h.esc(placeholder)}"` : ''}${hint ? ` aria-describedby="${id}-hint"` : ''}>${hint ? `<span id="${id}-hint" class="hint">${h.esc(hint)}</span>` : ''}</label>`;
  const cfg = (f, grow) =>
    input(`cfg-${h.esc(f.key)}`, fieldName(f.key), f.label, (v.config || {})[f.key], {
      required: Boolean(f.required),
      placeholder: f.placeholder || '',
      grow,
    });
  const list = adapter.configFields || [];
  // 첫 칸(주소 등)은 한 줄 전체, 나머지는 두 칸씩
  const first = list.length > 0 ? cfg(list[0]) : '';
  const rest = list.slice(1);
  const pair = rest.length > 0 ? `<div style="display:flex;flex-wrap:wrap;gap:16px">${rest.map((f) => cfg(f, '1 1 220px')).join('\n')}</div>` : '';
  const box = errors && errors.length > 0 ? errorBox(h, TEXT.notSaved, TEXT.notSavedNext, errors) : '';
  return `${box}
<form class="stack" method="post" action="/sources">
<input type="hidden" name="type" value="${h.esc(adapter.type)}">
${first}
${pair}
${input('name', 'name', TEXT.nameLabel, v.name, { hint: TEXT.nameHint })}
<div><button type="submit">${TEXT.addButton}</button></div>
</form>`;
}

/**
 * @param {object} h ctx.html
 * @param {{ rows: object[], runsById: Record<string, object[]>, adapters: object[], adapter: object|null, values?: object, errors?: string[], notice?: string, actionError?: string, canEdit?: boolean }} data
 * @returns {string}
 */
export function sourcesBody(h, { rows, runsById, adapters, adapter, values, errors, notice, actionError, canEdit = true }) {
  const parts = [];
  if (actionError && !(errors && errors.length > 0)) parts.push(h.error(actionError, ''));
  if (notice) parts.push(h.notice(notice, { kind: 'success', role: 'status' }));
  const on = rows.filter((r) => r.enabled).length;
  parts.push(`<section aria-labelledby="list-title" style="display:flex;flex-direction:column;gap:12px">
<h2 id="list-title" style="margin:0;font-size:18px;font-weight:700">${TEXT.listTitle} <span class="hint" style="font-size:14px">${h.esc(TEXT.listCount(rows.length, on))}</span></h2>
<ol class="sources" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px">${rows.map((r) => rowCard(h, r, runsById[r.id] || [], canEdit)).join('')}</ol>
</section>`);
  // 구성원: 추가 폼 대신 안내 한 줄 (403 화면은 위 오류 상자가 같은 문구를 보여 준다)
  if (!canEdit && actionError !== TEXT.ownerOnly) parts.push(`<p class="hint owner-only" style="margin:0;font-size:14px">${TEXT.ownerOnly}</p>`);
  if (adapter && canEdit) {
    parts.push(`<section class="card" aria-labelledby="add-title" style="margin:0;padding:28px;display:flex;flex-direction:column;gap:20px">
<div style="display:flex;flex-direction:column;gap:4px">
<h2 id="add-title" style="margin:0;font-size:18px;font-weight:700">${TEXT.addTitle}</h2>
<p class="hint" style="margin:0;font-size:14px">${TEXT.addHelp}</p>
</div>
${typeChooser(h, adapters, adapter)}
${addForm(h, adapter, values, errors)}
</section>`);
  }
  return parts.join('\n');
}

export function actionErrorText(message) {
  return message || `${TEXT.actionFailed}. ${TEXT.actionFailedNext}.`;
}
