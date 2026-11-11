import { test, describe, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../../app/core/registry.mjs';
import { createApp } from '../../app/core/tenant.mjs';
import { createFakePlatform, createTestDb, WS_A } from './helpers/fake-platform.mjs';
import { STATUS_LABELS, statusLabel, isStatus, badgeFor } from '../../app/modules/assign/service.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmpRoots = [];
after(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

function modulesDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'br-assign-'));
  tmpRoots.push(d);
  symlinkSync(path.join(ROOT, 'app', 'modules', 'assign'), path.join(d, 'assign'), 'dir');
  return d;
}

const noNetwork = async () => {
  throw new Error('network is not allowed in unit tests');
};

async function rt(env = {}) {
  return createRuntime({
    dbPath: ':memory:',
    modulesDir: modulesDir(),
    secret: 'x',
    jobToken: 't',
    env,
    fetchImpl: noNetwork,
    fakeNow: '2026-10-29',
  });
}

function req(r, url, { cookie, ...init } = {}) {
  const headers = new Headers(init.headers || {});
  if (cookie) headers.set('cookie', cookie);
  return r.router.fetch(new Request('http://localhost' + url, { redirect: 'manual', ...init, headers }));
}

function post(r, url, obj, cookie) {
  return req(r, url, { method: 'POST', body: new URLSearchParams(obj), cookie });
}

