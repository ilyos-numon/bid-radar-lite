// 공고 소스 화면의 순수 로직: 상대 시각, 폼 → 소스 설정, 화면 행 만들기
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** ranAt(ISO) 과 now 의 차이 → '방금' | 'N분 전' | 'N시간 전' | 'N일 전' */
export function relativeTime(ranAt, now) {
  const t = Date.parse(String(ranAt ?? ''));
  if (Number.isNaN(t)) return '';
  const diff = Math.max(0, now.getTime() - t);
  if (diff < MINUTE) return '방금';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}분 전`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}시간 전`;
  return `${Math.floor(diff / DAY)}일 전`;
}

/** 추가 폼에서 고를 어댑터. 요청한 종류가 없으면 나라장터가 아닌 첫 종류, 그것도 없으면 첫 종류 */
export function pickAdapter(adapters, type) {
  const list = Array.isArray(adapters) ? adapters : [];
  return list.find((a) => a.type === type) || list.find((a) => a.type !== 'nara') || list[0] || null;
}

/** 폼 필드 이름 (설정 키 → 입력 이름) */
export const fieldName = (key) => `cfg_${key}`;

/**
 * 추가 폼 값 → ctx.sources.add 에 넘길 값
 * @param {{get(name:string): any}} form
 * @param {{type:string, label:string, configFields?: {key:string}[]}} adapter
 */
export function sourceFromForm(form, adapter) {
  const config = {};
  for (const f of adapter.configFields || []) {
    const v = String(form.get(fieldName(f.key)) ?? '').trim();
    if (v !== '') config[f.key] = v;
  }
  const typed = String(form.get('name') ?? '').trim();
  const name = typed || String(config.orgName ?? '').trim() || adapter.label;
  return { type: adapter.type, name, config, typedName: typed };
}

/** 소스 목록 → 화면 행 */
export function rowsFrom(sources, adapters, now) {
  const labels = new Map((adapters || []).map((a) => [a.type, a.label]));
  return (sources || []).map((s) => {
    const last = s.lastRun;
    return {
      id: s.id,
      name: s.name,
      typeLabel: labels.get(s.type) || s.type,
      enabled: s.enabled,
      removable: s.id !== 'nara-cnstwk',
      lastRun: last ? { when: relativeTime(last.ranAt, now), ok: last.ok, count: last.count, error: last.error } : null,
    };
  });
}
