import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { adapter as rss } from '../../app/modules/sources/adapters/rss.mjs';
import { relativeTime } from '../../app/modules/sources/service.mjs';
import { matchBids } from '../../src/match.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tmpRoots = [];
const runtimes = [];
after(() => {
  for (const r of runtimes) r.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

const SINCE = new Date('2026-10-28T00:00:00+09:00');

function rss2(items) {
  const body = items
    .map(
      (it) =>
        `<item><title>${it.title}</title><link>${it.link}</link>${it.description ? `<description><![CDATA[${it.description}]]></description>` : ''}${it.pubDate ? `<pubDate>${it.pubDate}</pubDate>` : ''}</item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>게시판</title><link>https://feed.example/</link>${body}</channel></rss>`;
}

function atom(entries) {
  const body = entries
    .map(
      (e) =>
        `<entry><title type="text">${e.title}</title><link rel="alternate" href="${e.link}"/><id>${e.link}</id>${e.published ? `<published>${e.published}</published>` : ''}${e.summary ? `<summary>${e.summary}</summary>` : ''}</entry>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>게시판</title>${body}</feed>`;
}

function stub(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const hit = map[String(url)];
    if (!hit) return new Response('not found', { status: 404 });
    if (hit instanceof Error) throw hit;
    return new Response(hit.body, { status: hit.status ?? 200, headers: { 'content-type': hit.type ?? 'application/rss+xml' } });
  };
  fn.calls = calls;
  return fn;
}

const CFG = { url: 'https://feed.example/board/rss', orgName: '경기도 수원시', region: '경기' };

async function fetchWith(body, opts = {}) {
  return rss.fetch(CFG, { since: SINCE, fetchImpl: stub({ [CFG.url]: { body, ...opts } }), env: {} });
}

describe('rss adapter', () => {
  test('RSS 2.0 item maps to bid shape', async () => {
    const bids = await fetchWith(
      rss2([
        { title: '공원 시설물 보수 공사 입찰공고 (마감 2026-11-20)', link: 'https://feed.example/board/1', pubDate: 'Wed, 28 Oct 2026 09:30:00 +0900' },
        { title: '두번째 공고', link: 'https://feed.example/board/2', pubDate: 'Wed, 28 Oct 2026 10:00:00 +0900' },
      ]),
    );
    assert.equal(bids.length, 2);
    const b = bids[0];
    assert.match(b.bidNtceNo, /^rss:[0-9a-f]{16}$/);
    assert.equal(b.bidNtceOrd, '000');
    assert.equal(b.bidNtceNm, '공원 시설물 보수 공사 입찰공고 (마감 2026-11-20)');
    assert.equal(b.ntceInsttNm, '경기도 수원시');
    assert.equal(b.dminsttNm, '경기도 수원시');
    assert.equal(b.bidNtceDt, '2026-10-28 09:30:00');
    assert.equal(b.bidClseDt, '2026-11-20 00:00:00');
    assert.equal(b.presmptPrce, '');
    assert.equal(b.asignBdgtAmt, '');
    assert.equal(b.bidNtceDtlUrl, 'https://feed.example/board/1');
    assert.equal(b.source, 'rss');
    assert.equal(b.regionLimit, undefined);
    assert.notEqual(bids[0].bidNtceNo, bids[1].bidNtceNo);
  });

  test('Atom entry maps with link href and KST date', async () => {
    const bids = await fetchWith(
      atom([{ title: '가로수 정비 용역 (마감 2026.11.20)', link: 'https://feed.example/atom/7', published: '2026-10-28T01:00:00Z' }]),
      { type: 'application/atom+xml' },
    );
    assert.equal(bids.length, 1);
    assert.match(bids[0].bidNtceNo, /^rss:[0-9a-f]{16}$/);
    assert.equal(bids[0].bidNtceNm, '가로수 정비 용역 (마감 2026.11.20)');
    assert.equal(bids[0].bidNtceDtlUrl, 'https://feed.example/atom/7');
    assert.equal(bids[0].bidNtceDt, '2026-10-28 10:00:00');
    assert.equal(bids[0].bidClseDt, '2026-11-20 00:00:00');
  });

  test('deadline: dotted format, none, and from description', async () => {
    const bids = await fetchWith(
      rss2([
        { title: '수목 관리 (마감 2026.11.20)', link: 'https://feed.example/d/1' },
        { title: '마감 언급 없는 공고', link: 'https://feed.example/d/2', description: '자세한 내용은 첨부 참조' },
        { title: '조경 공사 안내', link: 'https://feed.example/d/3', description: '<p>접수 마감: 2026-12-01 18:00</p>' },
        { title: '그냥 공고', link: 'https://feed.example/d/4' },
      ]),
    );
    assert.deepEqual(
      bids.map((b) => b.bidClseDt),
      ['2026-11-20 00:00:00', '9999-12-31 00:00:00', '2026-12-01 00:00:00', '9999-12-31 00:00:00'],
    );
  });

  test('since drops older items, keeps items without date', async () => {
    const bids = await fetchWith(
      rss2([
        { title: '오래된 공고', link: 'https://feed.example/s/1', pubDate: 'Mon, 26 Oct 2026 09:00:00 +0900' },
        { title: '새 공고', link: 'https://feed.example/s/2', pubDate: 'Thu, 29 Oct 2026 09:00:00 +0900' },
        { title: '날짜 없는 공고', link: 'https://feed.example/s/3' },
      ]),
    );
    assert.deepEqual(
      bids.map((b) => b.bidNtceNm),
      ['새 공고', '날짜 없는 공고'],
    );
    assert.equal(bids[1].bidNtceDt, '');
  });

  test('feed with a single item (not an array)', async () => {
    const bids = await fetchWith(rss2([{ title: '하나뿐인 공고', link: 'https://feed.example/one' }]));
    assert.equal(bids.length, 1);
    assert.equal(bids[0].bidNtceNm, '하나뿐인 공고');
  });

  test('HTML instead of XML → SOURCE_ERROR not xml', async () => {
    await assert.rejects(
      fetchWith('<!DOCTYPE html><html><head><title>안내</title></head><body><p>점검 중<br></p></body></html>', { type: 'text/html' }),
      (err) => err.message === 'SOURCE_ERROR: 피드를 읽지 못했습니다 (XML 아님)',
    );
    await assert.rejects(fetchWith('{"a":1}'), (err) => err.message === 'SOURCE_ERROR: 피드를 읽지 못했습니다 (XML 아님)');
  });

  test('HTTP 500 and network error → Korean SOURCE_ERROR', async () => {
    await assert.rejects(fetchWith('oops', { status: 500 }), (err) => {
      assert.match(err.message, /^SOURCE_ERROR: /);
      assert.match(err.message, /500/);
      assert.match(err.message, /[가-힣]/);
      assert.doesNotMatch(err.message.slice('SOURCE_ERROR:'.length), /[A-Za-z]{3,}/);
      return true;
    });
    await assert.rejects(
      rss.fetch(CFG, { since: SINCE, fetchImpl: stub({ [CFG.url]: new TypeError('fetch failed') }), env: {} }),
      (err) => /^SOURCE_ERROR: [가-힣]/.test(err.message) && !/fetch failed/.test(err.message),
    );
  });

  test('validate: empty url and empty org name', () => {
    assert.deepEqual(rss.validate({ url: '', orgName: '수원시' }), ['주소를 적어 주세요.']);
    assert.deepEqual(rss.validate({ url: 'https://feed.example/rss', orgName: '  ' }), ['기관 이름을 적어 주세요.']);
    assert.deepEqual(rss.validate({ url: 'https://feed.example/rss', orgName: '수원시' }), []);
    assert.equal(rss.validate({ url: 'ftp://x', orgName: '수원시' }).length, 1);
    assert.equal(rss.type, 'rss');
    assert.equal(rss.label, '게시판 (RSS)');
    assert.deepEqual(
      rss.configFields.map((f) => [f.key, f.required]),
      [
        ['url', true],
        ['orgName', true],
        ['region', false],
      ],
    );
  });

  test('adapter output feeds matchBids: only the first bid matches', async () => {
    const bids = await fetchWith(
      rss2([
        { title: '가로수 정비', link: 'https://feed.example/m/1' },
        { title: '사무용품 구매', link: 'https://feed.example/m/2' },
      ]),
    );
    const criteria = { keywords: ['조경', '수목', '가로수', '공원'], regions: ['경기', '서울'], budgetMin: 30000000, budgetMax: 500000000, maxItems: 5 };
    const matched = matchBids(bids, criteria);
    assert.equal(matched.length, 1);
    assert.equal(matched[0].title, '가로수 정비');
    assert.equal(matched[0].bidId, `${bids[0].bidNtceNo}-000`);
  });

  test('relativeTime labels', () => {
    const now = new Date('2026-10-29T12:00:00+09:00');
    assert.equal(relativeTime('2026-10-29T03:00:00.000Z', now), '방금');
    assert.equal(relativeTime('2026-10-29T02:55:00.000Z', now), '5분 전');
    assert.equal(relativeTime('2026-10-29T00:00:00.000Z', now), '3시간 전');
    assert.equal(relativeTime('2026-10-27T03:00:00.000Z', now), '2일 전');
  });
});

// --- 메뉴 (createRuntime 격리: sources 모듈 폴더만 symlink) ---

const FEED_URL = 'https://feed.example/park/rss';
const THREE = rss2([
  { title: '공원 시설물 보수 공사 입찰공고 (마감 2026-11-20)', link: 'https://feed.example/park/1', pubDate: 'Thu, 29 Oct 2026 09:00:00 +0900' },
  { title: '청사 청소 용역', link: 'https://feed.example/park/2', pubDate: 'Thu, 29 Oct 2026 09:10:00 +0900' },
  { title: '사무용품 구매', link: 'https://feed.example/park/3', pubDate: 'Thu, 29 Oct 2026 09:20:00 +0900' },
]);

async function app(map = { [FEED_URL]: { body: THREE } }) {
  const modulesDir = mkdtempSync(path.join(tmpdir(), 'br-src-mod-'));
  tmpRoots.push(modulesDir);
  symlinkSync(path.join(ROOT, 'app/modules/sources'), path.join(modulesDir, 'sources'), 'dir');
  const fetchImpl = stub(map);
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir,
    secret: 'x',
    jobToken: 't',
    env: {},
    fetchImpl,
    fakeNow: '2026-10-29',
  });
  runtimes.push(r);
  return { r, fetchImpl };
}

function call(r, url, init = {}) {
  return r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
}

async function login(r) {
  const res = await call(r, '/setup', { method: 'POST', body: new URLSearchParams({ company: '테스트 조경', name: '대표' }) });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

function post(r, url, cookie, fields = {}) {
  return call(r, url, { method: 'POST', headers: { cookie }, body: new URLSearchParams(fields) });
}

const sourceCount = async (r) => Number((await r.ctx.db.get('SELECT COUNT(*) AS n FROM sources')).n);

describe('sources menu', () => {
  test('manifest and adapters(): rss after nara', async () => {
    const { r } = await app();
    const m = r.modules.find((x) => x.id === 'sources');
    assert.equal(m.title, '공고 소스');
    assert.equal(m.group, '더 넓게');
    assert.equal(m.order, 32);
    assert.equal(m.path, '/sources');
    assert.equal(m.help, '나라장터 외에 지자체·기관 게시판을 더 붙이고 가져온 결과를 확인합니다.');
    assert.deepEqual(
      r.ctx.sources.adapters().map((a) => a.type),
      ['nara', 'rss'],
    );
  });

  test('without login → /welcome', async () => {
    const { r } = await app();
    await login(r);
    const res = await call(r, '/sources');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/welcome');
    const res2 = await call(r, '/sources/nara-cnstwk/fetch', { method: 'POST' });
    assert.equal(res2.headers.get('location'), '/welcome');
  });

  test('list shows seed nara without delete, add form from configFields', async () => {
    const { r } = await app();
    const cookie = await login(r);
    const res = await call(r, '/sources', { headers: { cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /나라장터 공사/);
    assert.match(html, /아직 가져온 적 없음/);
    assert.match(html, /지금 가져오기/);
    assert.doesNotMatch(html, /nara-cnstwk\/delete/);
    assert.match(html, /name="cfg_url"/);
    assert.match(html, /name="cfg_orgName"/);
    assert.match(html, /name="cfg_region"/);
    assert.match(html, /게시판 \(RSS\)/);
    assert.match(html, /소스 추가/);
    assert.match(html, /<span>주소 \(필수\)<\/span>/);
    assert.match(html, /<span>기관 이름 \(필수\)<\/span>/);
    assert.match(html, /<span>지역 \(선택\)<\/span>/);
    assert.match(html, /<span>목록에 보일 이름 \(선택\)<\/span>/);
    assert.match(html, /비워 두면 기관 이름으로 저장합니다\./);
    assert.doesNotMatch(html, /종류: /);
  });

  test('add with empty url: message shown, nothing saved', async () => {
    const { r } = await app();
    const cookie = await login(r);
    const before = await sourceCount(r);
    const res = await post(r, '/sources', cookie, { type: 'rss', cfg_url: '', cfg_orgName: '경기도 수원시', name: '' });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /주소를 적어 주세요\./);
    assert.equal((html.match(/class="error"/g) || []).length, 1);
    assert.equal(await sourceCount(r), before);
  });

  test('add then fetch now → row shows 방금 · 3건 and bids are stored', async () => {
    const { r, fetchImpl } = await app();
    const cookie = await login(r);
    const add = await post(r, '/sources', cookie, { type: 'rss', cfg_url: FEED_URL, cfg_orgName: '경기도 수원시', cfg_region: '경기', name: '' });
    assert.equal(add.status, 303);
    const src = (await r.ctx.sources.list()).find((s) => s.type === 'rss');
    assert.ok(src);
    assert.equal(src.name, '경기도 수원시');
    assert.deepEqual(src.config, { url: FEED_URL, orgName: '경기도 수원시', region: '경기' });

    const run = await post(r, `/sources/${src.id}/fetch`, cookie);
    assert.equal(run.status, 303);
    assert.equal(run.headers.get('location'), '/sources');
    assert.deepEqual(fetchImpl.calls, [FEED_URL]);
    const html = await (await call(r, '/sources', { headers: { cookie } })).text();
    assert.match(html, /방금 · 3건/);
    assert.doesNotMatch(html, /가져오지 못함/);
    const n = Number((await r.ctx.db.get("SELECT COUNT(*) AS n FROM bids WHERE bid_id LIKE 'rss:%'")).n);
    assert.equal(n, 3);
  });

  test('fetch now on HTML feed → row error with next step', async () => {
    const url = 'https://feed.example/broken/rss';
    const { r } = await app({ [url]: { body: '<html><body>안내</body></html>', type: 'text/html' } });
    const cookie = await login(r);
    const add = await r.ctx.sources.add({ type: 'rss', name: '깨진 게시판', config: { url, orgName: '어느 기관' } });
    assert.ok(add.ok);
    await post(r, `/sources/${add.source.id}/fetch`, cookie);
    const html = await (await call(r, '/sources', { headers: { cookie } })).text();
    assert.match(html, /방금 · 가져오지 못함/);
    assert.match(html, /피드를 읽지 못했습니다 \(XML 아님\)\. 소스 설정을 확인한 뒤 지금 가져오기를 다시 눌러 주세요\./);
  });

  test('toggle and delete', async () => {
    const { r } = await app();
    const cookie = await login(r);
    const add = await r.ctx.sources.add({ type: 'rss', name: '게시판', config: { url: FEED_URL, orgName: '기관' } });
    await post(r, `/sources/${add.source.id}/toggle`, cookie);
    assert.equal((await r.ctx.sources.get(add.source.id)).enabled, false);
    const html = await (await call(r, '/sources', { headers: { cookie } })).text();
    assert.match(html, /꺼짐/);
    await post(r, `/sources/${add.source.id}/delete`, cookie);
    assert.equal(await r.ctx.sources.get(add.source.id), null);
    const del = await post(r, '/sources/nara-cnstwk/delete', cookie);
    assert.equal(del.status, 400);
    assert.ok((await r.ctx.sources.get('nara-cnstwk')));
  });
});

describe('sources: owner only and blocked addresses', () => {
  async function staffCookie(r) {
    const { inviteToken } = await r.ctx.members.create({ name: '사무담당', role: 'staff' });
    const res = await call(r, `/join/${inviteToken}`);
    return (res.headers.get('set-cookie') || '').split(';')[0];
  }

  test('staff: add, toggle and delete → 403 with message, nothing changed; list hides edit controls', async () => {
    const { r } = await app();
    await login(r);
    const add = await r.ctx.sources.add({ type: 'rss', name: '게시판', config: { url: FEED_URL, orgName: '기관' } });
    const cookie = await staffCookie(r);
    const before = await sourceCount(r);
    for (const [url, fields] of [
      ['/sources', { type: 'rss', cfg_url: FEED_URL, cfg_orgName: '경기도 수원시', name: '' }],
      [`/sources/${add.source.id}/toggle`, {}],
      [`/sources/${add.source.id}/delete`, {}],
    ]) {
      const res = await post(r, url, cookie, fields);
      assert.equal(res.status, 403, url);
      assert.match(await res.text(), /공고 소스 추가와 변경은 대표만 할 수 있습니다\./);
    }
    assert.equal(await sourceCount(r), before);
    assert.equal((await r.ctx.sources.get(add.source.id)).enabled, true);
    const html = await (await call(r, '/sources', { headers: { cookie } })).text();
    assert.match(html, /지금 가져오기/);
    assert.doesNotMatch(html, /name="cfg_url"/);
    assert.doesNotMatch(html, /\/toggle"/);
    assert.match(html, /공고 소스 추가와 변경은 대표만 할 수 있습니다\./);
  });

  test('owner: internal address → 400 with message, nothing saved', async () => {
    const { r } = await app();
    const cookie = await login(r);
    const before = await sourceCount(r);
    for (const url of ['http://localhost:8820/rss', 'http://[::1]/rss']) {
      const res = await post(r, '/sources', cookie, { type: 'rss', cfg_url: url, cfg_orgName: '어느 기관', name: '' });
      assert.equal(res.status, 400, url);
      assert.match(await res.text(), /이 주소는 쓸 수 없습니다 \(내부 네트워크 주소\)\./);
    }
    assert.equal(await sourceCount(r), before);
  });

  test('rss adapter maps blocked and too-large fetch errors', async () => {
    const blocked = async () => {
      throw Object.assign(new Error('x'), { code: 'SSRF_BLOCKED' });
    };
    await assert.rejects(rss.fetch(CFG, { fetchImpl: blocked }), /^Error: SOURCE_ERROR: 이 주소는 쓸 수 없습니다 \(내부 네트워크 주소\)\.$/);
    const big = async (url, init) => {
      assert.equal(init.maxBytes, 5 * 1024 * 1024);
      throw Object.assign(new Error('x'), { code: 'BODY_TOO_LARGE' });
    };
    await assert.rejects(rss.fetch(CFG, { fetchImpl: big }), /SOURCE_ERROR: 피드가 너무 큽니다 \(5MB 초과\)\./);
  });
});
