// 게시판 (RSS) 어댑터: RSS 2.0 · Atom 피드를 공고 형태(NaraBid)로 바꾼다
import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const FETCH_TIMEOUT_MS = 20000;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const NO_DEADLINE = '9999-12-31 00:00:00';
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const MSG = {
  noUrl: '주소를 적어 주세요.',
  badUrl: '주소는 http:// 또는 https:// 로 시작해야 합니다.',
  noOrg: '기관 이름을 적어 주세요.',
  notXml: '피드를 읽지 못했습니다 (XML 아님)',
  blocked: '이 주소는 쓸 수 없습니다 (내부 네트워크 주소).',
  tooLarge: '피드가 너무 큽니다 (5MB 초과).',
  connect: '게시판에 연결하지 못했습니다. 주소를 확인한 뒤 지금 가져오기를 다시 눌러 주세요.',
  http: (status) => `게시판이 응답하지 않았습니다 (응답 코드 ${status}). 주소를 확인한 뒤 지금 가져오기를 다시 눌러 주세요.`,
};

const sourceError = (msg) => new Error(`SOURCE_ERROR: ${msg}`);

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** 파서 결과의 글자 값 ('#text' 객체·CDATA·숫자 모두) */
function textOf(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') return str(v['#text']);
  return str(v);
}

const asList = (v) => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Atom link: rel 이 없거나 alternate 인 것의 href. RSS link: 글자 */
function linkOf(v) {
  const list = asList(v);
  const pick = (l) => (l && typeof l === 'object' ? str(l['@_href']) || textOf(l) : str(l));
  const alt = list.find((l) => l && typeof l === 'object' && (!l['@_rel'] || l['@_rel'] === 'alternate'));
  if (alt) return pick(alt);
  for (const l of list) {
    const got = pick(l);
    if (got) return got;
  }
  return '';
}

/** Date → 'yyyy-MM-dd HH:mm:ss' (Asia/Seoul) */
export function formatKst(date) {
  const d = new Date(date.getTime() + KST_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** '마감' 뒤 첫 yyyy-MM-dd 또는 yyyy.MM.dd → 'yyyy-MM-dd 00:00:00'. 없으면 null */
export function deadlineIn(text) {
  const s = String(text ?? '');
  const at = s.indexOf('마감');
  if (at < 0) return null;
  const m = /(\d{4})[-.](\d{1,2})[-.](\d{1,2})/.exec(s.slice(at + 2));
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')} 00:00:00`;
}

function parseDate(s) {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t);
}

/** 피드 글자 → 항목 [{title, link, description, published}] . 피드가 아니면 throw */
export function parseFeed(xml) {
  const text = String(xml ?? '').trim();
  if (!text.startsWith('<') || XMLValidator.validate(text) !== true) throw sourceError(MSG.notXml);
  let doc;
  try {
    doc = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true }).parse(text);
  } catch {
    throw sourceError(MSG.notXml);
  }
  if (doc && doc.rss && typeof doc.rss === 'object') {
    const channel = Array.isArray(doc.rss.channel) ? doc.rss.channel[0] : doc.rss.channel;
    return asList(channel && channel.item).map((it) => ({
      title: textOf(it.title),
      link: linkOf(it.link) || textOf(it.guid),
      description: textOf(it.description),
      published: textOf(it.pubDate) || textOf(it['dc:date']),
    }));
  }
  if (doc && doc.feed && typeof doc.feed === 'object') {
    return asList(doc.feed.entry).map((it) => ({
      title: textOf(it.title),
      link: linkOf(it.link) || textOf(it.id),
      description: textOf(it.summary) || textOf(it.content),
      published: textOf(it.published) || textOf(it.updated),
    }));
  }
  throw sourceError(MSG.notXml);
}

/** 항목 하나 → NaraBid 형태 */
export function toBid(item, config) {
  const org = str(config && config.orgName);
  const published = parseDate(item.published);
  return {
    bidNtceNo: 'rss:' + createHash('sha1').update(item.link).digest('hex').slice(0, 16),
    bidNtceOrd: '000',
    bidNtceNm: item.title,
    ntceInsttNm: org,
    dminsttNm: org,
    bidNtceDt: published ? formatKst(published) : '',
    bidClseDt: deadlineIn(item.title) || deadlineIn(item.description) || NO_DEADLINE,
    presmptPrce: '',
    asignBdgtAmt: '',
    bidNtceDtlUrl: item.link,
    source: 'rss',
  };
}

export const adapter = {
  type: 'rss',
  label: '게시판 (RSS)',
  configFields: [
    { key: 'url', label: '주소', required: true, placeholder: 'https://…/rss' },
    { key: 'orgName', label: '기관 이름', required: true },
    { key: 'region', label: '지역', required: false },
  ],
  /** @returns {string[]} */
  validate(config) {
    const c = config || {};
    const errors = [];
    const url = str(c.url);
    if (!url) errors.push(MSG.noUrl);
    else if (!/^https?:\/\/\S+$/i.test(url)) errors.push(MSG.badUrl);
    if (!str(c.orgName)) errors.push(MSG.noOrg);
    return errors;
  },
  /** @returns {Promise<object[]>} 실패: SOURCE_ERROR: <사용자 문구> */
  async fetch(config, { since, fetchImpl } = {}) {
    const url = str(config && config.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    let body;
    try {
      res = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
        maxBytes: MAX_FEED_BYTES,
      });
      body = await res.text();
    } catch (err) {
      if (err && err.code === 'SSRF_BLOCKED') throw sourceError(MSG.blocked);
      if (err && err.code === 'BODY_TOO_LARGE') throw sourceError(MSG.tooLarge);
      throw sourceError(MSG.connect);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw sourceError(MSG.http(res.status));
    const from = since instanceof Date ? since : since ? new Date(since) : null;
    const items = parseFeed(body).filter((it) => it.link && it.title);
    return items
      .filter((it) => {
        if (!from || Number.isNaN(from.getTime())) return true;
        const d = parseDate(it.published);
        return d === null || d.getTime() >= from.getTime();
      })
      .map((it) => toBid(it, config));
  },
};

export default adapter;
