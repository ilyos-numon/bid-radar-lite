// 내 회사: 회사 정보 저장과 공고별 자격 판정
// 판정 순서: ① 중소기업 제한·구조화된 참가 지역 제한 불일치 → 불가 ② 구조화된 면허 제한이 있으면 그것만으로 판정
// ③ 없으면 공고문 해석: 원문·판정 결과 없음/근거 미검증 → 확인 필요, 필요 면허 전부 보유 → 참가 가능, 그 밖 → 확인 필요.
// 공고문 해석 결과만으로는 불가를 만들지 않는다. 저장되는 근거의 마지막 줄은 기준(공고 면허제한 / 공고문 해석) 표기.
import { REASON, BASIS, basisOfLine } from './view.mjs';
import { normalizeBid, regionKeys, subRegionLimit } from '../../core/normalize.mjs';

export const LIMITS = { name: 60, item: 40, items: 30 };
const MAX_TEXT = 12000;
const EVIDENCE_FIELDS = ['licenses', 'regionLimit', 'other'];

const INSTRUCTIONS = [
  'You read a Korean public procurement notice and extract participation requirements.',
  'Return only JSON: {"licenses": string[], "regionLimit": string|null, "other": string[], "evidence": [{"field": "licenses"|"regionLimit"|"other", "quote": string}]}.',
  'licenses: business licenses or registrations a bidder must hold (e.g. 조경식재공사업). regionLimit: the participation region restriction, or null.',
  'other: other eligibility conditions (short phrases). Every item must have an evidence entry whose quote is copied verbatim from the text.',
  'Do not guess. If the text does not state something, leave it out.',
].join('\n');

/** 쉼표·줄바꿈으로 나눈 목록 (빈 항목·중복 제거) */
export function splitList(s) {
  const out = [];
  for (const x of String(s ?? '').split(/[,，、;\n]/)) {
    const v = x.trim();
    if (v !== '' && !out.includes(v)) out.push(v);
  }
  return out;
}

