import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from '../../app/core/registry.mjs';
import { hwpxText } from '../../app/core/hwpx.mjs';
import { hwpText } from '../../app/core/hwp.mjs';

const DOCS = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'docs');
const doc = (name) => readFileSync(path.join(DOCS, name));

const tmpRoots = [];
const runtimes = [];
after(() => {
  for (const r of runtimes) r.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

/** handler(url, init) → Response (throw 하면 네트워크 오류) */
function stubFetch(handler = () => new Response('{}')) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  fn.calls = calls;
  return fn;
}

async function rt({ env = { NARA_API_KEY: 'dummy-key', NARA_API_BASE: 'http://nara.test/svc' }, fetchImpl = stubFetch(), modulesDir } = {}) {
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir: modulesDir ?? tmp('br-mod-'),
    secret: 'x',
    jobToken: 't',
    env,
    fetchImpl,
    fakeNow: '2026-10-29',
  });
  runtimes.push(r);
  return r;
}


function bid(no, extra = {}) {
  return {
    bidNtceNo: no,
    bidNtceOrd: '000',
    bidNtceNm: `공고 ${no}`,
    ntceInsttNm: '경기도 수원시',
    dminsttNm: '경기도 수원시',
    bidNtceDt: '2026-10-29 09:00:00',
    bidClseDt: '2026-11-07 10:00:00',
    presmptPrce: '',
    asignBdgtAmt: '120000000',
    bidNtceDtlUrl: `https://www.g2b.go.kr/link/${no}`,
    ...extra,
  };
}

