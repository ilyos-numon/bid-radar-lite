// 약관·개인정보처리방침 동의 기록(consents 플랫폼 표). 항상 db.admin 으로 읽고 쓴다.
import { createHash } from 'node:crypto';
import { versions } from './texts.mjs';

export const CONSENT_FIELDS = { terms: 'agree_terms', privacy: 'agree_privacy' };
const DOCS = ['terms', 'privacy'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

/** 요청의 클라이언트 IP(APP_TRUST_PROXY 만큼 X-Forwarded-For 뒤에서 센다). 알 수 없으면 'local' */
function requestIp(req, env) {
  const hops = Number(env?.APP_TRUST_PROXY);
  const n = Number.isInteger(hops) && hops > 0 ? hops : 0;
  const fwd = n > 0 && req?.headers ? req.headers.get('x-forwarded-for') : null;
  if (fwd) {
    const list = fwd.split(',').map((s) => s.trim());
    const v = list[list.length - n];
    if (v) return v;
  }
  return 'local';
}

/**
 * @param {{ db: { admin(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, env?: object, now?: () => Date }} deps
 */
export function createConsents({ db, env = {}, now = () => new Date() } = {}) {
  if (!db || typeof db.admin !== 'function') throw new Error('db is required');

  /** 문서별 가장 최근에 동의한 버전 */
  async function latest(userId) {
    const out = { terms: null, privacy: null };
    if (!isUuid(userId)) return out;
    const r = await db.admin(
      'SELECT DISTINCT ON (doc) doc, version FROM consents WHERE user_id = $1 ORDER BY doc, agreed_at DESC, id DESC',
      [userId],
    );
    for (const row of r.rows) if (row.doc in out) out[row.doc] = row.version;
    return out;
  }

  return {
    /** doc 2개를 현재 버전으로 기록. userId 가 uuid 가 아니면 user_id 는 비운다(이메일로 남는다) */
    async record({ userId, email, req }) {
      const v = versions(env);
      const ipHash = createHash('sha256').update(requestIp(req, env)).digest('hex').slice(0, 16);
      const ua = String(req?.headers?.get?.('user-agent') ?? '').slice(0, 100) || null;
      const at = now().toISOString();
      for (const doc of DOCS) {
        await db.admin(
          'INSERT INTO consents (user_id, email, doc, version, agreed_at, ip_hash, user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [isUuid(userId) ? userId : null, String(email ?? ''), doc, v[doc], at, ipHash, ua],
        );
      }
    },

    latest,

    /**
     * 최근 동의 버전이 지금 버전과 다르면 true.
     * uuid 가 아닌 사용자 id 는 consents.user_id 에 담을 수 없어 기록·비교가 안 되므로 false(재동의 화면이 되풀이되지 않게)
     */
    async needsReconsent(userId) {
      if (!isUuid(userId)) return false;
      const v = versions(env);
      const got = await latest(userId);
      return DOCS.some((d) => got[d] !== v[d]);
    },

    /** legal_versions 에 현재 버전을 넣는다(있으면 그대로) */
    async ensureVersions() {
      const v = versions(env);
      for (const doc of DOCS) {
        await db.admin('INSERT INTO legal_versions (doc, version) VALUES ($1, $2) ON CONFLICT (doc, version) DO NOTHING', [doc, v[doc]]);
      }
    },
  };
}