async function setupOwner(r) {
  const res = await post(r, '/setup', { company: '테스트 조경', name: '대표' });
  assert.equal(res.status, 303);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function cookieFor(r, inviteToken) {
  const res = await req(r, `/join/${inviteToken}`);
  assert.equal(res.status, 303);
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

const BID = '20261029001-000';

function seedBid(r, no = '20261029001', title = '공원 조경 공사') {
  return r.ctx.bids.upsert({ bidNtceNo: no, bidNtceOrd: '000', bidNtceNm: title, dminsttNm: '어느 구청', bidClseDt: '2026-11-07 10:00:00' }, 'nara-cnstwk');
}

function rows(r) {
  return r.ctx.db.all('SELECT * FROM assign_items ORDER BY bid_id');
}

describe('assign service', () => {
  test('status labels map review/go/pass to Korean', () => {
    assert.deepEqual(STATUS_LABELS, { review: '검토중', go: '참여', pass: '패스' });
    assert.equal(statusLabel('review'), '검토중');
    assert.equal(statusLabel('go'), '참여');
    assert.equal(statusLabel('pass'), '패스');
    assert.equal(isStatus('maybe'), false);
    assert.equal(isStatus('go'), true);
  });

  test('badge text with and without assignee', () => {
    assert.deepEqual(badgeFor(BID, { name: '사무담당', status: 'go' }), { label: '담당 사무담당 · 참여', href: `/assign/${BID}` });
    assert.deepEqual(badgeFor(BID, null), { label: '담당자 정하기', href: `/assign/${BID}` });
  });
});

describe('assign module', () => {
  let r;
  let owner;
  beforeEach(async () => {
    r = await rt();
    owner = await setupOwner(r);
  });
  afterEach(async () => {
    await r.close();
  });

  test('manifest is registered with fixed menu values', () => {
    const m = r.modules.find((x) => x.id === 'assign');
    assert.equal(m.title, '업무 분배');
    assert.equal(m.group, '매일');
    assert.equal(m.order, 12);
    assert.equal(m.path, '/assign');
    assert.equal(m.help, '공고를 담당자에게 넘기고 검토중 · 참여 · 패스를 함께 봅니다.');
  });

  test('login is required', async () => {
    for (const url of ['/assign', `/assign/${BID}`, '/assign/members']) {
      const res = await req(r, url);
      assert.equal(res.status, 302, url);
      assert.equal(res.headers.get('location'), '/welcome');
    }
    const res = await post(r, '/assign/members', { name: '사무담당' });
    assert.equal(res.status, 302);
    assert.equal(await r.ctx.members.count(), 1);
  });

  test('empty board shows the empty state', async () => {
    const res = await req(r, '/assign', { cookie: owner });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /담당자를 정한 공고가 없습니다\./);
    assert.match(html, /href="\/today"[^>]*>오늘의 공고에서 고르기/);
  });

  test('three statuses are saved and grouped under Korean headings', async () => {
    const { member: staff } = await r.ctx.members.create({ name: '사무담당', role: 'staff' });
    const bids = [
      ['20261029001', '공원 조경 공사', 'review'],
      ['20261029002', '가로수 정비 공사', 'go'],
      ['20261029003', '하천 제초 공사', 'pass'],
    ];
    for (const [no, title, status] of bids) {
      await seedBid(r, no, title);
      const res = await post(r, `/assign/${no}-000`, { assignee: String(staff.id), status, note: '' }, owner);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/assign');
    }
    assert.deepEqual((await rows(r)).map((x) => x.status), ['review', 'go', 'pass']);
    const html = await (await req(r, '/assign', { cookie: owner })).text();
    const iReview = html.indexOf('>검토중<');
    const iGo = html.indexOf('>참여<');
    const iPass = html.indexOf('>패스<');
    assert.ok(iReview > 0 && iGo > iReview && iPass > iGo, 'headings in order');
    const t1 = html.indexOf('공원 조경 공사');
    const t2 = html.indexOf('가로수 정비 공사');
    const t3 = html.indexOf('하천 제초 공사');
    assert.ok(t1 > iReview && t1 < iGo);
    assert.ok(t2 > iGo && t2 < iPass);
    assert.ok(t3 > iPass);
    assert.match(html, /담당 사무담당/);
    assert.match(html, /2026-10-29 12:00/);
  });

  test('invalid status is 400 and nothing is saved', async () => {
    await seedBid(r);
    const res = await post(r, `/assign/${BID}`, { assignee: '1', status: 'maybe' }, owner);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /상태는 검토중 \/ 참여 \/ 패스 중 하나입니다\./);
    assert.equal((await rows(r)).length, 0);
  });

  test('unknown assignee is 400 and nothing is saved', async () => {
    await seedBid(r);
    const res = await post(r, `/assign/${BID}`, { assignee: '99', status: 'go' }, owner);
    assert.equal(res.status, 400);
    assert.equal((await rows(r)).length, 0);
  });

  test('unknown bid is 404 in Korean', async () => {
    const g = await req(r, '/assign/nope-000', { cookie: owner });
    assert.equal(g.status, 404);
    assert.match(await g.text(), /공고를 찾지 못했습니다/);
    const p = await post(r, '/assign/nope-000', { assignee: '1', status: 'go' }, owner);
    assert.equal(p.status, 404);
    assert.equal((await rows(r)).length, 0);
  });

  test('assignment form lists members with one primary save button', async () => {
    await seedBid(r);
    await r.ctx.members.create({ name: '사무담당', role: 'staff' });
    const res = await req(r, `/assign/${BID}`, { cookie: owner });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /공원 조경 공사/);
    assert.match(html, /<option value="1"[^>]*>대표/);
    assert.match(html, /<option value="2"[^>]*>사무담당/);
    assert.match(html, /<option value="review"[^>]*>검토중/);
    assert.equal((html.match(/<button type="submit">/g) || []).length, 1);
    assert.match(html, /<button type="submit">저장<\/button>/);
  });

  test('reassigning the same bid upserts one row and records updated_by', async () => {
    await seedBid(r);
    const { member: staff, inviteToken } = await r.ctx.members.create({ name: '사무담당', role: 'staff' });
    const staffCookie = await cookieFor(r, inviteToken);
    await post(r, `/assign/${BID}`, { assignee: '1', status: 'review', note: '먼저 봄' }, owner);
    let all = (await rows(r));
    assert.equal(all.length, 1);
    assert.equal(all[0].updated_by, 1);
    const res = await post(r, `/assign/${BID}`, { assignee: String(staff.id), status: 'go', note: '참여 결정' }, staffCookie);
    assert.equal(res.status, 303);
    all = (await rows(r));
    assert.equal(all.length, 1);
    assert.equal(all[0].assignee_id, staff.id);
    assert.equal(all[0].status, 'go');
    assert.equal(all[0].note, '참여 결정');
    assert.equal(all[0].updated_by, staff.id);
  });

  test('decorate badge with and without assignee', async () => {
    await seedBid(r);
    const hook = r.hooks.decorate.find((d) => d.id === 'assign');
    assert.ok(hook);
    const me = await r.ctx.members.get(1);
    assert.deepEqual(await hook.fn(r.ctx, BID, me), { label: '담당자 정하기', href: `/assign/${BID}` });
    const { member: staff } = await r.ctx.members.create({ name: '사무담당', role: 'staff' });
    await post(r, `/assign/${BID}`, { assignee: String(staff.id), status: 'review' }, owner);
    assert.deepEqual(await hook.fn(r.ctx, BID, me), { label: '담당 사무담당 · 검토중', href: `/assign/${BID}` });
  });

  test('members route is not matched as a bid id', async () => {
    const res = await req(r, '/assign/members', { cookie: owner });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /초대 링크 만들기/);
    assert.doesNotMatch(html, /공고를 찾지 못했습니다/);
    const p = await post(r, '/assign/members', { name: '사무담당' }, owner);
    assert.equal(p.status, 200);
    assert.equal((await rows(r)).length, 0);
  });

  test('owner invite shows the link once, second visit has no link', async () => {
    const res = await post(r, '/assign/members', { name: '사무담당', role: 'owner' }, owner);
    assert.equal(res.status, 200);
    const html = await res.text();
    const m = /http:\/\/localhost\/join\/([A-Za-z0-9_-]+)/.exec(html);
    assert.ok(m, 'link shown');
    assert.match(html, /이 링크는 지금만 보입니다\. 복사해서 전해 주세요\./);
    const created = (await r.ctx.members.list()).find((x) => x.name === '사무담당');
    assert.equal(created.role, 'staff');
    // 링크로 실제 로그인된다
    const join = await req(r, `/join/${m[1]}`);
    assert.equal(join.status, 303);
    // 두 번째 화면에는 링크가 없다
    const again = await (await req(r, '/assign/members', { cookie: owner })).text();
    assert.doesNotMatch(again, /\/join\//);
    assert.ok(!again.includes(m[1]));
    assert.match(again, /사무담당/);
    // DB 에 원문이 남지 않는다
    const dump = JSON.stringify(await r.ctx.db.all('SELECT * FROM members'));
    assert.ok(!dump.includes(m[1]));
  });

  test('invite link uses APP_BASE_URL when set', async () => {
    const r2 = await rt({ APP_BASE_URL: 'https://radar.example.com/' });
    try {
      const c = await setupOwner(r2);
      const html = await (await post(r2, '/assign/members', { name: '사무담당' }, c)).text();
      assert.match(html, /https:\/\/radar\.example\.com\/join\/[A-Za-z0-9_-]+/);
    } finally {
      await r2.close();
    }
  });

  test('staff cannot invite: 403 with message and no form', async () => {
    const { inviteToken } = await r.ctx.members.create({ name: '사무담당', role: 'staff' });
    const staff = await cookieFor(r, inviteToken);
    const res = await post(r, '/assign/members', { name: '현장담당' }, staff);
    assert.equal(res.status, 403);
    assert.match(await res.text(), /구성원 초대는 대표만 할 수 있습니다\./);
    assert.equal(await r.ctx.members.count(), 2);
    const page = await (await req(r, '/assign/members', { cookie: staff })).text();
    assert.doesNotMatch(page, /action="\/assign\/members"/);
  });

  test('sixth member is refused with the limit message', async () => {
    for (const n of ['사무담당', '현장담당', '견적담당', '회계담당']) {
      const res = await post(r, '/assign/members', { name: n }, owner);
      assert.equal(res.status, 200);
    }
    assert.equal(await r.ctx.members.count(), 5);
    const res = await post(r, '/assign/members', { name: '추가담당' }, owner);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /구성원은 5명까지 둘 수 있습니다\./);
    assert.doesNotMatch(html, /\/join\//);
    assert.equal(await r.ctx.members.count(), 5);
  });

  test('plan limit on invite is 400 with the plan message and no link', async () => {
    const msg = '구성원은(는) 무료 체험 요금제에서 3개까지입니다. 요금제를 올리면 더 쓸 수 있습니다.';
    r.ctx.members.create = async () => {
      throw Object.assign(new Error(msg), { code: 'PLAN_LIMIT' });
    };
    const res = await post(r, '/assign/members', { name: '추가담당' }, owner);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /class="error"/);
    assert.match(html, /무료 체험 요금제에서 3개까지/);
    assert.doesNotMatch(html, /\/join\//);
  });

  test('empty name is an error box and nothing is created', async () => {
    const res = await post(r, '/assign/members', { name: '   ' }, owner);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /class="error"/);
    assert.match(html, /이름을 적지 않았습니다\./);
    assert.equal(await r.ctx.members.count(), 1);
  });

  test('owner removes a staff member: gone from the list and their bid is unassigned', async () => {
    await seedBid(r);
    const { member: staff } = await r.ctx.members.create({ name: '사무담당', role: 'staff' });
    await post(r, `/assign/${BID}`, { assignee: String(staff.id), status: 'review' }, owner);
    const page = await (await req(r, '/assign/members', { cookie: owner })).text();
    assert.match(page, new RegExp(`action="/assign/members/${staff.id}/remove"`));
    assert.doesNotMatch(page, /action="\/assign\/members\/1\/remove"/, 'no remove button for self');
    assert.match(page, />내보내기</);
    const res = await post(r, `/assign/members/${staff.id}/remove`, {}, owner);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /사무담당 님을 내보냈습니다\./);
    assert.deepEqual((await r.ctx.members.list()).map((m) => m.name), ['대표']);
    assert.equal((await rows(r))[0].assignee_id, null);
    const board = await (await req(r, '/assign', { cookie: owner })).text();
    assert.match(board, /담당 미정/);
  });

  test('staff cannot remove: 403 with message and nothing changes', async () => {
    const { member: other } = await r.ctx.members.create({ name: '현장담당', role: 'staff' });
    const { inviteToken } = await r.ctx.members.create({ name: '사무담당', role: 'staff' });
    const staff = await cookieFor(r, inviteToken);
    const page = await (await req(r, '/assign/members', { cookie: staff })).text();
    assert.doesNotMatch(page, /\/remove"/);
    const res = await post(r, `/assign/members/${other.id}/remove`, {}, staff);
    assert.equal(res.status, 403);
    assert.match(await res.text(), /구성원 내보내기는 대표만 할 수 있습니다\./);
    assert.equal(await r.ctx.members.count(), 3);
  });

  test('owner cannot remove self: 400 and nothing changes', async () => {
    const res = await post(r, '/assign/members/1/remove', {}, owner);
    assert.equal(res.status, 400);
    assert.match(await res.text(), /class="error"/);
    assert.equal(await r.ctx.members.count(), 1);
  });
});