/** 비교용: 전각→반각, 공백 제거, 소문자 */
export function normalizeName(s) {
  return String(s ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** 둘 중 하나가 다른 하나를 포함하면 같은 것으로 본다 */
function sameName(a, b) {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/** requirements 결과 형식 검사 → 오류 목록 */
export function requirementsSchema(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['data is not an object'];
  const strArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!strArr(data.licenses)) errors.push('licenses must be string[]');
  if (!(data.regionLimit === null || data.regionLimit === undefined || typeof data.regionLimit === 'string')) {
    errors.push('regionLimit must be string|null');
  }
  if (!(data.other === undefined || strArr(data.other))) errors.push('other must be string[]');
  if (!Array.isArray(data.evidence)) errors.push('evidence must be an array');
  else if (!data.evidence.every((e) => e && EVIDENCE_FIELDS.includes(e.field) && typeof e.quote === 'string' && e.quote.trim() !== '')) {
    errors.push('evidence items need field and quote');
  }
  return errors;
}

function quoteFor(license, evidence) {
  const list = evidence.filter((e) => e.field === 'licenses');
  const hit = list.find((e) => normalizeName(e.quote).includes(normalizeName(license)));
  if (hit) return hit.quote;
  return list.length === 1 ? list[0].quote : null;
}

/** 면허 동일성용: 정규화 후 가운뎃점·괄호·문장부호까지 지운다 */
function licenseKey(s) {
  return normalizeName(s).replace(/[·ㆍ\u119E•‧∙・.,()\[\]{}'"`\-_]/g, '');
}

/** '이름/코드' 또는 코드만 → {name, code} */
function splitLicense(s) {
  const v = String(s ?? '').trim();
  if (/^\d+$/.test(v)) return { name: '', code: v };
  const cut = v.lastIndexOf('/');
  if (cut < 0) return { name: v, code: null };
  const code = v.slice(cut + 1).trim();
  return { name: v.slice(0, cut).trim(), code: code === '' ? null : code };
}

/** 구조화 면허 동일성: 정규화 후 완전 일치 또는 코드 일치만 인정 (부분 일치 불인정) */
function holdsLicense(have, need) {
  const h = splitLicense(have);
  const needCode = need.code ? String(need.code).trim() : '';
  if (needCode && h.code && h.code === needCode) return true;
  const a = licenseKey(h.name);
  return a !== '' && a === licenseKey(need.name);
}

/** 회사 소재지 → 시도 표준 키 */
function profileRegionKeys(regions) {
  const out = [];
  for (const r of regions) for (const k of regionKeys(r)) if (!out.includes(k)) out.push(k);
  return out;
}

/** 회사 소재지에 시군구 제한 조각(예: '경기도 수원시') 의 시군구가 같은 시도로 적혀 있으면 true */
function sameSubRegion(regions, sub) {
  return sub.split(', ').some((seg) => {
    const last = seg.trim().split(/\s+/).pop();
    const key = regionKeys(seg)[0];
    return regions.some((r) => regionKeys(r).includes(key) && String(r).replace(/\s+/g, '').includes(last));
  });
}

const withBasis = (verdict, reasons, basis) => ({ verdict, reasons: [...reasons, BASIS[basis].line], basis });

/**
 * 순수 판정.
 * @param {{ profile: {licenses:string[], regions:string[], smallBusiness?:boolean}, limits?: {regions:string[], regionRaw:string|null, licenses:{name:string, code:string|null}[], sme:boolean|null}|null, textStatus?: 'ok'|'none'|'failed', result?: object|null }} input
 *   limits: 공고에 구조화돼 있던 제한(NormalizedBid.limits). result: 공고문 해석 결과 ({ok, data, verified})
 * @returns {{verdict:'ok'|'check'|'no', reasons:string[], basis:'structured'|'text'}} reasons 마지막 줄은 기준 표기
 */
export function judge({ profile, limits = null, textStatus = 'none', result = null }) {
  const regions = profile.regions || [];
  const licenses = profile.licenses || [];
  const lim = limits && typeof limits === 'object' ? limits : {};
  const limitKeys = Array.isArray(lim.regions) ? lim.regions : [];
  const limitRaw = typeof lim.regionRaw === 'string' ? lim.regionRaw.trim() : '';
  const limitLabel = limitRaw || limitKeys.join(', ');
  const structured = (Array.isArray(lim.licenses) ? lim.licenses : []).filter((l) => l && String(l.name ?? '').trim() !== '');
  const hasRegionLimit = limitKeys.length > 0 || limitRaw !== '';
  const pre = [];

  // ① 중소기업 제한 (구조화 필드만)
  if (lim.sme === true && !profile.smallBusiness) return withBasis('no', [REASON.smeOnly], 'structured');

  // ② 구조화된 지역 제한 (시도 표준 키로 비교)
  if (hasRegionLimit) {
    if (regions.length === 0) pre.push(REASON.regionUnknown(limitLabel));
    else {
      const ours = profileRegionKeys(regions);
      if (limitKeys.length === 0 || ours.length === 0) pre.push(REASON.regionUnclear(limitLabel));
      else if (!ours.some((k) => limitKeys.includes(k))) {
        return withBasis('no', [REASON.regionMismatch(limitLabel), REASON.ourRegions(regions)], 'structured');
      } else {
        // 시도는 같아도 시군구 단위 제한이면 회사 소재 시군구를 모르므로 확인 필요
        const sub = subRegionLimit(limitRaw, ours.filter((k) => limitKeys.includes(k)));
        if (sub && !sameSubRegion(regions, sub)) pre.push(REASON.regionSubdivision(sub));
      }
    }
  }

  // ③ 구조화된 면허 제한이 있으면 그것으로만 판정 (공고문 해석 안 함)
  if (structured.length > 0) {
    const missing = structured.filter((need) => !licenses.some((have) => holdsLicense(have, need)));
    if (missing.length > 0) {
      return withBasis('check', [...missing.map((m) => REASON.licenseMissing(m.name)), ...pre], 'structured');
    }
    const held = structured.map((need) => REASON.licenseHeldStructured(need.name));
    return withBasis(pre.length > 0 ? 'check' : 'ok', [...held, ...pre], 'structured');
  }

  // ④ 원문 없음·해석 실패·근거 미검증
  if (textStatus !== 'ok' || !result || !result.ok || !result.verified) {
    return withBasis('check', [REASON.noRequirements, ...pre], 'text');
  }

  const data = result.data;
  const evidence = Array.isArray(data.evidence) ? data.evidence : [];
  const required = (data.licenses || []).map((x) => String(x).trim()).filter((x) => x !== '');
  const extra = [];
  const textLimit = typeof data.regionLimit === 'string' ? data.regionLimit.trim() : '';
  if (textLimit && !hasRegionLimit) extra.push(REASON.textRegion(textLimit));
  for (const o of data.other || []) if (String(o).trim()) extra.push(REASON.other(String(o).trim()));

  if (required.length === 0) {
    return withBasis('check', [REASON.noLicenseFound, ...pre, ...extra], 'text');
  }

  const missing = required.filter((need) => !licenses.some((have) => sameName(have, need)));
  if (missing.length > 0) {
    return withBasis('check', [...missing.map((m) => REASON.licenseMissing(m)), ...pre, ...extra], 'text');
  }

  // ⑤ 전부 보유. 면허마다 원문 인용이 있어야 한다
  const held = [];
  for (const need of required) {
    const quote = quoteFor(need, evidence);
    if (!quote) return withBasis('check', [REASON.noRequirements, ...pre, ...extra], 'text');
    held.push(REASON.licenseHeld(need, quote));
  }
  const uncertain = pre.length > 0 || (textLimit && !hasRegionLimit);
  return withBasis(uncertain ? 'check' : 'ok', [...held, ...pre, ...extra], 'text');
}

function parseList(s) {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

/** 폼 값 검사 → {profile, errors} */
export function readProfileForm(values) {
  const name = String(values.name ?? '').trim();
  const licenses = splitList(values.licenses);
  const regions = splitList(values.regions);
  const errors = [];
  if (licenses.length === 0) errors.push('needLicense');
  if (name.length > LIMITS.name) errors.push('nameTooLong');
  if (licenses.some((x) => x.length > LIMITS.item)) errors.push('licenseTooLong');
  if (regions.some((x) => x.length > LIMITS.item)) errors.push('regionTooLong');
  if (licenses.length > LIMITS.items) errors.push('licensesTooMany');
  if (regions.length > LIMITS.items) errors.push('regionsTooMany');
  return { profile: { name, licenses, regions, smallBusiness: Boolean(values.smallBusiness) }, errors };
}

const errText = (err) => (err && err.message ? err.message : String(err));

/** @param {object} ctx */
export function createService(ctx) {
  const db = () => ctx.db;

  async function getProfile() {
    const row = await db().get('SELECT name, licenses, regions, small_business FROM company_profile');
    if (!row) return null;
    return {
      name: row.name ?? '',
      licenses: parseList(row.licenses),
      regions: parseList(row.regions),
      smallBusiness: Number(row.small_business) === 1,
    };
  }

  /** 면허가 하나도 없으면 판정하지 않는다 */
  function isEmpty(profile) {
    return !profile || profile.licenses.length === 0;
  }

  async function saveProfile(p) {
    await db().run(
      `INSERT INTO company_profile (name, licenses, regions, small_business) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id) DO UPDATE SET name = excluded.name, licenses = excluded.licenses, regions = excluded.regions, small_business = excluded.small_business`,
      [p.name, JSON.stringify(p.licenses), JSON.stringify(p.regions), p.smallBusiness ? 1 : 0],
    );
  }

  async function getVerdict(bidId) {
    const row = await db().get('SELECT verdict, reasons, updated_at FROM company_verdicts WHERE bid_id = $1', [String(bidId)]);
    if (!row) return null;
    const reasons = parseList(row.reasons);
    const basis = reasons.length > 0 ? basisOfLine(reasons[reasons.length - 1]) : null;
    if (basis) reasons.pop();
    return { verdict: row.verdict, reasons, basis, updatedAt: row.updated_at };
  }

  async function saveVerdict(bidId, v) {
    await db().run(
      `INSERT INTO company_verdicts (bid_id, verdict, reasons, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, bid_id) DO UPDATE SET verdict = excluded.verdict, reasons = excluded.reasons, updated_at = excluded.updated_at`,
      [String(bidId), v.verdict, JSON.stringify(v.reasons), ctx.now().toISOString()],
    );
  }

  /** 공고 한 건 판정 (저장 포함). 구조화 제한으로 결론이 나면 공고문을 읽지 않는다 */
  async function judgeBid(profile, bid, fallback = null) {
    const stored = await ctx.bids.get(bid.bidId);
    const limits = stored && stored.limits ? stored.limits : normalizeBid(fallback || {}).limits;
    const first = judge({ profile, limits });
    if (first.verdict === 'no' || first.basis === 'structured') {
      await saveVerdict(bid.bidId, first);
      return first;
    }
    let result = null;
    const t = await ctx.bidText.get(bid.bidId);
    if (t.status === 'ok') {
      result = await ctx.llm.complete({
        task: 'requirements',
        system: INSTRUCTIONS,
        input: { bidId: bid.bidId, title: bid.title ?? (stored && stored.title) ?? '', org: bid.org ?? (stored && stored.org) ?? '', text: t.text.slice(0, MAX_TEXT) },
        schema: requirementsSchema,
        textForEvidence: t.text,
      });
    }
    const v = judge({ profile, limits, textStatus: t.status, result });
    await saveVerdict(bid.bidId, v);
    return v;
  }

  /** 여러 건. 한 건이 실패해도 나머지는 계속 */
  async function judgeMany(bids, candidates = []) {
    const profile = await getProfile();
    if (isEmpty(profile)) return 0;
    const rawOf = new Map((candidates || []).map((c) => [`${c.bidNtceNo}-${c.bidNtceOrd}`, c]));
    const seen = new Set();
    let n = 0;
    for (const bid of bids) {
      if (!bid || !bid.bidId || seen.has(bid.bidId)) continue;
      seen.add(bid.bidId);
      try {
        await judgeBid(profile, bid, rawOf.get(bid.bidId) || null);
        n += 1;
      } catch (err) {
        ctx.log('company', `judge failed for ${bid.bidId}: ${errText(err)}`);
      }
    }
    return n;
  }

  /** 가장 최근 추천 날짜의 공고 (matched + maybe) */
  async function latestBids() {
    const date = await ctx.matches.latestDate();
    if (!date) return [];
    const { matched, maybe } = await ctx.matches.forDate(date);
    return maybe ? [...matched, maybe] : [...matched];
  }

  return { getProfile, isEmpty, saveProfile, getVerdict, judgeMany, latestBids };
}
