// 인증키 이름·묶음, 계층 env(워크스페이스 키 → .env 공용 키), 레거시 모드 빈 KeyStore, 마스킹
// KeyStore 모양: { enabled, get(name) → string|null, set(name, value, { byUserId, client }) → Promise<void>,
//   remove(name, { byUserId, client }) → Promise<void>, status() → Promise<Array<{ name, masked, updatedAt }>>, invalidate() }
// 구현은 app/core/supabase.mjs 의 platform.keys(workspaceId).

export const KEY_NAMES = Object.freeze([
  'NARA_API_KEY',
  'LLM_API_BASE',
  'LLM_API_KEY',
  'LLM_MODEL',
  'SUPPORT_API_BASE',
  'SUPPORT_API_KEY',
]);

export const KEY_GROUPS = Object.freeze({
  nara: Object.freeze(['NARA_API_KEY']),
  llm: Object.freeze(['LLM_API_KEY', 'LLM_API_BASE', 'LLM_MODEL']),
  support: Object.freeze(['SUPPORT_API_KEY', 'SUPPORT_API_BASE']),
});

function groupOf(name) {
  for (const list of Object.values(KEY_GROUPS)) {
    if (list.includes(name)) return list;
  }
  return null;
}

function present(v) {
  return typeof v === 'string' ? v.trim() !== '' : v !== null && v !== undefined;
}

/**
 * env 의 모든 키를 가진 객체. KEY_NAMES 는 읽을 때마다 계산하는 getter.
 * - 그룹의 첫 항목(키)이 워크스페이스에 있으면 그 그룹은 워크스페이스 값, 비어 있는 항목은 env 값
 * - 없으면 env.APP_SHARED_KEYS === '1' 일 때만 env 값, 아니면 ''
 * - KEY_NAMES 밖은 항상 env 값
 * @param {Record<string, string|undefined>} env
 * @param {{ get(name: string): string|null }} keys
 */
export function layeredEnv(env, keys) {
  const base = env || {};
  const out = {};
  for (const k of Object.keys(base)) {
    if (KEY_NAMES.includes(k)) continue;
    out[k] = base[k];
  }
  for (const name of KEY_NAMES) {
    const group = groupOf(name);
    Object.defineProperty(out, name, {
      enumerable: true,
      configurable: false,
      get() {
        const wsHasGroup = keys && present(keys.get(group[0]));
        if (wsHasGroup) {
          const own = keys.get(name);
          return present(own) ? own : base[name];
        }
        return base.APP_SHARED_KEYS === '1' ? base[name] : '';
      },
    });
  }
  return out;
}

/** 레거시 모드: 워크스페이스 키 없음 */
export function legacyKeys() {
  const fail = () => {
    throw Object.assign(new Error('keys are not available in legacy mode'), { code: 'KEYS_DISABLED' });
  };
  return {
    enabled: false,
    get: () => null,
    status: () => [],
    set: fail,
    remove: fail,
    invalidate() {},
  };
}

/** 길이 8 이상 → 앞 3자 + '…' + 뒤 2자, 그 외 '••••'. 주소·모델 이름의 예외는 호출하는 쪽이 정한다 */
export function maskValue(v) {
  const s = String(v ?? '');
  return s.length >= 8 ? `${s.slice(0, 3)}…${s.slice(-2)}` : '••••';
}
