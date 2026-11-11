import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { judge, normalizeName, requirementsSchema, createService } from '../../app/modules/company/service.mjs';
import { notifyLine } from '../../app/modules/company/view.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'tests/fixtures/nara-bids.json'), 'utf8'));
const ENV = {
  NARA_API_KEY: 'dummy-key',
  NARA_API_BASE: 'http://nara.test/svc',
  LLM_API_BASE: 'http://llm.test/v1',
  LLM_API_KEY: 'sk-test',
  LLM_MODEL: 'm-test',
};
const TEXT_OK = '입찰참가자격: 조경식재공사업 등록업체. 그 밖에 별도 조건 없음.';

const tmpRoots = [];
const runtimes = [];
after(async () => {
  for (const r of runtimes) await r.close();
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** company 모듈 하나만 든 임시 modules 디렉토리 */
function companyOnly() {
  const d = mkdtempSync(path.join(tmpdir(), 'br-company-'));
  tmpRoots.push(d);
  symlinkSync(path.join(ROOT, 'app/modules/company'), path.join(d, 'company'), 'dir');
  return d;
}

/**
 * 외부 호출 스텁: 첨부(files.test) · 답변(llm.test, bidId 별) · 나라장터 목록
 * @param {{ texts?: Record<string,string>, answers?: Record<string, object|((bidId:string)=>Response)>, nara?: object }} opts
 */
function stub({ texts = {}, answers = {}, nara = FIXTURE } = {}) {
  const calls = { llm: [], files: [], nara: 0 };
  const fn = async (url, init) => {
    const u = String(url);
    if (u.startsWith('http://llm.test/')) {
      const body = JSON.parse(init.body);
      const input = JSON.parse(body.messages[1].content);
      calls.llm.push(input.bidId);
      const a = answers[input.bidId];
      if (typeof a === 'function') return a(input.bidId);
      if (!a) return new Response('no', { status: 500 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(a) } }] });
    }
    if (u.startsWith('http://files.test/')) {
      const id = u.slice('http://files.test/'.length).replace(/\.txt$/, '');
      calls.files.push(id);
      if (!(id in texts)) return new Response('nf', { status: 404 });
      return new Response(texts[id], { headers: { 'content-type': 'text/plain' } });
    }
    calls.nara += 1;
    return Response.json(nara);
  };
  fn.calls = calls;
  return fn;
}

async function rt(fetchImpl = stub()) {
  const r = await createRuntime({
    dbPath: ':memory:',
    modulesDir: companyOnly(),
    secret: 'x',
    jobToken: 't',
    env: ENV,
    fetchImpl,
    fakeNow: '2026-10-29',
  });
  runtimes.push(r);
  return r;
}

const mod = (r) => r.modules.find((m) => m.id === 'company');

function req(r, url, init = {}) {
  return r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
}

function form(obj) {
  return { method: 'POST', body: new URLSearchParams(obj) };
}

