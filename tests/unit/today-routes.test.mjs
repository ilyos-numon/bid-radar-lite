// 오늘의 공고 라우트: 저장된 공고 세부 정보(마감 시각·개찰·예산 기준·종류)와 최근 변경을 카드에 붙인다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHtml } from '../../app/core/html.mjs';
import { registerRoutes } from '../../app/modules/today/routes.mjs';
import { todayActions } from '../../app/modules/today/view.mjs';

function setup({ stored = {}, changes = [], linksFor, logs = [], demo, criteria, credits, jobs } = {}) {
  const routes = {};
  const router = { get: (p, fn) => (routes[`GET ${p}`] = fn), post: (p, fn) => (routes[`POST ${p}`] = fn) };
  const html = createHtml({ menus: () => [] });
  html.layout = ({ body }) => body;
  const since = [];
  const ctx = {
    html,
    hooks: { decorate: [] },
    log: (...a) => logs.push(a),
    now: () => new Date('2026-11-02T00:00:00.000Z'),
    today: () => '2026-11-02',
    auth: { required: (fn) => (req, params, c) => fn(req, params, c, { id: 1 }) },
    criteria: criteria === undefined ? { get: () => ({ keywords: ['조경'], regions: [], budgetMin: null, budgetMax: null }) } : criteria,
    ...(demo ? { demo } : {}),
    ...(credits ? { credits } : {}),
    ...(jobs ? { jobs } : {}),
    matches: {
      latestDate: () => '2026-11-02',
      forDate: () => ({
        matched: [{ bidId: 'A-000', title: '공원 조경 공사', org: '수원시', deadline: '2026-11-07 10:00:00', budget: 100000000, url: '', reasons: ['키워드 \'조경\' 일치'] }],
        maybe: { bidId: 'B-000', title: '가로수 정비', org: '용인시', deadline: '2026-11-08 18:00:00', budget: null, url: '', reasons: [] },
      }),
    },
    bids: {
      get: (id) => stored[id] ?? null,
      changesSince: (iso) => {
        since.push(iso);
        return changes;
      },
      ...(linksFor ? { linksFor } : {}),
    },
  };
  registerRoutes(router, ctx);
  return { routes, since };
}

