// 알림 문구 3종(bids·reminder·support)과 notifications 기록
import { buildNotification } from '../../src/match.js';

const UNKNOWN_DEADLINE = '마감 미확인';
/** 'sending' 으로 잡은 뒤 이 시간이 지나도 끝나지 않은 기록은 프로세스가 죽은 것으로 보고 다시 잡는다 */
const STALE_SENDING_MS = 10 * 60 * 1000;

function mmdd(date) {
  const [, mm, dd] = String(date ?? '').split('-');
  return `${mm}/${dd}`;
}

/** 마감이 9999- 로 시작하면 '마감 9999-…' 를 '마감 미확인' 으로 바꾼다 */
function fixDeadline(line, deadline) {
  const d = String(deadline ?? '');
  if (!d.startsWith('9999-')) return line;
  return line.replace(`마감 ${d}`, UNKNOWN_DEADLINE);
}

/** buildNotification 의 항목 4줄 (번호 i) */
function itemLines(item, date, number) {
  const lines = buildNotification([item], date).text.split('\n').slice(1);
  lines[0] = lines[0].replace(/^1\. /, `${number}. `);
  lines[1] = fixDeadline(lines[1], item.deadline);
  return lines;
}

/** 변경 한 줄: 마감 변경 · 취소만 알린다 (그 외 변경은 null) */
function changeLine(c) {
  if (!c || typeof c !== 'object') return null;
  const title = String(c.title ?? '');
  if (c.field === 'deadline') return `${title} · 마감 ${c.old ?? '미확인'} → ${c.new ?? '미확인'}`;
  if (c.field === 'kind' && c.new === 'cancelled') return `${title} · 취소됨`;
  return null;
}

/** ─ 변경된 공고 ─ · ─ 수집 알림 ─ 블록 (내용이 있을 때만) */
function pushNotices(out, n) {
  const changes = (Array.isArray(n.changes) ? n.changes : []).map(changeLine).filter((l) => l !== null);
  if (changes.length > 0) out.push('─ 변경된 공고 ─', ...changes);
  const warnings = (Array.isArray(n.warnings) ? n.warnings : []).filter((w) => typeof w === 'string' && w !== '');
  if (warnings.length > 0) out.push('─ 수집 알림 ─', ...warnings);
}

function renderBids(n, appUrl) {
  const items = Array.isArray(n.items) ? n.items : [];
  const last = `설정 바꾸기: ${appUrl}/settings`;
  const head = buildNotification(items, n.date).text.split('\n')[0];
  if (items.length === 0) {
    const out = [head];
    pushNotices(out, n);
    out.push(last);
    return out.join('\n');
  }
  const out = [head];
  items.forEach((item, i) => {
    const [title, deadline, reasons, url] = itemLines(item, n.date, i + 1);
    out.push(title, deadline, reasons);
    for (const line of Array.isArray(item.extras) ? item.extras : []) out.push('   ' + line);
    out.push(url);
  });
  if (n.maybe) {
    out.push('─ 관련 가능성 있음 ─');
    out.push(...itemLines(n.maybe, n.date, 1));
  }
  pushNotices(out, n);
  out.push(last);
  return out.join('\n');
}

function renderReminder(n, appUrl) {
  const items = Array.isArray(n.items) ? n.items : [];
  const count = Number.isInteger(n.count) ? n.count : items.length;
  const out = [`입찰 레이더 · ${mmdd(n.date)} 마감 임박 ${count}건`];
  items.forEach((item, i) => {
    out.push(`${i + 1}. ${item.dday ?? ''} · ${item.title} · 마감 ${item.deadline} · 담당 ${item.assignee || '미정'}`);
    const checklist = Array.isArray(item.checklist) ? item.checklist : [];
    if (checklist.length > 0) out.push(`   확인 항목: ${checklist.join(' · ')}`);
    out.push(`   ${appUrl}/interest`);
  });
  return out.join('\n');
}

function renderSupport(n) {
  const items = Array.isArray(n.items) ? n.items : [];
  const count = Number.isInteger(n.count) ? n.count : items.length;
  const out = [`지원사업 레이더 · ${mmdd(n.date)} 새 지원사업 ${count}건`];
  items.forEach((item, i) => {
    out.push(`${i + 1}. ${item.title}`);
    out.push(`   신청 마감 ${item.deadline} · ${item.org}`);
    out.push(`   왜 추천: ${(Array.isArray(item.reasons) ? item.reasons : []).join(' · ')}`);
    out.push(`   ${item.url}`);
  });
  return out.join('\n');
}

