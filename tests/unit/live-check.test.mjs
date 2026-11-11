import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNaraUrl, pagesFor } from '../../scripts/live-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts/live-check.mjs');

const args = {
  base: 'https://apis.data.go.kr/1230000/ad/BidPublicInfoService',
  operation: 'getBidPblancListInfoCnstwk',
  key: 'dummy-key',
  from: '202610280900',
  to: '202610290900',
};

test('buildNaraUrl path ends with operation', () => {
  const u = new URL(buildNaraUrl(args));
  assert.ok(u.pathname.endsWith('/getBidPblancListInfoCnstwk'), u.pathname);
  assert.equal(u.pathname, '/1230000/ad/BidPublicInfoService/getBidPblancListInfoCnstwk');
});

test('buildNaraUrl query has key, type, inqryDiv, paging and 12-digit dates', () => {
  const q = new URL(buildNaraUrl(args)).searchParams;
  assert.equal(q.get('serviceKey'), 'dummy-key');
  assert.equal(q.get('type'), 'json');
  assert.equal(q.get('inqryDiv'), '1');
  assert.equal(q.get('pageNo'), '1');
  assert.equal(q.get('numOfRows'), '10');
  assert.match(q.get('inqryBgnDt'), /^\d{12}$/);
  assert.match(q.get('inqryEndDt'), /^\d{12}$/);
  assert.equal(q.get('inqryBgnDt'), '202610280900');
  assert.equal(q.get('inqryEndDt'), '202610290900');
});

test('buildNaraUrl rows overrides numOfRows and base trailing slash is tolerated', () => {
  const u = new URL(buildNaraUrl({ ...args, base: args.base + '/', rows: 100 }));
  assert.equal(u.searchParams.get('numOfRows'), '100');
  assert.equal(u.pathname, '/1230000/ad/BidPublicInfoService/getBidPblancListInfoCnstwk');
});

test('buildNaraUrl encodes special characters in key', () => {
  const q = new URL(buildNaraUrl({ ...args, key: 'a+b/c==' })).searchParams;
  assert.equal(q.get('serviceKey'), 'a+b/c==');
});

test('buildNaraUrl pageNo and inqryDiv (3 = 변경일시)', () => {
  const q = new URL(buildNaraUrl({ ...args, rows: 500, pageNo: 2, inqryDiv: 3 })).searchParams;
  assert.equal(q.get('pageNo'), '2');
  assert.equal(q.get('inqryDiv'), '3');
  assert.equal(q.get('numOfRows'), '500');
});

test('pagesFor uses NARA_ROWS (default 500)', () => {
  assert.equal(pagesFor(650), 2);
  assert.equal(pagesFor(650, '100'), 7);
  assert.equal(pagesFor(0), 1);
  assert.equal(pagesFor(undefined, 'x'), 1);
});

test('with key: child prints LIVE_OK with totalCount and pages', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ response: { header: { resultCode: '00', resultMsg: 'OK' }, body: { items: [], numOfRows: 10, pageNo: 1, totalCount: 650 } } }));
  });
  await new Promise((r) => server.listen(0, 'localhost', r));
  const { port } = server.address();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          NARA_API_KEY: 'dummy-key',
          NARA_API_BASE: `http://localhost:${port}/svc`,
          NARA_BID_OPERATION: 'getBidPblancListInfoCnstwk',
        },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
    });
    assert.equal(result.stdout.trim(), 'LIVE_OK resultCode=00 totalCount=650 pages=2');
    assert.equal(result.code, 0);
    assert.equal(seen.length, 1);
    assert.ok(!result.stdout.includes('dummy-key'));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('no key: child prints LIVE_SKIP, exits 2, makes no network call', async () => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, 'localhost', r));
  const { port } = server.address();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT], {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          NARA_API_KEY: '',
          NARA_API_BASE: `http://localhost:${port}/svc`,
          NARA_BID_OPERATION: 'getBidPblancListInfoCnstwk',
        },
      });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout }));
    });
    assert.equal(result.stdout.trim(), 'LIVE_SKIP NARA_API_KEY missing');
    assert.equal(result.code, 2);
    assert.equal(hits, 0);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