test('today: 저장된 공고 세부 정보를 카드에 붙이고 최근 7일 변경을 넘긴다', async () => {
  const { routes, since } = setup({
    stored: {
      'A-000': {
        bidId: 'A-000', title: '다른 제목', reasons: undefined, kind: 'changed', openingAt: '2026-11-08 11:00:00',
        budgetBasis: 'estimated', amounts: { estimated: 90000000, base: null, assigned: 99000000, vatIncluded: false }, raw: {},
      },
    },
    changes: [{ bidId: 'A-000', title: '공원 조경 공사', field: 'deadline', old: '2026-11-06 10:00:00', new: '2026-11-07 10:00:00' }],
  });
  const body = await routes['GET /today']({}, {}, {});
  assert.equal(since.length, 1);
  assert.equal(since[0], '2026-10-26T00:00:00.000Z');
  assert.match(body, /공원 조경 공사/, '추천 목록의 제목이 우선');
  assert.doesNotMatch(body, /다른 제목/);
  assert.match(body, /키워드 &#39;조경&#39; 일치|키워드 '조경' 일치/, '추천 사유 유지');
  assert.match(body, /개찰 11\/08\(일\) 11:00/);
  assert.match(body, /추정가격 9,?000만|추정가격 9천만/);
  assert.match(body, /부가세 제외/);
  assert.match(body, /변경/);
  assert.match(body, /마감 변경됨/);
});

test('today: 저장된 세부 정보가 없으면 추천 목록 값만 쓴다', async () => {
  const { routes } = setup();
  const body = await routes['GET /today']({}, {}, {});
  assert.match(body, /공원 조경 공사/);
  assert.match(body, /가로수 정비/);
  assert.doesNotMatch(body, /마감 변경됨/);
});

const FLOWS = {
  'A-000': {
    prestd: { bidId: 'PSR26BD00900005-000', noticeNo: 'R26BD00900005', title: '사전 공원 조경', kind: 'prestd', deadline: '2026-11-06 18:00:00', postedAt: null, url: null, stored: true },
    notices: [],
  },
  'B-000': {
    prestd: null,
    notices: [{ bidId: 'R26BK01900005-000', noticeNo: 'R26BK01900005', title: '', kind: null, deadline: null, postedAt: null, url: null, stored: false }],
  },
};

test('today: flow lines from linksFor on both cards', async () => {
  const asked = [];
  const { routes } = setup({ linksFor: (id) => (asked.push(id), FLOWS[id] ?? { prestd: null, notices: [] }) });
  const res = await routes['GET /today']({}, {}, {});
  assert.deepEqual(asked.sort(), ['A-000', 'B-000']);
  assert.match(res, /<p class="flow">사전규격 있었음 · 의견마감 11\/06\(금\) 18:00<\/p>/);
  assert.match(res, /<p class="flow">본공고 나옴 → 공고번호 R26BK01900005<\/p>/);
});

test('today: no links → no flow line; linksFor missing or throwing still renders', async () => {
  const none = await setup({ linksFor: () => ({ prestd: null, notices: [] }) }).routes['GET /today']({}, {}, {});
  assert.doesNotMatch(none, /class="flow"/);
  const missing = await setup().routes['GET /today']({}, {}, {});
  assert.doesNotMatch(missing, /class="flow"/);
  const logs = [];
  const thrown = await setup({ logs, linksFor: () => { throw new Error('boom'); } }).routes['GET /today']({}, {}, {});
  assert.match(thrown, /공원 조경 공사/);
  assert.doesNotMatch(thrown, /class="flow"/);
  assert.ok(logs.some((a) => a[0] === 'today' && /boom/.test(a.slice(1).join(' '))), 'logged');
});

test('today: each card gets a collapsed 왜 추천됐나 block with N/4 and per-condition state', async () => {
  const body = await setup().routes['GET /today']({}, {}, {});
  const cards = body.split('<li class="card"').slice(1);
  assert.equal(cards.length, 2);
  assert.match(cards[0], /<details class="explain"><summary>왜 추천됐나 · 4\/4 조건 맞음<\/summary><ul>/, 'no region limit counts as met');
  assert.match(cards[0], /<li data-ok="true"><span class="state">맞음<\/span>키워드 &#39;조경&#39; 일치<\/li>/);
  assert.match(cards[0], /<li data-ok="true"><span class="state">맞음<\/span>지역 제한 없음<\/li>/);
  assert.match(cards[0], /예산 범위 안 \(1억\)/);
  assert.match(cards[1], /<summary>왜 추천됐나 · 2\/4 조건 맞음<\/summary>/, 'maybe card: keyword missing, budget unknown');
  assert.match(cards[1], /<li data-ok="false"><span class="state">안 맞음<\/span>키워드 없음 \(조경\)<\/li>/);
  assert.match(cards[1], /<li data-ok="null"><span class="state">정보 없음<\/span>예산 정보 없음<\/li>/);
  const card = cards[0];
  const iTitle = card.indexOf('class="title"');
  const iKinds = card.indexOf('class="kinds"');
  const iReasons = card.indexOf('class="reasons"');
  const iExplain = card.indexOf('class="explain"');
  assert.ok(iTitle > -1 && iTitle < iReasons && iReasons < iExplain, 'title < reasons < explain');
  assert.ok(iKinds === -1 || iKinds < iReasons);
});

test('today: stored limits.regions feed the region check', async () => {
  const body = await setup({
    criteria: { get: () => ({ keywords: ['조경'], regions: ['경기'], budgetMin: 0, budgetMax: 500000000 }) },
    stored: { 'A-000': { bidId: 'A-000', kind: 'new', limits: { regions: ['경기'] } } },
  }).routes['GET /today']({}, {}, {});
  const first = body.split('<li class="card"')[1];
  assert.match(first, /4\/4 조건 맞음/);
  assert.match(first, /지역 &#39;경기&#39; 일치/);
});

test('today: no criteria store → no explain block, page still renders', async () => {
  const body = await setup({ criteria: null }).routes['GET /today']({}, {}, {});
  assert.match(body, /공원 조경 공사/);
  assert.doesNotMatch(body, /class="explain"/);
});

test('today: example chip only for demo workspaces', async () => {
  const plain = await setup().routes['GET /today']({}, {}, {});
  assert.doesNotMatch(plain, /예시 데이터/);
  const demo = await setup({ demo: { enabled: true } }).routes['GET /today']({}, {}, {});
  const cards = demo.split('<li class="card"').slice(1);
  for (const c of cards) assert.match(c, /<h3 class="title"[^>]*>[^<]*<\/h3>\s*<span class="chip example">예시 데이터<\/span>|class="title"[\s\S]*?chip example/);
});

function fakeCredits({ used = 0, max = 5, unlimited = false } = {}) {
  const state = { used, takes: 0 };
  return {
    state,
    async summary() {
      return { used: state.used, max, left: unlimited ? max : Math.max(0, max - state.used), unlimited };
    },
    async take() {
      state.takes += 1;
      if (unlimited) return { ok: true, used: state.used, max, left: max, unlimited };
      if (state.used >= max) return { ok: false, used: max, max, left: 0, unlimited };
      state.used += 1;
      return { ok: true, used: state.used, max, left: max - state.used, unlimited };
    },
  };
}

function fakeJobs() {
  const calls = [];
  return { calls, runDaily: async (arg) => calls.push(arg) };
}

async function actionsOf(opts) {
  return setup(opts).routes;
}

test('today credits: left 2 → count next to the run button', async () => {
  const html = createHtml({ menus: () => [] });
  let actions = '';
  html.layout = (o) => ((actions = o.actions), o.body);
  const routes = {};
  registerRoutes({ get: (p, fn) => (routes[`GET ${p}`] = fn), post: (p, fn) => (routes[`POST ${p}`] = fn) }, {
    html,
    hooks: { decorate: [] },
    log: () => {},
    today: () => '2026-11-02',
    auth: { required: (fn) => (req, params, c) => fn(req, params, c, { id: 1 }) },
    credits: fakeCredits({ used: 3 }),
    matches: { latestDate: () => '2026-11-02', forDate: () => ({ matched: [], maybe: null }) },
  });
  await routes['GET /today']({}, {}, {});
  assert.match(actions, /<span class="chip credits">무료 가져오기 2회 남음<\/span>/);
  assert.match(actions, /<form method="post" action="\/today\/run"/);
  assert.doesNotMatch(actions, /disabled/);
});

test('today credits: todayActions left 0 → disabled button and plans link instead of the form', () => {
  const h = createHtml({ menus: () => [] });
  const s = todayActions(h, { date: '2026-11-02', today: '2026-11-02', count: 0, credits: { used: 5, max: 5, left: 0, unlimited: false } });
  assert.match(s, /<span class="chip credits none">무료 가져오기 5회를 모두 썼습니다<\/span>/);
  assert.match(s, /<button type="button" disabled[^>]*>[\s\S]*오늘 공고 가져오기<\/button>/);
  assert.match(s, /<a class="button secondary" href="\/billing">요금제 보기<\/a>/);
  assert.doesNotMatch(s, /action="\/today\/run"/);
});

test('today credits: null or unlimited → unchanged actions', () => {
  const h = createHtml({ menus: () => [] });
  const base = todayActions(h, { date: '2026-11-02', today: '2026-11-02', count: 1 });
  assert.equal(todayActions(h, { date: '2026-11-02', today: '2026-11-02', count: 1, credits: null }), base);
  assert.equal(todayActions(h, { date: '2026-11-02', today: '2026-11-02', count: 1, credits: { used: 9, max: 5, left: 5, unlimited: true } }), base);
  assert.doesNotMatch(base, /credits|disabled|\/billing/);
});

test('today run: take() ok → runDaily once and redirect', async () => {
  const credits = fakeCredits({ used: 4 });
  const jobs = fakeJobs();
  const routes = await actionsOf({ credits, jobs });
  const res = await routes['POST /today/run']({}, {}, {});
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/today');
  assert.equal(jobs.calls.length, 1);
  assert.equal(credits.state.takes, 1);
  assert.equal(credits.state.used, 5);
});

test('today run: take() refused → 200 screen with message and plans link, runDaily not called', async () => {
  const credits = fakeCredits({ used: 5 });
  const jobs = fakeJobs();
  const routes = await actionsOf({ credits, jobs });
  const body = await routes['POST /today/run']({}, {}, {});
  assert.equal(typeof body, 'string');
  assert.match(body, /무료 가져오기 5회를 모두 썼습니다/);
  assert.match(body, /계속 쓰려면 요금제를 골라 주세요/);
  assert.match(body, /<p><a class="button" href="\/billing">요금제 보기<\/a><\/p>/);
  assert.equal(jobs.calls.length, 0);
});

test('today run: refused screen is a 200 page through the real layout', async () => {
  const credits = fakeCredits({ used: 5 });
  const jobs = fakeJobs();
  const html = createHtml({ menus: () => [] });
  const routes = {};
  registerRoutes({ get: (p, fn) => (routes[`GET ${p}`] = fn), post: (p, fn) => (routes[`POST ${p}`] = fn) }, {
    html,
    hooks: { decorate: [] },
    log: () => {},
    today: () => '2026-11-02',
    auth: { required: (fn) => (req, params, c) => fn(req, params, c, { id: 1 }) },
    credits,
    jobs,
    matches: { latestDate: () => null, forDate: () => ({ matched: [], maybe: null }) },
  });
  const res = await routes['POST /today/run']({}, {}, {});
  assert.equal(res.status, 200);
  assert.match(await res.text(), /href="\/billing"/);
  assert.equal(jobs.calls.length, 0);
});

test('today run: no ctx.credits → runDaily as before, unlimited take() also runs', async () => {
  const jobs = fakeJobs();
  const res = await (await actionsOf({ jobs }))['POST /today/run']({}, {}, {});
  assert.equal(res.status, 303);
  assert.equal(jobs.calls.length, 1);
  const credits = fakeCredits({ used: 99, unlimited: true });
  const jobs2 = fakeJobs();
  const res2 = await (await actionsOf({ credits, jobs: jobs2 }))['POST /today/run']({}, {}, {});
  assert.equal(res2.status, 303);
  assert.equal(jobs2.calls.length, 1);
  assert.equal(credits.state.used, 99);
});

test('today credits: demo workspace (credits null) → no free collect chip on the today screen', async () => {
  const html = createHtml({ menus: () => [] });
  let actions = '';
  html.layout = (o) => ((actions = o.actions), o.body);
  const routes = {};
  registerRoutes({ get: (p, fn) => (routes[`GET ${p}`] = fn), post: (p, fn) => (routes[`POST ${p}`] = fn) }, {
    html,
    hooks: { decorate: [] },
    log: () => {},
    today: () => '2026-11-02',
    auth: { required: (fn) => (req, params, c) => fn(req, params, c, { id: 1 }) },
    demo: { enabled: true },
    credits: null,
    matches: { latestDate: () => '2026-11-02', forDate: () => ({ matched: [], maybe: null }) },
  });
  await routes['GET /today']({}, {}, {});
  assert.doesNotMatch(actions, /chip credits|무료 가져오기/);
});

function refundable(opts) {
  const credits = fakeCredits(opts);
  credits.state.refunds = 0;
  credits.refund = async () => {
    credits.state.refunds += 1;
    if (credits.state.used > 0) credits.state.used -= 1;
  };
  return credits;
}

test('today run: runDaily ok → no refund, used stays', async () => {
  const credits = refundable({ used: 2 });
  const res = await (await actionsOf({ credits, jobs: fakeJobs() }))['POST /today/run']({}, {}, {});
  assert.equal(res.status, 303);
  assert.equal(credits.state.used, 3);
  assert.equal(credits.state.refunds, 0);
});

test('today run: runDaily throws → the taken credit is refunded', async () => {
  const credits = refundable({ used: 2 });
  const jobs = { runDaily: async () => { throw new Error('boom'); } };
  await (await actionsOf({ credits, jobs }))['POST /today/run']({}, {}, {});
  assert.equal(credits.state.used, 2);
  assert.equal(credits.state.refunds, 1);
});

test('today run: runDaily throws with unlimited credits → no refund', async () => {
  const credits = refundable({ used: 0, unlimited: true });
  const jobs = { runDaily: async () => { throw new Error('boom'); } };
  await (await actionsOf({ credits, jobs }))['POST /today/run']({}, {}, {});
  assert.equal(credits.state.refunds, 0);
});