describe('assign module (signup mode)', () => {
  const BASE = 'http://localhost';
  const seed = {
    memberships: [
      { userId: 'user-a', workspaceId: WS_A, role: 'owner', memberId: 1, memberName: '김대표' },
      { userId: 'user-s', workspaceId: WS_A, role: 'staff', memberId: 2, memberName: '최직원' },
    ],
  };
  let app;
  let db;
  let platform;
  beforeEach(async () => {
    platform = createFakePlatform(seed);
    db = await createTestDb();
    await platform.useDb(db);
    app = await createApp({
      env: { APP_SECRET: 's', APP_JOB_TOKEN: 'jt', APP_BASE_URL: BASE, APP_SHARED_KEYS: '0' },
      platform,
      db,
      fetchImpl: noNetwork,
      modulesDir: modulesDir(),
    });
  });
  afterEach(async () => {
    await app.close();
    await db.close();
  });

  function call(url, { user, method = 'GET', form } = {}) {
    const headers = new Headers({ cookie: `fake-user=${user}`, origin: BASE });
    const init = { method, headers, redirect: 'manual' };
    if (form) init.body = new URLSearchParams(form);
    return app.fetch(new Request(BASE + url, init));
  }

  test('board shows the assignee name from memberships, then 미정 after removal', async () => {
    const rt = await app.runtimeFor(WS_A);
    await db.withWorkspace(WS_A, () =>
      rt.ctx.db.run("INSERT INTO assign_items (bid_id, assignee_id, status, updated_at, updated_by) VALUES ($1, 2, 'review', $2, 1)", [
        BID,
        '2026-10-29T01:00:00.000Z',
      ]),
    );
    const board = await (await call('/assign', { user: 'user-a' })).text();
    assert.match(board, /담당 최직원/);
    assert.match(board, /\(김대표\)/);
    const hook = rt.hooks.decorate.find((d) => d.id === 'assign');
    const badge = await db.withWorkspace(WS_A, () => hook.fn(rt.ctx, BID, { id: 1, name: '김대표', role: 'owner' }));
    assert.equal(badge.label, '담당 최직원 · 검토중');
    const res = await call('/assign/members/2/remove', { user: 'user-a', method: 'POST', form: {} });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /최직원 님을 내보냈습니다\./);
    assert.deepEqual(platform.calls.removeMember.at(-1), { client: { kind: 'user', userId: 'user-a' }, workspaceId: WS_A, memberId: 2 });
    assert.match(await (await call('/assign', { user: 'user-a' })).text(), /담당 미정/);
  });
});
