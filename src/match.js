/** @typedef {{bidNtceNo:string,bidNtceOrd:string,bidNtceNm:string,ntceInsttNm:string,dminsttNm:string,bidNtceDt:string,bidClseDt:string,presmptPrce:string|number,asignBdgtAmt:string|number,bidNtceDtlUrl:string}} NaraBid */
/** @typedef {{keywords:string[],regions:string[],budgetMin:number,budgetMax:number,maxItems:number,excludeKeywords?:string[],synonyms?:Record<string,string>}} Criteria */
/** @typedef {{bidId:string,title:string,org:string,deadline:string,budget:number|null,url:string,reasons:string[],kind:string,openingAt:string|null,budgetBasis:string|null,amounts:object,source?:string}} MatchedBid */
/** @typedef {{date:string,count:number,items:MatchedBid[],text:string}} Notification */

/**
 * body: object 또는 JSON 문자열. 실패 시 throw new Error('NARA_API_ERROR: <resultCode|NON_JSON|NO_HEADER> <resultMsg>')
 * @param {object|string} body
 * @returns {NaraBid[]}
 */
export function normalizeNaraResponse(body) {
  let data = body;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (e) {
      throw new Error('NARA_API_ERROR: NON_JSON ' + String(data).slice(0, 100));
    }
  }
  const header = data && data.response && data.response.header;
  if (!header || typeof header !== 'object') {
    throw new Error('NARA_API_ERROR: NO_HEADER response.header missing');
  }
  if (String(header.resultCode) !== '00') {
    throw new Error('NARA_API_ERROR: ' + header.resultCode + ' ' + (header.resultMsg || ''));
  }
  const items = data.response.body ? data.response.body.items : undefined;
  if (Array.isArray(items)) return items;
  if (items && typeof items === 'object') {
    if (Array.isArray(items.item)) return items.item;
    if (items.item && typeof items.item === 'object') return [items.item];
  }
  return [];
}

const BASIS_LABEL = { estimated: '추정가격', base: '기초금액', assigned: '배정예산' };

/** 부가세 표기: 배정예산이 asignBdgtAmt(부가세 여부 미확인 필드)에서 왔으면 '표기 없음' */
function vatLabel(n) {
  const amounts = n.amounts || {};
  const raw = n.raw && typeof n.raw === 'object' ? n.raw : {};
  if (n.budgetBasis === 'assigned' && Number(raw.asignBdgtAmt) > 0) return '표기 없음';
  if (amounts.vatIncluded === true) return '포함';
  if (amounts.vatIncluded === false) return '제외';
  return '표기 없음';
}

