import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../../app/core/db.mjs';
import { PLANS, LIMIT_KINDS } from '../../app/core/billing/plans.mjs';
import { createLimits, unlimitedLimits, planLimitMessage, LIMIT_TEXT } from '../../app/core/billing/limits.mjs';
import { createPlatformMembers } from '../../app/core/members-platform.mjs';
import { create as createSources } from '../../app/core/sources.mjs';
import { create as createCriteria } from '../../app/core/criteria.mjs';
import { adapter as rss } from '../../app/modules/sources/adapters/rss.mjs';

const dbs = [];
after(async () => {
  for (const d of dbs) await d.close();
});

const limitsFor = (plan) => createLimits({ getPlan: async () => plan });

describe('billing limits: createLimits', () => {
  for (const plan of Object.keys(PLANS)) {
    for (const kind of LIMIT_KINDS) {
      test(`limits: ${plan}/${kind} allows max, rejects max+1 with PLAN_LIMIT`, async () => {
        const l = limitsFor(plan);
        const max = PLANS[plan].limits[kind];
        assert.deepEqual(await l.check(kind, max), { ok: true, max });
        const r = await l.check(kind, max + 1);
        assert.equal(r.ok, false);
        assert.equal(r.code, 'PLAN_LIMIT');
        assert.equal(r.kind, kind);
        assert.equal(r.max, max);
        assert.equal(r.plan, plan);
        assert.equal(r.message, planLimitMessage(kind, max, plan));
        assert.ok(r.message.includes(`${PLANS[plan].name} 요금제에서 ${max}개까지`), r.message);
        assert.ok(r.message.startsWith(LIMIT_TEXT[kind]));
        assert.equal(await l.max(kind), max);
      });
    }
  }

  test('limits: trial members message is the one the screen shows', async () => {
    const r = await limitsFor('trial').check('members', 4);
    assert.match(r.message, /무료 체험 요금제에서 3개까지/);
  });

  test('limits: summary and unknown plan falls back to trial', async () => {
    assert.deepEqual(await limitsFor('team').summary(), { plan: 'team', limits: PLANS.team.limits });
    assert.deepEqual(await limitsFor('nope').summary(), { plan: 'trial', limits: PLANS.trial.limits });
  });

  test('limits: unlimitedLimits always ok, max Infinity', async () => {
    const u = unlimitedLimits();
    for (const kind of LIMIT_KINDS) {
      assert.deepEqual(await u.check(kind, 10_000), { ok: true, max: Infinity });
      assert.equal(await u.max(kind), Infinity);
    }
  });
});