async function login(r) {
  const res = await req(r, '/setup', form({ company: '테스트 조경', name: '대표' }));
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function saveProfileRow(r, { licenses = [], regions = [], name = '테스트 조경', smallBusiness = false } = {}) {
  await r.ctx.db.run(
    `INSERT INTO company_profile (name, licenses, regions, small_business) VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id) DO UPDATE SET name = excluded.name, licenses = excluded.licenses, regions = excluded.regions, small_business = excluded.small_business`,
    [name, JSON.stringify(licenses), JSON.stringify(regions), smallBusiness ? 1 : 0],
  );
}

/** 공고 저장 → MatchedBid 반환 */
async function addBid(r, no, { regionLimit = null, attach = true, lcnsLmtList, prtcptPsblRgnList } = {}) {
  const raw = {
    bidNtceNo: no,
    bidNtceOrd: '000',
    bidNtceNm: `공고 ${no}`,
    dminsttNm: '경기도 수원시',
    bidClseDt: '2026-11-07 10:00:00',
    asignBdgtAmt: '100000000',
    bidNtceDtlUrl: `https://example.test/${no}`,
    attachments: attach ? [{ name: `${no}.txt`, url: `http://files.test/${no}-000.txt` }] : [],
    prtcptLmtRgnNm: regionLimit ?? '',
  };
  if (lcnsLmtList) raw.lcnsLmtList = lcnsLmtList;
  if (prtcptPsblRgnList) raw.prtcptPsblRgnList = prtcptPsblRgnList;
  await r.ctx.bids.upsert(raw, 'nara-cnstwk');
  return { bidId: `${no}-000`, title: raw.bidNtceNm, org: raw.dminsttNm, deadline: raw.bidClseDt, budget: 100000000, url: raw.bidNtceDtlUrl, reasons: ['조경'] };
}

const answer = (licenses, quotes, extra = {}) => ({
  licenses,
  regionLimit: null,
  other: [],
  evidence: quotes.map((q) => ({ field: 'licenses', quote: q })),
  ...extra,
});

const verdictOf = (r, bidId) => r.ctx.db.get('SELECT verdict, reasons FROM company_verdicts WHERE bid_id = $1', [bidId]);
const reasonsOf = async (r, bidId) => JSON.parse((await verdictOf(r, bidId)).reasons);

describe('company: verdict rules', () => {
  test('all licenses present → 참가 가능 with quote', async () => {
    const f = stub({ texts: { '1-000': TEXT_OK }, answers: { '1-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업', '조경시설물설치공사업'], regions: ['경기'] });
    const b = await addBid(r, '1');
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal((await verdictOf(r, '1-000')).verdict, 'ok');
    assert.ok((await reasonsOf(r, '1-000'))[0].includes('조경식재공사업 등록업체'));
    assert.deepEqual(f.calls.llm, ['1-000']);
  });

  test('missing license → 확인 필요 naming the license', async () => {
    const text = '참가자격: 전기공사업 등록업체';
    const f = stub({ texts: { '2-000': text }, answers: { '2-000': answer(['전기공사업'], ['전기공사업 등록업체']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '2');
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal((await verdictOf(r, '2-000')).verdict, 'check');
    assert.ok((await reasonsOf(r, '2-000')).includes("필요 면허 '전기공사업' 가 회사 정보에 없음"));
  });

  test('structured region mismatch → 불가 without calling out', async () => {
    const f = stub({ texts: { '3-000': TEXT_OK }, answers: { '3-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '3', { regionLimit: '부산광역시' });
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal((await verdictOf(r, '3-000')).verdict, 'no');
    const reasons = (await reasonsOf(r, '3-000'));
    assert.ok(reasons[0].startsWith("참가 지역 제한 '부산광역시'"));
    assert.ok(reasons.some((x) => x.includes('경기')));
    assert.equal(f.calls.llm.length, 0);
  });

  test('structured region that contains our region is not 불가', async () => {
    const f = stub({ texts: { '4-000': TEXT_OK }, answers: { '4-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '4', { regionLimit: '경기도' });
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal((await verdictOf(r, '4-000')).verdict, 'ok');
  });

  test('unverified quote → 확인 필요', async () => {
    const f = stub({ texts: { '5-000': TEXT_OK }, answers: { '5-000': answer(['조경식재공사업'], ['원문에 없는 문장']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '5');
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal((await verdictOf(r, '5-000')).verdict, 'check');
    assert.deepEqual((await reasonsOf(r, '5-000')), ['공고문에서 자격 요건을 확인하지 못했습니다', '기준: 공고문 해석']);
  });

  test('no bid text → 확인 필요 without calling out', async () => {
    const f = stub();
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '6', { attach: false });
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal((await verdictOf(r, '6-000')).verdict, 'check');
    assert.equal(f.calls.llm.length, 0);
  });

  test('region limit found only in text → 확인 필요, never 불가', async () => {
    const text = TEXT_OK + ' 참가지역: 부산광역시 소재 업체';
    const a = answer(['조경식재공사업'], ['조경식재공사업 등록업체'], {
      regionLimit: '부산광역시',
      evidence: [
        { field: 'licenses', quote: '조경식재공사업 등록업체' },
        { field: 'regionLimit', quote: '부산광역시 소재 업체' },
      ],
    });
    const f = stub({ texts: { '7-000': text }, answers: { '7-000': a } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '7');
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal((await verdictOf(r, '7-000')).verdict, 'check');
    assert.ok((await reasonsOf(r, '7-000')).some((x) => x.includes('부산광역시')));
  });
});

describe('company: pure helpers', () => {
  test('license names: whitespace and full-width are normalized, substring either way', () => {
    assert.equal(normalizeName(' 조경 식재　공사업 '), '조경식재공사업');
    assert.equal(normalizeName('ＡＢＣ 공사'), 'abc공사');
    const result = { ok: true, verified: true, data: answer(['조경식재 공사업', 'abc공사업'], ['조경식재 공사업 등록', 'ABC공사업 등록']) };
    const v = judge({ profile: { licenses: ['조경식재공사업', 'ＡＢＣ공사업'], regions: [] }, textStatus: 'ok', result });
    assert.equal(v.verdict, 'ok');
  });

  test('completion not ok → 확인 필요', () => {
    const v = judge({ profile: { licenses: ['a'], regions: ['경기'] }, textStatus: 'ok', result: { ok: false, error: 'NO_KEY' } });
    assert.deepEqual(v, { verdict: 'check', reasons: ['공고문에서 자격 요건을 확인하지 못했습니다', '기준: 공고문 해석'], basis: 'text' });
  });

  test('schema rejects bad shapes', () => {
    assert.deepEqual(requirementsSchema(answer(['a'], ['q'])), []);
    assert.ok(requirementsSchema({ licenses: 'a', evidence: [] }).length > 0);
    assert.ok(requirementsSchema({ licenses: [], regionLimit: null, other: [], evidence: [{ field: 'x', quote: 'q' }] }).length > 0);
  });
});

const L = (name, code) => ({ name, code });
const P = (licenses, regions = ['경기'], smallBusiness = false) => ({ licenses, regions, smallBusiness });
const NO_LIMITS = { regions: [], regionRaw: null, licenses: [], sme: null };

describe('company: structured limits (S6)', () => {
  test('시군구 단위 지역 제한은 시도가 같아도 확인 필요', () => {
    const lim = { ...NO_LIMITS, regions: ['경기'], regionRaw: '경기도 수원시', licenses: [L('조경식재공사업', '4993')] };
    const v = judge({ profile: P(['조경식재공사업/4993']), limits: lim });
    assert.equal(v.verdict, 'check');
    assert.ok(v.reasons.includes('참가 가능 지역이 시군구 단위로 제한됨: 경기도 수원시'), v.reasons.join(' / '));
    const whole = judge({ profile: P(['조경식재공사업/4993']), limits: { ...lim, regionRaw: '경기도' } });
    assert.equal(whole.verdict, 'ok');
  });

  test('partial name is not the same license → 확인 필요 (both directions)', () => {
    const a = judge({ profile: P(['조경식재공사업']), limits: { ...NO_LIMITS, licenses: [L('조경식재·시설물공사업', null)] } });
    assert.equal(a.verdict, 'check');
    assert.equal(a.basis, 'structured');
    assert.ok(a.reasons.includes("필요 면허 '조경식재·시설물공사업' 가 회사 정보에 없음"));
    const b = judge({ profile: P(['조경식재·시설물공사업']), limits: { ...NO_LIMITS, licenses: [L('조경식재공사업', '4993')] } });
    assert.equal(b.verdict, 'check');
  });

  test('structured license held → 참가 가능, basis structured, last line 기준', () => {
    const v = judge({ profile: P(['조경식재공사업', '조경시설물설치공사업']), limits: { ...NO_LIMITS, licenses: [L('조경식재공사업', '4993'), L('조경시설물설치공사업', '4994')] } });
    assert.equal(v.verdict, 'ok');
    assert.equal(v.basis, 'structured');
    assert.deepEqual(v.reasons, ["필요 면허 '조경식재공사업' 보유 (공고 면허제한)", "필요 면허 '조경시설물설치공사업' 보유 (공고 면허제한)", '기준: 공고 면허제한']);
  });

  test('normalized equality (spaces, middle dots, full-width) and code equality count', () => {
    const lim = { ...NO_LIMITS, licenses: [L('조경식재·시설물공사업', '4995')] };
    assert.equal(judge({ profile: P(['조경식재 ㆍ 시설물공사업']), limits: lim }).verdict, 'ok');
    assert.equal(judge({ profile: P(['4995']), limits: lim }).verdict, 'ok');
    assert.equal(judge({ profile: P(['아무이름/4995']), limits: lim }).verdict, 'ok');
    assert.equal(judge({ profile: P(['4994']), limits: lim }).verdict, 'check');
  });

  test('one of several structured licenses missing → 확인 필요 naming it', () => {
    const v = judge({ profile: P(['조경식재공사업']), limits: { ...NO_LIMITS, licenses: [L('조경식재공사업', '4993'), L('토목공사업', '0001')] } });
    assert.equal(v.verdict, 'check');
    assert.ok(v.reasons.includes("필요 면허 '토목공사업' 가 회사 정보에 없음"));
    assert.equal(v.reasons.at(-1), '기준: 공고 면허제한');
  });

  test('SME: sme=true and not a small business → 불가; small business or sme=null → not 불가', () => {
    const lim = { ...NO_LIMITS, licenses: [L('조경식재공사업', '4993')], sme: true };
    const no = judge({ profile: P(['조경식재공사업'], ['경기'], false), limits: lim });
    assert.equal(no.verdict, 'no');
    assert.equal(no.basis, 'structured');
    assert.equal(no.reasons[0], '중소기업만 참가할 수 있는 공고');
    assert.equal(judge({ profile: P(['조경식재공사업'], ['경기'], true), limits: lim }).verdict, 'ok');
    const nul = judge({ profile: P(['조경식재공사업'], ['경기'], false), limits: { ...lim, sme: null } });
    assert.equal(nul.verdict, 'ok');
    assert.ok(!nul.reasons.includes('중소기업만 참가할 수 있는 공고'));
  });

  test('region uses standard keys: 경상남도 vs 경남 matches, 부산 vs 경기 → 불가', () => {
    const lim = (raw, regions) => ({ ...NO_LIMITS, regionRaw: raw, regions, licenses: [L('조경식재공사업', '4993')] });
    assert.equal(judge({ profile: P(['조경식재공사업'], ['경남']), limits: lim('경상남도', ['경남']) }).verdict, 'ok');
    assert.equal(judge({ profile: P(['조경식재공사업'], ['경기도 수원시']), limits: lim('경기도 수원시, 서울특별시', ['경기', '서울']) }).verdict, 'ok');
    const no = judge({ profile: P(['조경식재공사업'], ['경기', '서울']), limits: lim('부산광역시', ['부산']) });
    assert.equal(no.verdict, 'no');
    assert.equal(no.basis, 'structured');
    assert.equal(no.reasons[0], "참가 지역 제한 '부산광역시' · 회사 소재지 해당 없음");
    const unknown = judge({ profile: P(['조경식재공사업'], []), limits: lim('부산광역시', ['부산']) });
    assert.equal(unknown.verdict, 'check');
  });

  test('no limits at all → text path: basis text', () => {
    const v = judge({ profile: P(['조경식재공사업']), limits: NO_LIMITS, textStatus: 'none' });
    assert.equal(v.verdict, 'check');
    assert.equal(v.basis, 'text');
    assert.equal(v.reasons.at(-1), '기준: 공고문 해석');
  });

  test('stored structured licenses → no text fetch, no completion call; getVerdict returns basis', async () => {
    const f = stub({ texts: { '11-000': TEXT_OK }, answers: { '11-000': answer(['전기공사업'], ['전기공사업 등록업체']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '11', { lcnsLmtList: [{ lcnsLmtNm: '조경식재공사업/4993', lmtGrpNo: '1', lmtSno: '1' }] });
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal(f.calls.llm.length, 0);
    assert.equal(f.calls.files.length, 0);
    assert.equal((await verdictOf(r, '11-000')).verdict, 'ok');
    assert.equal((await reasonsOf(r, '11-000')).at(-1), '기준: 공고 면허제한');
    const v = await createService(r.ctx).getVerdict('11-000');
    assert.equal(v.basis, 'structured');
    assert.deepEqual(v.reasons, ["필요 면허 '조경식재공사업' 보유 (공고 면허제한)"]);
  });

  test('stored partial-name licence → 확인 필요 without calling out', async () => {
    const f = stub({ texts: { '12-000': TEXT_OK }, answers: { '12-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '12', { lcnsLmtList: [{ lcnsLmtNm: '조경식재·시설물공사업/4995' }] });
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal(f.calls.llm.length, 0);
    assert.equal((await verdictOf(r, '12-000')).verdict, 'check');
  });

  test('no structured licences → text fallback calls out once, basis text', async () => {
    const f = stub({ texts: { '13-000': TEXT_OK }, answers: { '13-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '13');
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.deepEqual(f.calls.llm, ['13-000']);
    const v = await createService(r.ctx).getVerdict('13-000');
    assert.equal(v.verdict, 'ok');
    assert.equal(v.basis, 'text');
    assert.ok(!v.reasons.includes('기준: 공고문 해석'));
  });

  test('structured region list (prtcptPsblRgnList) mismatch → 불가 without calling out', async () => {
    const f = stub({ texts: { '14-000': TEXT_OK }, answers: { '14-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '14', { prtcptPsblRgnList: [{ prtcptPsblRgnNm: '부산광역시', lmtSno: '1' }, { prtcptPsblRgnNm: '울산광역시 남구', lmtSno: '2' }] });
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal(f.calls.llm.length, 0);
    assert.equal((await verdictOf(r, '14-000')).verdict, 'no');
    assert.equal((await createService(r.ctx).getVerdict('14-000')).basis, 'structured');
  });

  test('notify line shows the basis when given', () => {
    assert.equal(notifyLine('ok', "필요 면허 '조경식재공사업' 보유 (공고 면허제한)", 'structured'), "자격: 참가 가능 — 필요 면허 '조경식재공사업' 보유 (공고 면허제한) · 공고 면허제한 기준");
    assert.equal(notifyLine('check', '공고문에서 자격 요건을 확인하지 못했습니다', 'text'), '자격: 확인 필요 — 공고문에서 자격 요건을 확인하지 못했습니다 · 공고문 해석 기준');
    assert.equal(notifyLine('check', 'x'), '자격: 확인 필요 — x');
  });
});

describe('company: hooks', () => {
  test('empty profile → decorate null, no calls', async () => {
    const f = stub({ texts: { '1-000': TEXT_OK }, answers: { '1-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) } });
    const r = await rt(f);
    const b = await addBid(r, '1');
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal(f.calls.llm.length + f.calls.files.length, 0);
    assert.equal(await mod(r).decorate(r.ctx, '1-000', null), null);
    assert.deepEqual(await mod(r).notifyLines(r.ctx, '1-000', '2026-10-29'), []);
    await saveProfileRow(r, { licenses: [], regions: ['경기'] });
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: null, candidates: [], dry: false });
    assert.equal(f.calls.llm.length, 0);
    assert.equal(await mod(r).decorate(r.ctx, '1-000', null), null);
  });

  test('dry → no calls, nothing saved', async () => {
    const f = stub({ texts: { '1-000': TEXT_OK }, answers: { '1-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) } });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b = await addBid(r, '1');
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b], maybe: b, candidates: [], dry: true });
    assert.equal(f.calls.llm.length + f.calls.files.length, 0);
    assert.equal(await verdictOf(r, '1-000'), null);
  });

  test('one failing bid does not block the others; maybe is judged too', async () => {
    const f = stub({
      texts: { '1-000': TEXT_OK, '2-000': TEXT_OK },
      answers: { '1-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']), '2-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) },
    });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const b1 = await addBid(r, '1');
    const b2 = await addBid(r, '2');
    const realGet = r.ctx.bidText.get;
    r.ctx.bidText.get = async (id) => {
      if (id === '1-000') throw new Error('boom');
      return realGet(id);
    };
    await mod(r).afterMatch(r.ctx, { date: '2026-10-29', matched: [b1], maybe: b2, candidates: [], dry: false });
    assert.equal(await verdictOf(r, '1-000'), null);
    assert.equal((await verdictOf(r, '2-000')).verdict, 'ok');
    assert.deepEqual(await mod(r).decorate(r.ctx, '2-000', null), { label: '참가 가능', href: '/company#2-000' });
  });

  test('daily job: extras line "자격: <판정> — <첫 근거>" and badge text', async () => {
    const nara = structuredClone(FIXTURE);
    // 픽스처에 같은 공고가 두 번 들어 있다 (중복 수집 사례) → 둘 다 첨부를 붙인다
    for (const item of nara.response.body.items.filter((x) => x.bidNtceNo === '20261029001')) {
      item.ntceSpecDocUrl1 = 'http://files.test/20261029001-000.txt';
      item.ntceSpecFileNm1 = '공고문.txt';
    }
    const f = stub({
      nara,
      texts: { '20261029001-000': '참가자격: 전기공사업 등록업체' },
      answers: { '20261029001-000': answer(['전기공사업'], ['전기공사업 등록업체']) },
    });
    const r = await rt(f);
    await saveProfileRow(r, { licenses: ['조경식재공사업'], regions: ['경기'] });
    const n = await r.ctx.jobs.runDaily({ date: '2026-10-29' });
    const it = n.items.find((x) => x.bidId === '20261029001-000');
    assert.deepEqual(it.extras, ["자격: 확인 필요 — 필요 면허 '전기공사업' 가 회사 정보에 없음 · 공고문 해석 기준"]);
    for (const other of n.items.filter((x) => x.bidId !== '20261029001-000')) {
      assert.deepEqual(other.extras, ['자격: 확인 필요 — 공고문에서 자격 요건을 확인하지 못했습니다 · 공고문 해석 기준']);
    }
    assert.deepEqual(await mod(r).decorate(r.ctx, '20261029001-000', null), { label: '확인 필요', href: '/company#20261029001-000' });
    assert.ok(n.text.includes("   자격: 확인 필요 — 필요 면허 '전기공사업' 가 회사 정보에 없음 · 공고문 해석 기준"));
  });
});

describe('company: screen', () => {
  test('login required', async () => {
    const r = await rt();
    const res = await req(r, '/company');
    assert.equal(res.status, 302);
  });

  test('empty state, then save profile lists licenses and region', async () => {
    const r = await rt();
    const cookie = await login(r);
    let res = await req(r, '/company', { headers: { cookie } });
    let html = await res.text();
    assert.equal(res.status, 200);
    assert.ok(html.includes('회사 정보를 적으면 공고마다 참가 가능 여부를 확인합니다.'));
    assert.ok(html.includes('value="테스트 조경"'));

    res = await req(r, '/company', { ...form({ name: '테스트 조경', licenses: '조경식재공사업, 조경시설물설치공사업', regions: '경기', smallBusiness: '1' }), headers: { cookie } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/company?saved=1');
    res = await req(r, '/company?saved=1', { headers: { cookie } });
    html = await res.text();
    assert.ok(html.includes('조경식재공사업, 조경시설물설치공사업'));
    assert.ok(html.includes('경기'));
    assert.ok(html.includes('공고마다 참가 가능 여부를 자동으로 확인합니다'));
    assert.ok(html.includes('입찰 전 공고 원문을 꼭 확인하세요'));
    assert.ok(!html.includes('회사 정보를 적으면 공고마다 참가 가능 여부를 확인합니다.'));
  });

  test('staff can save too', async () => {
    const r = await rt();
    await login(r);
    const { inviteToken } = await r.ctx.members.create({ name: '직원', role: 'staff' });
    const join = await req(r, `/join/${inviteToken}`);
    const cookie = (join.headers.get('set-cookie') || '').split(';')[0];
    const res = await req(r, '/company', { ...form({ licenses: '조경식재공사업' }), headers: { cookie } });
    assert.equal(res.status, 303);
  });

  test('form validation: no license → one error box with the message, nothing saved', async () => {
    const r = await rt();
    const cookie = await login(r);
    const res = await req(r, '/company', { ...form({ name: '테스트 조경', licenses: ' , ', regions: '경기' }), headers: { cookie } });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.equal((html.match(/class="error"/g) || []).length, 1);
    assert.ok(html.includes('저장하지 않았습니다. 아래 내용을 고친 뒤 다시 저장해 주세요.'));
    assert.ok(html.includes('보유 면허를 하나 이상 적어 주세요.'));
    assert.ok(html.includes('value="경기"'));
    assert.equal((await r.ctx.db.get('SELECT COUNT(*) AS n FROM company_profile')).n, 0);
  });

  test('verdict list shows anchor, badge and reasons for latest matches', async () => {
    const f = stub({ texts: { '1-000': TEXT_OK }, answers: { '1-000': answer(['조경식재공사업'], ['조경식재공사업 등록업체']) } });
    const r = await rt(f);
    const cookie = await login(r);
    const b = await addBid(r, '1');
    await r.ctx.matches.save('2026-10-29', [b], null);
    const res0 = await req(r, '/company', { ...form({ licenses: '조경식재공사업', regions: '경기' }), headers: { cookie } });
    assert.equal(res0.status, 303);
    const html = await (await req(r, '/company', { headers: { cookie } })).text();
    assert.ok(html.includes('id="1-000"'));
    assert.ok(html.includes('참가 가능'));
    assert.ok(html.includes('조경식재공사업 등록업체'));
    assert.ok(html.includes('공고문 해석 기준'));
    assert.ok(!html.includes('기준: 공고문 해석'));
  });

  test('verdict card shows 공고 면허제한 기준 for structured licences', async () => {
    const f = stub();
    const r = await rt(f);
    const cookie = await login(r);
    const b = await addBid(r, '21', { lcnsLmtList: [{ lcnsLmtNm: '조경식재공사업/4993' }] });
    await r.ctx.matches.save('2026-10-29', [b], null);
    await req(r, '/company', { ...form({ licenses: '조경식재공사업', regions: '경기' }), headers: { cookie } });
    const html = await (await req(r, '/company', { headers: { cookie } })).text();
    assert.ok(html.includes('공고 면허제한 기준'));
    assert.ok(html.includes('필요 면허 &#39;조경식재공사업&#39; 보유 (공고 면허제한)'));
    assert.equal(f.calls.llm.length, 0);
  });
});