/** 한 줄 텍스트가 들어 있는 최소 PDF (xref 오프셋을 계산해 만든다) */
function makePdf(line) {
  const stream = line === null ? '' : `BT /F1 24 Tf 72 720 Td (${line}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('bid text', () => {
  async function withBid(attachments, handler) {
    const f = stubFetch(handler);
    const r = await rt({ fetchImpl: f });
    await r.ctx.bids.upsert(bid('900', { attachments }), 'nara-cnstwk');
    return { r, f, id: '900-000' };
  }

  test('bidText: txt attachment → ok, second call uses cache', async () => {
    const { r, f, id } = await withBid([{ name: '과업내용.txt', url: 'https://doc.test/a.txt' }], () => new Response('가로수 전정 과업 내용', { headers: { 'content-type': 'text/plain; charset=utf-8' } }));
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'ok', text: '가로수 전정 과업 내용' });
    assert.equal(f.calls.length, 1);
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'ok', text: '가로수 전정 과업 내용' });
    assert.equal(f.calls.length, 1);
  });

  test('bidText: no attachments → none', async () => {
    const { r, f, id } = await withBid([], () => new Response('x'));
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'none', text: '' });
    assert.equal(f.calls.length, 0);
  });

  test('bidText: only unsupported (docx) → none without download', async () => {
    const { r, f, id } = await withBid([{ name: '공고문.docx', url: 'https://doc.test/a.docx' }], () => new Response('x'));
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'none', text: '' });
    assert.equal(f.calls.length, 0);
  });

  test('bidText: fetch throws → failed', async () => {
    const { r, id } = await withBid([{ name: 'a.txt', url: 'https://doc.test/a.txt' }], () => {
      throw new TypeError('fetch failed');
    });
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'failed', text: '' });
  });

  test('bidText: over 10 MB is skipped', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 10, 0x61);
    const { r, f, id } = await withBid(
      [
        { name: 'big.txt', url: 'https://doc.test/big.txt' },
        { name: 'small.txt', url: 'https://doc.test/small.txt' },
      ],
      (url) => new Response(url.endsWith('big.txt') ? big : '작은 파일'),
    );
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'ok', text: '작은 파일' });
    assert.equal(f.calls.length, 2);

    const only = await withBid([{ name: 'big.txt', url: 'https://doc.test/big.txt' }], () => new Response(big));
    assert.deepEqual(await only.r.ctx.bidText.get(only.id), { status: 'none', text: '' });
  });

  test('bidText: text is cut at 40000 chars and at most 5 attachments are read', async () => {
    const atts = [1, 2, 3, 4, 5, 6].map((i) => ({ name: `p${i}.txt`, url: `https://doc.test/p${i}.txt` }));
    const { r, f, id } = await withBid(atts, () => new Response('가'.repeat(9000)));
    const out = await r.ctx.bidText.get(id);
    assert.equal(out.status, 'ok');
    assert.equal(out.text.length, 40000);
    assert.equal(f.calls.length, 5);
  });

  test('bidText: 7 MB file (between old 5 MB and new 10 MB cap) is read', async () => {
    const mid = Buffer.alloc(7 * 1024 * 1024, 0x61);
    const { r, id } = await withBid([{ name: 'mid.txt', url: 'https://doc.test/mid.txt' }], () => new Response(mid));
    const out = await r.ctx.bidText.get(id);
    assert.equal(out.status, 'ok');
    assert.equal(out.text.length, 40000);
  });

  test('bidText: sample.hwpx → ok, paragraphs and table cells split by tab', async () => {
    const { r, id } = await withBid([{ name: '공고문.hwpx', url: 'https://doc.test/a.hwpx' }], () => new Response(doc('sample.hwpx')));
    const out = await r.ctx.bidText.get(id);
    assert.equal(out.status, 'ok');
    assert.ok(out.text.includes('조경식재공사업 등록업체'), out.text);
    assert.ok(out.text.includes('추정가격\t120,000,000원'), out.text);
    assert.ok(out.text.includes('2. 문의\t계약팀'), out.text);
  });

  test('bidText: sample.hwp (HWP 5) → ok with the sentence listed in fixtures/docs/README.md', async () => {
    const { r, id } = await withBid([{ name: '공고문.hwp', url: 'https://doc.test/a.hwp' }], () => new Response(doc('sample.hwp')));
    const out = await r.ctx.bidText.get(id);
    assert.equal(out.status, 'ok');
    assert.ok(out.text.includes('리포트의 제목'), out.text.slice(0, 200));
    assert.ok(out.text.includes('과목명\t'), out.text.slice(0, 400));
  });

  test('bidText: corrupt hwp + txt → ok(txt); corrupt hwp alone → failed', async () => {
    const both = await withBid(
      [
        { name: '공고문.hwp', url: 'https://doc.test/bad.hwp' },
        { name: '과업.txt', url: 'https://doc.test/a.txt' },
      ],
      (url) => new Response(url.endsWith('.hwp') ? doc('corrupt.hwp') : '과업 내용 텍스트'),
    );
    assert.deepEqual(await both.r.ctx.bidText.get(both.id), { status: 'ok', text: '과업 내용 텍스트' });

    const alone = await withBid([{ name: '공고문.hwp', url: 'https://doc.test/bad.hwp' }], () => new Response(doc('corrupt.hwp')));
    assert.deepEqual(await alone.r.ctx.bidText.get(alone.id), { status: 'failed', text: '' });
  });

  test('bidText: scanned pdf (no text layer) → none', async () => {
    const { r, f, id } = await withBid([{ name: '스캔.pdf', url: 'https://doc.test/scan.pdf' }], () => new Response(makePdf(null), { headers: { 'content-type': 'application/pdf' } }));
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'none', text: '' });
    assert.equal(f.calls.length, 1);
  });

  test('bidText: format detection order extension → content-type → magic bytes', async () => {
    // 확장자가 이기면 content-type 은 보지 않는다
    const byExt = await withBid([{ name: 'a.txt', url: 'https://doc.test/a.txt' }], () => new Response('확장자 우선', { headers: { 'content-type': 'application/pdf' } }));
    assert.deepEqual(await byExt.r.ctx.bidText.get(byExt.id), { status: 'ok', text: '확장자 우선' });

    // 확장자 없음 → content-type
    const byType = await withBid([{ url: 'https://doc.test/download?id=1' }], () => new Response(doc('sample.hwp'), { headers: { 'content-type': 'application/x-hwp' } }));
    const t1 = await byType.r.ctx.bidText.get(byType.id);
    assert.equal(t1.status, 'ok');
    assert.ok(t1.text.includes('리포트의 제목'));

    // 확장자 없음 + 모르는 content-type → 매직바이트 (zip → hwpx, %PDF → pdf)
    const byMagic = await withBid(
      [{ url: 'https://doc.test/download?id=2' }, { url: 'https://doc.test/download?id=3' }],
      (url) => new Response(url.endsWith('2') ? doc('sample.hwpx') : makePdf('Magic PDF'), { headers: { 'content-type': 'application/octet-stream' } }),
    );
    const t2 = await byMagic.r.ctx.bidText.get(byMagic.id);
    assert.equal(t2.status, 'ok');
    assert.ok(t2.text.includes('조경식재공사업 등록업체'), t2.text);
    assert.ok(t2.text.includes('Magic PDF'), t2.text);

    // 셋 다 모르면 건너뛴다
    const unknown = await withBid([{ url: 'https://doc.test/download?id=4' }], () => new Response('그냥 바이트', { headers: { 'content-type': 'application/octet-stream' } }));
    assert.deepEqual(await unknown.r.ctx.bidText.get(unknown.id), { status: 'none', text: '' });
  });

  test('hwpxText / hwpText throw on corrupt bytes', async () => {
    await assert.rejects(() => hwpxText(new Uint8Array(doc('corrupt.hwp'))));
    await assert.rejects(() => hwpText(new Uint8Array(doc('corrupt.hwp'))));
    await assert.rejects(() => hwpxText(new Uint8Array(doc('sample.hwp'))));
  });

  test('bidText: pdf attachment → ok with extracted text', async () => {
    const pdf = makePdf('Hello Bid Radar');
    const { r, id } = await withBid([{ name: '과업지시서.pdf', url: 'https://doc.test/1.pdf' }], () => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }));
    const out = await r.ctx.bidText.get(id);
    assert.equal(out.status, 'ok');
    assert.ok(out.text.includes('Hello Bid Radar'), out.text);
  });

  /** ctx.now() 를 base 로부터 ms 만큼 옮긴다 */
  function moveClock(r, base, ms) {
    r.ctx.now = () => new Date(base.getTime() + ms);
  }
  const HOUR = 60 * 60 * 1000;

  test('bidText: failed is reused within 1 hour, refetched after and becomes ok', async () => {
    let broken = true;
    const { r, f, id } = await withBid([{ name: 'a.txt', url: 'https://doc.test/a.txt' }], () => {
      if (broken) throw new TypeError('fetch failed');
      return new Response('복구된 과업 내용');
    });
    const base = r.ctx.now();
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'failed', text: '' });
    assert.equal(f.calls.length, 1);
    broken = false;
    moveClock(r, base, HOUR - 1000);
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'failed', text: '' });
    assert.equal(f.calls.length, 1);
    moveClock(r, base, HOUR + 1000);
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'ok', text: '복구된 과업 내용' });
    assert.equal(f.calls.length, 2);
    const row = await r.ctx.db.get('SELECT status FROM bid_texts WHERE bid_id = $1', [id]);
    assert.equal(row.status, 'ok');
  });

  test('bidText: none is reused within 24 hours, rechecked after', async () => {
    const { r, f, id } = await withBid([], () => new Response('나중에 붙은 첨부'));
    const base = r.ctx.now();
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'none', text: '' });
    await r.ctx.bids.upsert(bid('900', { attachments: [{ name: 'late.txt', url: 'https://doc.test/late.txt' }] }), 'nara-cnstwk');
    moveClock(r, base, 24 * HOUR - 1000);
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'none', text: '' });
    assert.equal(f.calls.length, 0);
    moveClock(r, base, 24 * HOUR + 1000);
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'ok', text: '나중에 붙은 첨부' });
    assert.equal(f.calls.length, 1);
  });

  test('bidText: ok is reused even after a long time', async () => {
    const { r, f, id } = await withBid([{ name: 'a.txt', url: 'https://doc.test/a.txt' }], () => new Response('과업 내용'));
    const base = r.ctx.now();
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'ok', text: '과업 내용' });
    moveClock(r, base, 30 * 24 * HOUR);
    assert.deepEqual(await r.ctx.bidText.get(id), { status: 'ok', text: '과업 내용' });
    assert.equal(f.calls.length, 1);
  });
});