/** @param {any} arr */
function cleanWords(arr) {
  const out = [];
  for (const s of Array.isArray(arr) ? arr : []) {
    const w = String(s ?? '').trim();
    if (w !== '' && !out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * 규칙: 취소 공고 제외 → 제외 키워드 제외 → 키워드·비슷한 말 일치 → 참가 가능 지역(구조화) → 예산(추정→기초→배정)
 * @param {(NaraBid|object)[]} bids raw item 또는 NormalizedBid
 * @param {Criteria} criteria
 * @returns {MatchedBid[]}
 */
export function matchBids(bids, criteria) {
  const keywords = cleanWords(criteria.keywords);
  const excludes = cleanWords(criteria.excludeKeywords);
  const synonyms = criteria.synonyms && typeof criteria.synonyms === 'object' ? criteria.synonyms : {};
  const wanted = [];
  for (const r of cleanWords(criteria.regions)) {
    const keys = regionKeys(r);
    for (const k of keys.length > 0 ? keys : [r]) if (!wanted.includes(k)) wanted.push(k);
  }
  const seen = new Set();
  const out = [];
  for (const bid of bids) {
    const n = normalizeBid(bid, bid && bid.source);
    if (n.kind === 'cancelled') continue;
    const title = String(n.title || '');
    if (excludes.some((x) => title.includes(x))) continue;

    const reasons = [];
    for (const kw of keywords) {
      if (title.includes(kw)) reasons.push(`키워드 '${kw}' 일치`);
    }
    for (const [word, forKeyword] of Object.entries(synonyms)) {
      const w = String(word).trim();
      if (w === '' || keywords.includes(w)) continue;
      if (title.includes(w)) reasons.push(`비슷한 말 '${w}' 일치 (키워드 '${forKeyword}')`);
    }
    if (reasons.length === 0) continue;

    if (wanted.length > 0) {
      const limited = (n.limits && n.limits.regions) || [];
      if (limited.length === 0) {
        reasons.push('지역 제한 없음');
      } else {
        const key = wanted.find((k) => limited.includes(k));
        if (key === undefined) continue;
        reasons.push(`참가 가능 지역 '${key}' 일치`);
        const sub = subRegionLimit(n.limits.regionRaw, wanted.filter((k) => limited.includes(k)));
        if (sub) reasons.push(`참가 가능 지역이 시군구 단위로 제한됨: ${sub}`);
      }
    }

    const budget = n.budget;
    if (budget === null || budget === undefined) {
      reasons.push('예산 정보 없음');
    } else if (budget >= criteria.budgetMin && budget <= criteria.budgetMax) {
      reasons.push(`예산 범위 안 (${BASIS_LABEL[n.budgetBasis]} ${formatBudget(budget)}, 부가세 ${vatLabel(n)})`);
    } else {
      continue;
    }

    if (seen.has(n.bidId)) continue;
    seen.add(n.bidId);
    const m = {
      bidId: n.bidId,
      title,
      org: n.org,
      deadline: n.deadline,
      budget: budget ?? null,
      url: n.url,
      reasons,
      kind: n.kind,
      openingAt: n.openingAt,
      budgetBasis: n.budgetBasis,
      amounts: n.amounts,
    };
    const source = bid && bid.source !== undefined ? bid.source : n.raw && n.raw.source;
    if (source !== undefined) m.source = source;
    out.push(m);
  }
  out.sort((a, b) => {
    const x = String(a.deadline || '');
    const y = String(b.deadline || '');
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return out.slice(0, criteria.maxItems);
}

/**
 * @param {number|null} won
 * @returns {string}
 */
export function formatBudget(won) {
  if (won === null || won === undefined) return '미공개';
  if (won >= 100000000) {
    return (won / 1e8).toFixed(1).replace(/\.0$/, '') + '억';
  }
  return Math.round(won / 10000) + '만';
}

/**
 * @param {MatchedBid[]} matched
 * @param {string} isoDate 'YYYY-MM-DD'
 * @returns {Notification}
 */
export function buildNotification(matched, isoDate) {
  const [, mm, dd] = String(isoDate).split('-');
  const head = `입찰 레이더 · ${mm}/${dd}`;
  const count = matched.length;
  if (count === 0) {
    return { date: isoDate, count: 0, items: [], text: `${head} 오늘은 조건에 맞는 새 공고가 없습니다` };
  }
  const lines = [`${head} 새 공고 ${count}건`];
  matched.forEach((m, i) => {
    lines.push(`${i + 1}. ${m.title}`);
    lines.push(`   마감 ${m.deadline} · 예산 ${formatBudget(m.budget)}`);
    lines.push(`   왜 추천: ${m.reasons.join(' · ')}`);
    lines.push(`   ${m.url}`);
  });
  return { date: isoDate, count, items: matched, text: lines.join('\n') };
}

/** 시도 표준 키 → 원문에 나오는 이름들 (긴 이름 먼저 맞춘다) */
export const REGION_TABLE = {
  서울: ['서울특별시', '서울시', '서울'],
  부산: ['부산광역시', '부산시', '부산'],
  대구: ['대구광역시', '대구시', '대구'],
  인천: ['인천광역시', '인천시', '인천'],
  광주: ['광주광역시', '광주시', '광주'],
  대전: ['대전광역시', '대전시', '대전'],
  울산: ['울산광역시', '울산시', '울산'],
  세종: ['세종특별자치시', '세종시', '세종'],
  경기: ['경기도', '경기'],
  강원: ['강원특별자치도', '강원도', '강원'],
  충북: ['충청북도', '충북'],
  충남: ['충청남도', '충남'],
  전북: ['전북특별자치도', '전라북도', '전북'],
  전남: ['전라남도', '전남'],
  경북: ['경상북도', '경북'],
  경남: ['경상남도', '경남'],
  제주: ['제주특별자치도', '제주도', '제주'],
};

/**
 * 참가 가능 지역 원문 중 keys(시도 표준 키) 에 해당하는 조각이 모두 시군구 단위면 그 조각들을 ', ' 로 이어 돌려준다.
 * 시도 전체가 열린 조각이 하나라도 있거나 해당 조각이 없으면 null. ('경기도 수원시' → '경기도 수원시', '경기도' → null)
 * @param {string} text
 * @param {string[]} keys
 * @returns {string|null}
 */
export function subRegionLimit(text, keys) {
  const subs = [];
  let whole = false;
  for (const raw of String(text || '').split(/[,·/;\n]+/)) {
    const seg = raw.trim();
    if (seg === '') continue;
    const k = regionKeys(seg)[0];
    if (!k || !keys.includes(k)) continue;
    const name = REGION_TABLE[k].filter((n) => seg.startsWith(n)).sort((a, b) => b.length - a.length)[0];
    const rest = name ? seg.slice(name.length).trim() : seg;
    if (rest !== '' && /\S(시|군|구)(\s|$)/.test(rest)) subs.push(seg);
    else whole = true;
  }
  return !whole && subs.length > 0 ? subs.join(', ') : null;
}

/**
 * 원문에서 시도 표준 키를 뽑는다 (중복 제거, 나온 순서).
 * 쉼표 등으로 나눈 조각마다 앞머리의 시도 이름을 먼저 보고('경기도 광주시' → 경기),
 * 앞머리에 없으면 조각 안에서 가장 먼저 나오는 이름을 쓴다.
 * @param {string} text
 * @returns {string[]}
 */
export function regionKeys(text) {
  const out = [];
  const segments = String(text || '').split(/[,·/;\n]+/);
  for (const raw of segments) {
    const seg = raw.trim();
    if (seg === '') continue;
    let best = null;
    for (const [key, names] of Object.entries(REGION_TABLE)) {
      for (const name of names) {
        if (seg.startsWith(name) && (!best || best.at !== 0 || name.length > best.len)) {
          best = { key, at: 0, len: name.length };
        }
      }
    }
    if (!best) {
      for (const [key, names] of Object.entries(REGION_TABLE)) {
        for (const name of names) {
          const at = seg.indexOf(name);
          if (at < 0) continue;
          if (!best || at < best.at || (at === best.at && name.length > best.len)) {
            best = { key, at, len: name.length };
          }
        }
      }
    }
    if (best && !out.includes(best.key)) out.push(best.key);
  }
  return out;
}

/** @param {any} v */
function normText(v) {
  const s = v === null || v === undefined ? '' : String(v).trim();
  return s === '' ? null : s;
}

/** @param {any} v */
function normAmount(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 공고번호 목록 문자열 → 번호 배열. 실측은 쉼표 구분·차수 없음이지만 ; ^ | 공백도 받는다.
 * 토큰 끝 '-NNN'(차수) 제거, 영숫자 6자 이상만, 순서 유지 중복 제거. 문자열이 아니거나 비면 [].
 * @param {unknown} value
 * @returns {string[]}
 */
export function parseNoticeNos(value) {
  if (typeof value !== 'string') return [];
  const out = [];
  for (const raw of value.split(/[,;^|\s]+/)) {
    const no = raw.trim().replace(/-\d{3}$/, '');
    if (/^[A-Za-z0-9]{6,}$/.test(no) && !out.includes(no)) out.push(no);
  }
  return out;
}

/**
 * 나라장터 item(보조 목록 병합 포함)을 NormalizedBid 로 바꾼다. 이미 normalized(limits 있음)면 그대로.
 * @param {object} item
 * @param {string} [sourceId]
 * @returns {object} NormalizedBid
 */
export function normalizeBid(item, sourceId) {
  if (item && typeof item === 'object' && item.limits && typeof item.limits === 'object') return item;
  const it = item && typeof item === 'object' ? item : {};
  const src = String(sourceId ?? it.source ?? '');
  const prestd = /prestd/.test(src) || (!normText(it.bidNtceNo) && Boolean(normText(it.bfSpecRgstNo)));

  const noticeNo = prestd ? String(normText(it.bfSpecRgstNo) ?? '') : String(it.bidNtceNo ?? '');
  const ord = prestd ? '000' : String(it.bidNtceOrd ?? '');
  const bidId = prestd ? `PS${noticeNo}-000` : `${noticeNo}-${ord}`;

  let kind = 'new';
  if (prestd) kind = 'prestd';
  else {
    const k = String(it.ntceKindNm ?? '');
    if (k.includes('취소')) kind = 'cancelled';
    else if (k.includes('재공고')) kind = 'rebid';
    else if (k.includes('연기')) kind = 'postponed';
    else if (k.includes('변경')) kind = 'changed';
  }

  const estimated = normAmount(it.presmptPrce);
  const base = normAmount(it.bssamt);
  const assigned = normAmount(it.asignBdgtAmt) ?? normAmount(it.bdgtAmt);
  let budget = null;
  let budgetBasis = null;
  let vatIncluded = null;
  if (estimated !== null) [budget, budgetBasis, vatIncluded] = [estimated, 'estimated', false];
  else if (base !== null) [budget, budgetBasis, vatIncluded] = [base, 'base', true];
  else if (assigned !== null) [budget, budgetBasis, vatIncluded] = [assigned, 'assigned', true];

  const rgnList = Array.isArray(it.prtcptPsblRgnList) ? it.prtcptPsblRgnList : [];
  const rgnNames = rgnList.map((r) => normText(r && r.prtcptPsblRgnNm)).filter((s) => s !== null);
  const regionRaw = rgnNames.length > 0 ? rgnNames.join(', ') : normText(it.prtcptLmtRgnNm);

  const licenses = [];
  const lcnsList = Array.isArray(it.lcnsLmtList) ? it.lcnsLmtList : [];
  for (const l of lcnsList) {
    const s = normText(l && l.lcnsLmtNm);
    if (s === null) continue;
    const cut = s.lastIndexOf('/');
    const name = (cut >= 0 ? s.slice(0, cut) : s).trim();
    const code = cut >= 0 ? normText(s.slice(cut + 1)) : null;
    if (name === '' || licenses.some((x) => x.name === name && x.code === code)) continue;
    licenses.push({ name, code });
  }

  let attachments = [];
  if (Array.isArray(it.attachments)) {
    attachments = it.attachments.filter((a) => a && a.url).map((a) => ({ name: String(a.name ?? ''), url: String(a.url) }));
  } else {
    for (let i = 1; i <= 10; i++) {
      const url = normText(it[`ntceSpecDocUrl${i}`]);
      if (url === null) continue;
      attachments.push({ name: normText(it[`ntceSpecFileNm${i}`]) ?? url.split('/').pop(), url });
    }
  }

  const title = prestd ? normText(it.prdctClsfcNoNm) ?? normText(it.bfSpecNm) ?? '' : String(it.bidNtceNm ?? '');
  const noticeOrg = normText(it.ntceInsttNm) ?? (prestd ? normText(it.orderInsttNm) : null) ?? '';
  const org = normText(it.dminsttNm) ?? (prestd ? normText(it.rlDminsttNm) : null) ?? noticeOrg;

  const specNo = normText(it.bfSpecRgstNo);
  const links = prestd
    ? { prestdId: bidId, noticeNos: parseNoticeNos(it.bidNtceNoList) }
    : { prestdId: specNo ? `PS${specNo}-000` : null, noticeNos: [] };

  return {
    bidId,
    noticeNo,
    ord,
    kind,
    title,
    org,
    noticeOrg,
    postedAt: normText(it.bidNtceDt),
    deadline: normText(it.bidClseDt) ?? (prestd ? normText(it.opninRgstClseDt) : null),
    openingAt: normText(it.opengDt),
    amounts: { estimated, base, assigned, vatIncluded },
    budget,
    budgetBasis,
    limits: { regions: regionKeys(regionRaw || ''), regionRaw, licenses, sme: null },
    url: normText(it.bidNtceDtlUrl),
    attachments,
    sourceId: src,
    links,
    raw: item,
  };
}
