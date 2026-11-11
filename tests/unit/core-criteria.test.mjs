import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../app/core/db.mjs';
import { create } from '../../app/core/criteria.mjs';
import { createRuntime } from '../../app/core/registry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT = JSON.parse(readFileSync(path.join(ROOT, 'config/criteria.json'), 'utf8'));
const VALID = { keywords: ['조경'], regions: ['경기'], budgetMin: 0, budgetMax: 100, maxItems: 5 };

function memSettings() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    set: async (k, v) => {
      m.set(k, String(v));
    },
  };
}

async function withKeywordsTable() {
  const db = await openDb({ memory: true });
  await db.applySchema(path.join(ROOT, 'app/modules/keywords/schema.sql'));
  return db;
}

async function addSynonym(db, word, forKeyword, status) {
  await db.run('INSERT INTO keywords_synonyms (word, for_keyword, why, status, created_at) VALUES ($1, $2, $3, $4, $5)', [
    word,
    forKeyword,
    '이유',
    status,
    '2026-11-02T00:00:00.000Z',
  ]);
}

describe('criteria excludeKeywords', () => {
  test('excludeKeywords is optional; config/criteria.json stays valid', async () => {
    const { criteria } = create({ settings: memSettings() });
    assert.deepEqual(criteria.validate(DEFAULT), []);
    assert.deepEqual(await criteria.get(), DEFAULT);
  });

  test('excludeKeywords must be a list of strings', async () => {
    const { criteria } = create({ settings: memSettings() });
    const errors = criteria.validate({ ...VALID, excludeKeywords: '묘지' });
    assert.deepEqual(errors, ['제외 키워드는 목록으로 적어 주세요. 없으면 비워 두세요.']);
    assert.deepEqual(await criteria.set({ ...VALID, excludeKeywords: [1] }), errors);
  });

  test('set trims, drops blanks and duplicates in excludeKeywords', async () => {
    const settings = memSettings();
    const { criteria } = create({ settings });
    assert.deepEqual(await criteria.set({ ...VALID, excludeKeywords: [' 묘지 ', '', '묘지', '납골'] }), []);
    assert.deepEqual((await criteria.get()).excludeKeywords, ['묘지', '납골']);
    assert.deepEqual((await criteria.effective()).excludeKeywords, ['묘지', '납골']);
  });

  test('set without excludeKeywords keeps the stored shape unchanged', async () => {
    const settings = memSettings();
    const { criteria } = create({ settings });
    await criteria.set(VALID);
    assert.deepEqual(JSON.parse(await settings.get('criteria')), VALID);
  });
});

describe('criteria.effective synonyms', () => {
  test('accepted synonyms do not feed main matching: synonyms is {}', async () => {
    const db = await withKeywordsTable();
    await addSynonym(db, '시설물', '공원', 'accepted');
    await addSynonym(db, '수목원', '수목', 'accepted');
    const { criteria } = create({ settings: memSettings(), db });
    const eff = await criteria.effective();
    assert.deepEqual(eff, { ...(await criteria.get()), excludeKeywords: [], synonyms: {} });
    await db.close();
  });

  test('no db gives empty synonyms', async () => {
    assert.deepEqual((await create({ settings: memSettings() }).criteria.effective()).synonyms, {});
  });
});

describe('settings screen excludeKeywords', () => {
  const tmp = [];
  const runtimes = [];
  after(async () => {
    for (const r of runtimes) await r.close();
    for (const d of tmp) rmSync(d, { recursive: true, force: true });
  });

  async function rt() {
    const modulesDir = mkdtempSync(path.join(tmpdir(), 'br-set-'));
    tmp.push(modulesDir);
    symlinkSync(path.join(ROOT, 'app/modules/settings'), path.join(modulesDir, 'settings'), 'dir');
    const r = await createRuntime({
      dbPath: ':memory:',
      modulesDir,
      secret: 'x',
      jobToken: 't',
      env: { NARA_API_KEY: 'dummy-key', NARA_API_BASE: 'http://nara.test/svc' },
      fetchImpl: async () => new Response('{}'),
      fakeNow: '2026-11-02',
    });
    runtimes.push(r);
    return r;
  }
  const req = (r, url, init = {}) => r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init }));
  async function login(r) {
    const res = await req(r, '/setup', { method: 'POST', body: new URLSearchParams({ company: '테스트 조경', name: '대표' }) });
    return (res.headers.get('set-cookie') || '').split(';')[0];
  }

  test('page shows #excludeKeywords textarea and budget basis note', async () => {
    const r = await rt();
    const cookie = await login(r);
    const res = await req(r, '/settings', { headers: { cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<textarea id="excludeKeywords" name="excludeKeywords"/);
    assert.ok(html.includes('제외 키워드'));
    assert.ok(html.includes('예산은 추정가격 기준입니다 (없으면 기초금액, 배정예산 순)'));
  });

  test('saving splits excludeKeywords and shows them again', async () => {
    const r = await rt();
    const cookie = await login(r);
    const body = new URLSearchParams({
      keywords: '조경, 수목',
      regions: '경기',
      excludeKeywords: '묘지\n납골, 묘지',
      budgetMin: '30,000,000',
      budgetMax: '500000000',
      webhookUrl: '',
    });
    const res = await req(r, '/settings', { method: 'POST', headers: { cookie }, body });
    assert.equal(res.status, 303);
    assert.deepEqual((await r.ctx.criteria.get()).excludeKeywords, ['묘지', '납골']);
    assert.deepEqual((await r.ctx.criteria.effective()).excludeKeywords, ['묘지', '납골']);
    const html = await (await req(r, '/settings', { headers: { cookie } })).text();
    assert.match(html, /<textarea id="excludeKeywords"[^>]*>묘지, 납골<\/textarea>/);
  });
});