describe('billing limits: enforcement points', () => {
  function fakeMembersDb(n) {
    const rows = Array.from({ length: n }, (_, i) => ({ member_id: i + 1, member_name: `m${i + 1}`, role: i === 0 ? 'owner' : 'staff', pending: false }));
    return { all: async () => rows, get: async () => ({ next: n + 1 }) };
  }
  const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  test('members: trial with 3 members → PLAN_LIMIT error, no invite', async () => {
    let invited = 0;
    const m = createPlatformMembers({ db: fakeMembersDb(3), workspaceId: WS, platform: {}, onInvite: () => invited++, limits: limitsFor('trial') });
    await assert.rejects(m.create({ name: '새 사람' }), (err) => err.code === 'PLAN_LIMIT' && /무료 체험 요금제에서 3개까지/.test(err.message));
    assert.equal(invited, 0);
  });

  test('members: legacy (no limits) keeps old behavior up to MAX_MEMBERS', async () => {
    let invited = 0;
    const m = createPlatformMembers({ db: fakeMembersDb(3), workspaceId: WS, platform: {}, onInvite: () => invited++ });
    const r = await m.create({ name: '새 사람' });
    assert.equal(r.member.pending, true);
    assert.equal(invited, 1);
    const full = createPlatformMembers({ db: fakeMembersDb(5), workspaceId: WS, platform: {}, onInvite: () => {} });
    await assert.rejects(full.create({ name: 'x' }), (err) => err.code === 'MEMBER_LIMIT');
  });

  test('members: team plan invites the 6th member (plan limit replaces MAX_MEMBERS)', async () => {
    let invited = 0;
    const m = createPlatformMembers({ db: fakeMembersDb(5), workspaceId: WS, platform: {}, onInvite: () => invited++, limits: limitsFor('team') });
    const r = await m.create({ name: '여섯째' });
    assert.equal(r.member.id, 6);
    assert.equal(invited, 1);
    const full = createPlatformMembers({ db: fakeMembersDb(10), workspaceId: WS, platform: {}, onInvite: () => invited++, limits: limitsFor('team') });
    await assert.rejects(full.create({ name: 'x' }), (err) => err.code === 'PLAN_LIMIT');
    assert.equal(invited, 1);
  });

  test('members: trial 4th member → PLAN_LIMIT, no invite', async () => {
    let invited = 0;
    const m = createPlatformMembers({ db: fakeMembersDb(3), workspaceId: WS, platform: {}, onInvite: () => invited++, limits: limitsFor('trial') });
    await assert.rejects(m.create({ name: '넷째' }), (err) => err.code === 'PLAN_LIMIT');
    assert.equal(invited, 0);
  });

  async function sourcesCtx(limits) {
    const db = await openDb({ memory: true });
    dbs.push(db);
    const ctx = { db, now: () => new Date('2026-11-04T00:00:00Z'), env: {}, hooks: { adapters: [rss] }, bids: { upsert: async () => ({}) }, log: () => {} };
    if (limits) ctx.limits = limits;
    return { ...ctx, ...(await createSources(ctx)) };
  }
  const RSS = { type: 'rss', name: '시청 공고', config: { url: 'https://example.com/rss', orgName: '시청' } };

  test('sources: trial (2 seeded) → add rejected with plan message', async () => {
    const { sources } = await sourcesCtx(limitsFor('trial'));
    assert.equal((await sources.list()).length, 2);
    const r = await sources.add(RSS);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /공고 소스은\(는\) 무료 체험 요금제에서 2개까지/);
    assert.equal((await sources.list()).length, 2);
  });

  test('sources: starter allows the 3rd, rejects the 4th; legacy unlimited', async () => {
    const { sources } = await sourcesCtx(limitsFor('starter'));
    assert.equal((await sources.add(RSS)).ok, true);
    const r = await sources.add(RSS);
    assert.equal(r.ok, false);
    assert.match(r.errors[0], /스타터 요금제에서 3개까지/);
    const legacy = (await sourcesCtx(null)).sources;
    for (let i = 0; i < 4; i++) assert.equal((await legacy.add(RSS)).ok, true);
  });

  function criteriaCtx(limits) {
    const store = new Map();
    const ctx = { settings: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) } };
    if (limits) ctx.limits = limits;
    return { ctx, store, ...createCriteria(ctx) };
  }
  const crit = (n) => ({ keywords: Array.from({ length: n }, (_, i) => `키워드${i}`), regions: [], budgetMin: 0, budgetMax: 100, maxItems: 5 });

  test('criteria: trial keywords 10 ok, 11 → plan message, not saved', async () => {
    const { criteria, store } = criteriaCtx(limitsFor('trial'));
    assert.deepEqual(await criteria.set(crit(10)), []);
    const errs = await criteria.set(crit(11));
    assert.equal(errs.length, 1);
    assert.match(errs[0], /키워드은\(는\) 무료 체험 요금제에서 10개까지/);
    assert.equal(JSON.parse(store.get('criteria')).keywords.length, 10);
  });

  test('criteria: duplicates are counted once; legacy unlimited', async () => {
    const { criteria } = criteriaCtx(limitsFor('trial'));
    const c = crit(10);
    c.keywords.push('키워드0', ' 키워드1 ');
    assert.deepEqual(await criteria.set(c), []);
    assert.deepEqual(await criteriaCtx(null).criteria.set(crit(150)), []);
  });
});
