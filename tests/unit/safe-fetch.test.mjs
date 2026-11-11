import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { createSafeFetch, checkUrl, isBlockedAddress, MSG, BLOCKED_RANGES } from '../../app/core/safe-fetch.mjs';

// IPv4 주소는 리터럴로 적지 않고 바이트로 만든다
const v4 = (...b) => ipaddr.fromByteArray(b).toString();
const LOOPBACK = v4(127, 0, 0, 1);
const PRIVATE_A = v4(10, 0, 0, 5);
const PRIVATE_C = v4(192, 168, 1, 20);
const PUBLIC = v4(8, 8, 8, 8);

/** 주입 lookup: 표에 있는 이름만 해석, localhost 는 기기 안 해석(외부 네트워크 없음) */
function fakeLookup(table) {
  const calls = [];
  const fn = (host, opts, cb) => {
    calls.push(host);
    if (host === 'localhost') return dns.lookup(host, opts, cb);
    const ip = table[host];
    if (!ip) return cb(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
    const family = ipaddr.parse(ip).kind() === 'ipv6' ? 6 : 4;
    if (opts && opts.all) return cb(null, [{ address: ip, family }]);
    return cb(null, ip, family);
  };
  fn.calls = calls;
  return fn;
}

let server;
let base;
const hits = [];
before(async () => {
  server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('hello');
    }
    if (req.url === '/to-private') {
      res.writeHead(302, { location: 'http://inner.test/secret' });
      return res.end();
    }
    if (req.url === '/to-ok') {
      res.writeHead(301, { location: '/ok' });
      return res.end();
    }
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const limit = 5 * 1024 * 1024 + 1;
      const pump = () => {
        while (sent < limit) {
          const n = Math.min(chunk.length, limit - sent);
          sent += n;
          if (!res.write(chunk.subarray(0, n))) return res.once('drain', pump);
        }
        res.end();
      };
      return pump();
    }
    if (req.url === '/big-length') {
      res.writeHead(200, { 'content-length': String(6 * 1024 * 1024) });
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, 'localhost', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

describe('isBlockedAddress', () => {
  test('blocked ranges and IPv4-mapped', () => {
    assert.deepEqual(BLOCKED_RANGES.slice(0, 2), ['unspecified', 'broadcast']);
    for (const ip of [LOOPBACK, PRIVATE_A, PRIVATE_C, v4(169, 254, 169, 254), v4(100, 64, 0, 1), v4(0, 0, 0, 0), '::1', 'fd00::1', 'fe80::1', `::ffff:${LOOPBACK}`, 'garbage']) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    assert.equal(isBlockedAddress(PUBLIC), false);
    assert.equal(isBlockedAddress('2001:4860:4860::8888'), false);
  });
});

describe('checkUrl', () => {
  test('scheme, loopback name, private via lookup, allowHosts, public', async () => {
    const lookup = fakeLookup({ 'inner.test': PRIVATE_A, 'pub.test': PUBLIC });
    assert.deepEqual(await checkUrl('ftp://pub.test/x', { lookup }), { ok: false, code: 'URL_SCHEME', message: MSG.scheme });
    assert.equal((await checkUrl('http://localhost:9/x', { lookup })).code, 'SSRF_BLOCKED');
    assert.equal((await checkUrl('http://[::1]/x', { lookup })).code, 'SSRF_BLOCKED');
    assert.equal((await checkUrl(`http://${PRIVATE_C}/x`, { lookup })).message, MSG.blocked);
    assert.equal((await checkUrl('https://inner.test/x', { lookup })).code, 'SSRF_BLOCKED');
    assert.deepEqual(await checkUrl('http://LOCALHOST:9/x', { lookup, allowHosts: ['localhost'] }), { ok: true, host: 'localhost' });
    assert.deepEqual(await checkUrl('https://pub.test/rss', { lookup }), { ok: true, host: 'pub.test' });
  });
});

describe('safeFetch', () => {
  test('blocked: name resolving to loopback', async () => {
    const lookup = fakeLookup({ 'loop.test': LOOPBACK });
    const safeFetch = createSafeFetch({ lookup });
    await assert.rejects(safeFetch('http://loop.test/'), (err) => err.code === 'SSRF_BLOCKED' && err.message === MSG.blocked);
    assert.ok(lookup.calls.includes('loop.test'));
    await assert.rejects(safeFetch(`${base}/ok`), (err) => err.code === 'SSRF_BLOCKED');
  });

  test('blocked: name resolving to private address', async () => {
    const lookup = fakeLookup({ 'inner.test': PRIVATE_A });
    const safeFetch = createSafeFetch({ lookup });
    await assert.rejects(safeFetch('https://inner.test/x'), (err) => err.code === 'SSRF_BLOCKED');
    await assert.rejects(safeFetch(`http://${PRIVATE_C}/x`), (err) => err.code === 'SSRF_BLOCKED');
  });

  test('blocked: redirect to private address is checked again', async () => {
    const lookup = fakeLookup({ 'inner.test': PRIVATE_C });
    const safeFetch = createSafeFetch({ lookup, allowHosts: ['localhost'] });
    await assert.rejects(safeFetch(`${base}/to-private`), (err) => err.code === 'SSRF_BLOCKED');
    assert.ok(lookup.calls.includes('inner.test'));
    // 리다이렉트가 IP 리터럴이면 해석 없이 막는다 (주입 fetch)
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: `http://${PRIVATE_A}/` } });
    await assert.rejects(createSafeFetch({ fetchImpl, lookup })('https://pub.test/'), (err) => err.code === 'SSRF_BLOCKED');
  });

  test('blocked: body over 5MB (streamed and by content-length)', async () => {
    const safeFetch = createSafeFetch({ lookup: fakeLookup({}), allowHosts: ['localhost'] });
    await assert.rejects(safeFetch(`${base}/big`), (err) => err.code === 'BODY_TOO_LARGE' && err.message === MSG.tooLarge(5));
    await assert.rejects(safeFetch(`${base}/big-length`), (err) => err.code === 'BODY_TOO_LARGE');
    const ok = await safeFetch(`${base}/big`, { maxBytes: 6 * 1024 * 1024 });
    assert.equal((await ok.arrayBuffer()).byteLength, 5 * 1024 * 1024 + 1);
  });

  test('allowed: allow-listed host, redirects followed, buffered response', async () => {
    const safeFetch = createSafeFetch({ lookup: fakeLookup({}), allowHosts: ['localhost'] });
    const res = await safeFetch(`${base}/to-ok`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'hello');
  });

  test('redirect to another origin drops credential headers', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init.headers) });
      if (seen.length === 1) return new Response(null, { status: 302, headers: { location: 'https://other.test/next' } });
      return new Response('ok', { status: 200 });
    };
    const headers = { authorization: 'Bearer s', Cookie: 'a=1', 'proxy-authorization': 'Basic p', 'x-keep': 'k' };
    const res = await createSafeFetch({ fetchImpl, lookup: fakeLookup({}) })('https://pub.test/a', { headers });
    assert.equal(res.status, 200);
    assert.equal(seen[0].headers.get('authorization'), 'Bearer s');
    assert.equal(seen[1].url, 'https://other.test/next');
    assert.equal(seen[1].headers.get('authorization'), null);
    assert.equal(seen[1].headers.get('cookie'), null);
    assert.equal(seen[1].headers.get('proxy-authorization'), null);
    assert.equal(seen[1].headers.get('x-keep'), 'k');
  });

  test('redirect within the same origin keeps credential headers', async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init.headers) });
      if (seen.length === 1) return new Response(null, { status: 301, headers: { location: '/b' } });
      return new Response('ok', { status: 200 });
    };
    const headers = new Headers({ authorization: 'Bearer s', cookie: 'a=1' });
    await createSafeFetch({ fetchImpl, lookup: fakeLookup({}) })('https://pub.test/a', { headers });
    assert.equal(seen[1].url, 'https://pub.test/b');
    assert.equal(seen[1].headers.get('authorization'), 'Bearer s');
    assert.equal(seen[1].headers.get('cookie'), 'a=1');
  });

  test('scheme, too many redirects, timeout codes', async () => {
    const lookup = fakeLookup({});
    await assert.rejects(createSafeFetch({ lookup })('file:///etc/hosts'), (err) => err.code === 'URL_SCHEME');
    const loop = async (url) => new Response(null, { status: 302, headers: { location: String(url) } });
    await assert.rejects(createSafeFetch({ fetchImpl: loop, lookup, maxRedirects: 2 })('https://pub.test/a'), (err) => err.code === 'TOO_MANY_REDIRECTS');
    const slow = (url, init) =>
      new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    await assert.rejects(createSafeFetch({ fetchImpl: slow, lookup })('https://pub.test/', { timeoutMs: 20 }), (err) => err.code === 'TIMEOUT');
  });
});