/** @param {{db:any, env:Record<string,string|undefined>, now():Date}} ctx */
export function create(ctx) {
  const appUrlOf = (n) => {
    if (n && n.appUrl) return String(n.appUrl);
    const env = ctx.env || {};
    return env.APP_BASE_URL ? String(env.APP_BASE_URL) : `http://localhost:${env.APP_PORT || 8820}`;
  };

  const safeCode = (c) => (typeof c === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(c) ? c : null);

  /** (kind, date) 를 잡고 send 한 번. 결과를 기록한다 */
  async function claimAndSend({ kind, date, runId, host }, send) {
    const at = ctx.now().toISOString();
    let claim = await ctx.db.run(
      `INSERT INTO notification_deliveries (kind, date, run_id, target_host, status, created_at) VALUES ($1, $2, $3, $4, 'sending', $5)
       ON CONFLICT (workspace_id, kind, date) DO NOTHING RETURNING id`,
      [String(kind), String(date), String(runId), host, at],
    );
    if (claim.rowCount === 0) {
      claim = await ctx.db.run(
        `UPDATE notification_deliveries SET status = 'sending', run_id = $3, target_host = $4, http_status = NULL, error_code = NULL, created_at = $5
         WHERE kind = $1 AND date = $2 AND (status = 'failed' OR (status = 'sending' AND created_at < $6)) RETURNING id`,
        [String(kind), String(date), String(runId), host, at, new Date(ctx.now().getTime() - STALE_SENDING_MS).toISOString()],
      );
    }
    if (claim.rowCount === 0) return { sent: false, reason: 'already_delivered' };
    const id = Number(claim.rows[0].id);
    const finish = (status, httpStatus, errorCode, sentAt) =>
      ctx.db.run('UPDATE notification_deliveries SET status = $2, http_status = $3, error_code = $4, sent_at = $5 WHERE id = $1', [
        id,
        status,
        httpStatus,
        errorCode,
        sentAt,
      ]);
    let r;
    try {
      r = await send();
    } catch (err) {
      await finish('failed', null, safeCode(err && err.code) ?? 'error', null);
      return { sent: false, reason: 'failed' };
    }
    const status = r && Number.isInteger(r.status) ? r.status : null;
    if (!r || !r.ok) {
      await finish('failed', status, safeCode(r && r.code) ?? (status !== null ? `http_${status}` : 'error'), null);
      return status !== null ? { sent: false, reason: 'failed', status } : { sent: false, reason: 'failed' };
    }
    await finish('sent', status, null, ctx.now().toISOString());
    return status !== null ? { sent: true, status } : { sent: true };
  }

  const notify = {
    /** @param {object} n NotificationV2 (text 제외) @returns {string} */
    render(n) {
      const appUrl = appUrlOf(n);
      const kind = n && n.kind ? n.kind : 'bids';
      if (kind === 'reminder') return renderReminder(n, appUrl);
      if (kind === 'support') return renderSupport(n);
      return renderBids(n, appUrl);
    },
    /** notifications 1행 @returns {Promise<number>} id */
    async record(kind, date, payload) {
      const info = await ctx.db.run(
        'INSERT INTO notifications (kind, date, payload, created_at) VALUES ($1, $2, $3, $4) RETURNING id',
        [String(kind), String(date), JSON.stringify(payload ?? null), ctx.now().toISOString()],
      );
      return Number(info.rows[0].id);
    },
    /**
     * 웹훅으로 한 번만 보낸다: notification_deliveries (kind, date) 를 먼저 잡은 쪽만 POST 한다(실패한 기록과 STALE_SENDING_MS 넘게 'sending' 인 기록은 다시 잡을 수 있다. 잡을 때 created_at 을 잡은 시각으로 바꾼다).
     * @param {{ kind: string, date: string, runId: string, url?: string|null, payload: object }} d
     * @returns {Promise<{ sent: boolean, reason?: 'already_delivered'|'no_url'|'failed', status?: number }>}
     */
    async deliver({ kind, date, runId, url, payload }) {
      const target = String(url ?? '').trim();
      if (target === '') return { sent: false, reason: 'no_url' };
      let host = null;
      try {
        host = new URL(target).host;
      } catch {
        host = null;
      }
      return claimAndSend({ kind, date, runId, host }, async () => {
        const res = await ctx.fetch(target, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? null),
          timeoutMs: 10000,
        });
        return { ok: res.ok, status: res.status };
      });
    },
    /**
     * deliver 의 일반화: 보내는 방법(send)만 바꾼다. 기록·중복 방지 규칙은 deliver 와 같다.
     * @param {{ kind: string, date: string, runId: string, targetHost?: string|null, send: () => Promise<{ ok: boolean, status?: number, code?: string }> }} d
     * @returns {Promise<{ sent: boolean, reason?: 'already_delivered'|'no_target'|'failed', status?: number }>}
     */
    async deliverVia({ kind, date, runId, targetHost, send }) {
      const host = String(targetHost ?? '').trim();
      if (host === '') return { sent: false, reason: 'no_target' };
      return claimAndSend({ kind, date, runId, host }, send);
    },
  };
  return { notify };
}
