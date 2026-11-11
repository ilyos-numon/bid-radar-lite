import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { shot, NARA_FIXTURE } from './helpers/app.mjs';
import { startMockHttp } from './helpers/mock-ext.mjs';
import {
  SB,
  skipIfDown,
  startSbApp,
  randomEmail,
  latestMailLink,
  signupAndVerify,
  createWorkspace,
  toPlaywrightCookies,
  withOrigin,
} from './helpers/supabase.mjs';

// Supabase 모드: 계정 수명 주기, 회사 간 격리, 초대, 잡 순회, 외부 요청 0건, 가입 코드·제한
const PASSWORD = 'e2e-password-1';
const NEW_PASSWORD = 'e2e-password-2';
const NARA_PATH = '/getBidPblancListInfoCnstwk';
const BAD_LOGIN = '이메일 또는 비밀번호가 맞지 않습니다';
const JOB_TOKEN = 'e2e-job';

let browser;
const cleanups = [];

async function newApp(env = {}) {
  const app = await startSbApp({ env });
  cleanups.push(() => app.stop());
  return app;
}

async function newContext(opts = {}) {
  const context = await browser.newContext(opts);
  cleanups.push(() => context.close());
  return context;
}

async function post(baseUrl, pathname, cookie, fields = {}) {
  const init = withOrigin(baseUrl, { method: 'POST', body: new URLSearchParams(fields), redirect: 'manual' });
  if (cookie) init.headers.set('cookie', cookie);
  return fetch(`${baseUrl}${pathname}`, init);
}

async function get(baseUrl, pathname, cookie) {
  return fetch(`${baseUrl}${pathname}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
}

async function newOwner(app, tag, company) {
  const email = randomEmail(tag);
  const first = await signupAndVerify(app.baseUrl, { email, password: PASSWORD, name: `${tag}대표` });
  assert.equal(first.location, '/workspaces/new');
  const made = await createWorkspace(app.baseUrl, first.cookie, { company, name: `${tag}대표` });
  return { email, cookie: made.cookie, workspaceId: made.workspaceId };
}

async function loginViaForm(page, baseUrl, email, password) {
  await page.goto(`${baseUrl}/login`);
  await page.getByLabel('이메일').fill(email);
  await page.getByLabel('비밀번호').fill(password);
  await page.locator('main form button[type=submit]').click();
}

describe('sb accounts', () => {
  before(async () => {
    if (SB.up) browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('sb-accounts: signup, verify mail, login, change password, delete account', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await newApp();
    const context = await newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const email = randomEmail('life');
    const company = '라이프 조경';

    await page.goto(`${app.baseUrl}/signup`);
    await page.getByLabel('이메일').fill(email);
    await page.getByLabel('비밀번호').fill(PASSWORD);
    await page.getByLabel('내 이름').fill('라이프');
    await page.locator('input[name=agree_terms]').check();
    await page.locator('input[name=agree_privacy]').check();
    await page.locator('main form button[type=submit]').click();
    await page.waitForURL(/\/verify-notice\?/);
    assert.match(await page.locator('main').innerText(), /입찰 레이더 가입 확인/);

    // 메일 링크를 같은 브라우저로 연다
    await page.goto(await latestMailLink(email, { subjectIncludes: '가입 확인' }));
    await page.waitForURL(`${app.baseUrl}/workspaces/new`);
    await page.getByLabel('회사 이름').fill(company);
    await page.locator('main form button[type=submit]').click();
    await page.waitForURL(`${app.baseUrl}/settings?first=1`);

    await page.goto(`${app.baseUrl}/account`);
    assert.equal(await page.locator('h1').innerText(), '내 계정');
    const accountText = await page.locator('main').innerText();
    assert.ok(accountText.includes(email), 'account shows the email');
    assert.ok(accountText.includes(company), 'account shows the company');
    await shot(page, 'sb-account');

    // 비밀번호 변경
    await page.goto(`${app.baseUrl}/account/password`);
    await page.locator('input[name=current]').fill(PASSWORD);
    await page.locator('input[name=next]').fill(NEW_PASSWORD);
    await page.locator('input[name=next2]').fill(NEW_PASSWORD);
    await page.locator('main form button[type=submit]').click();
    await page.waitForURL(`${app.baseUrl}/account?saved=1`);

    // 로그아웃(POST) → 옛 비밀번호 실패 → 새 비밀번호 성공
    await page.goto(`${app.baseUrl}/me`);
    await page.locator('main').getByRole('button', { name: '나가기' }).click();
    await page.waitForURL(`${app.baseUrl}/welcome`);
    await loginViaForm(page, app.baseUrl, email, PASSWORD);
    await page.getByText(BAD_LOGIN).waitFor();
    assert.equal(await page.getByLabel('비밀번호').inputValue(), '', 'password field is empty after a failed login');
    await shot(page, 'sb-login');
    await loginViaForm(page, app.baseUrl, email, NEW_PASSWORD);
    await page.waitForURL(`${app.baseUrl}/today`);

    // 계정 삭제
    await page.goto(`${app.baseUrl}/account`);
    const del = page.locator('#delete');
    await del.locator('input[name=password]').fill(NEW_PASSWORD);
    await del.locator('input[name=confirm]').check();
    await del.locator('button[type=submit]').click();
    await page.waitForURL(`${app.baseUrl}/welcome?deleted=1`);
    assert.match(await page.locator('main').innerText(), /계정과 데이터를 삭제했습니다/);

    // 같은 이메일로 다시 로그인 실패
    await loginViaForm(page, app.baseUrl, email, NEW_PASSWORD);
    await page.getByText(BAD_LOGIN).waitFor();
    assert.match(page.url(), /\/login$/);
  });

  it('sb-accounts: second company cannot see first company data', { skip: skipIfDown, timeout: 180000 }, async () => {
    const mock = await startMockHttp();
    cleanups.push(() => mock.close());
    mock.set(NARA_PATH, { body: readFileSync(NARA_FIXTURE, 'utf8') });
    const app = await newApp({ NARA_API_BASE: mock.baseUrl, NARA_API_KEY: 'dummy-key', APP_SHARED_KEYS: '1' });
    const A = await newOwner(app, 'isoa', '가 조경');

    // A: 조건 저장 → 가져오기 → 관심 담기 → 알림 설정 저장
    const saved = await post(app.baseUrl, '/settings', A.cookie, {
      keywords: '조경, 수목, 가로수, 공원',
      regions: '경기, 서울',
      budgetMin: '30000000',
      budgetMax: '500000000',
      webhookUrl: '',
    });
    assert.ok(saved.status === 303 || saved.status === 200, `A settings save ${saved.status}`);
    const ctxA = await newContext();
    await ctxA.addCookies(toPlaywrightCookies(app.baseUrl, A.cookie));
    const pa = await ctxA.newPage();
    await pa.goto(`${app.baseUrl}/today`);
    await pa.getByRole('button', { name: '오늘 공고 가져오기' }).click();
    await pa.waitForSelector('ol.bids li.card');
    assert.equal(await pa.locator('ol.bids li.card').count(), 3, 'A imported 3 bids');
    const href = await pa.locator('ol.bids li.card a[href^="/assign/"]').first().getAttribute('href');
    const bidId = decodeURIComponent(href.slice('/assign/'.length));
    const interestHref = await pa.locator('ol.bids li.card').first().getByRole('link', { name: '관심', exact: true }).getAttribute('href');
    const added = await post(app.baseUrl, interestHref, A.cookie);
    assert.equal(added.status, 303, 'A marks interest');
    await pa.goto(`${app.baseUrl}/interest`);
    assert.equal(await pa.locator('ol.interest li.card').count(), 1);
    await pa.goto(`${app.baseUrl}/settings`);
    // 기본 조건과 다른 값으로 바꿔 저장 (가져오기는 이미 끝났다)
    await pa.fill('#keywords', '도로, 포장');
    await pa.getByRole('button', { name: '저장', exact: true }).click();
    await pa.getByText('저장했습니다.').waitFor();
    await pa.goto(`${app.baseUrl}/settings`);
    assert.equal(await pa.locator('#keywords').inputValue(), '도로, 포장');
    assert.equal((await get(app.baseUrl, `/summary/${encodeURIComponent(bidId)}`, A.cookie)).status, 200, 'A sees own summary');

    // B: 다른 계정·다른 회사
    const B = await newOwner(app, 'isob', '나 조경');
    assert.notEqual(B.workspaceId, A.workspaceId);
    const ctxB = await newContext();
    await ctxB.addCookies(toPlaywrightCookies(app.baseUrl, B.cookie));
    const pb = await ctxB.newPage();
    await pb.goto(`${app.baseUrl}/today`);
    assert.equal(await pb.locator('ol.bids li.card').count(), 0, 'B today has no bids');
    assert.match(await pb.locator('main').innerText(), /조건에 맞는 새 공고가 없습니다/);
    await pb.goto(`${app.baseUrl}/interest`);
    assert.equal(await pb.locator('ol.interest li.card').count(), 0);
    assert.match(await pb.locator('main').innerText(), /관심 표시한 공고가 없습니다/);
    await pb.goto(`${app.baseUrl}/settings`);
    assert.notEqual(await pb.locator('#keywords').inputValue(), '도로, 포장', 'B settings are defaults');
    await pb.goto(`${app.baseUrl}/assign/members`);
    const members = await pb.locator('main').innerText();
    assert.ok(!members.includes('isoa대표'), 'A member is not listed for B');
    assert.ok(members.includes('isob대표'));
    const cross = await get(app.baseUrl, `/summary/${encodeURIComponent(bidId)}`, B.cookie);
    assert.equal(cross.status, 404, 'B cannot open A bid summary');
  });

  it('sb-accounts: invite link requires account and joins as staff', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await newApp();
    const company = '초대 조경';
    const A = await newOwner(app, 'inva', company);
    const ctxA = await newContext();
    await ctxA.addCookies(toPlaywrightCookies(app.baseUrl, A.cookie));
    const owner = await ctxA.newPage();
    await owner.goto(`${app.baseUrl}/assign/members`);
    await owner.fill('input[name=name]', '새식구');
    await owner.getByRole('button', { name: '초대 링크 만들기' }).click();
    await owner.getByText('이 링크는 지금만 보입니다').waitFor();
    const link = await owner.locator('input[readonly]').inputValue();
    assert.match(link, /\/join\/[^/\s]+$/);

    // 로그아웃 상태로 열면 가입 안내
    const ctxB = await newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctxB.newPage();
    await page.goto(link);
    await page.waitForURL(/\/signup\?invite=1/);
    assert.match(await page.locator('main').innerText(), /초대받은 회사에 들어가려면 먼저 가입하거나 로그인하세요/);

    // 가입 → 메일 인증 → 수락 화면
    const email = randomEmail('invb');
    await page.getByLabel('이메일').fill(email);
    await page.getByLabel('비밀번호').fill(PASSWORD);
    await page.getByLabel('내 이름').fill('새식구');
    await page.locator('input[name=agree_terms]').check();
    await page.locator('input[name=agree_privacy]').check();
    await page.locator('main form button[type=submit]').click();
    await page.waitForURL(/\/verify-notice\?/);
    await page.goto(await latestMailLink(email, { subjectIncludes: '가입 확인' }));
    await page.waitForURL(/\/join\/[^/]+$/);
    const joinText = await page.locator('main').innerText();
    assert.match(joinText, /초대받은 회사/);
    assert.match(joinText, /들어가기를 누르면 초대한 회사의 구성원이 됩니다/);
    await shot(page, 'sb-join');
    await page.getByRole('button', { name: '들어가기' }).click();
    await page.waitForURL(`${app.baseUrl}/today`);
    assert.equal(await page.locator('.who .role').innerText(), '구성원');
    await page.goto(`${app.baseUrl}/me`);
    const me = await page.locator('main').innerText();
    assert.ok(me.includes(company), 'me shows company A');
    assert.ok(me.includes('구성원'));
  });

  it('sb-accounts: jobs all=1 previews one payload per workspace and queues real runs', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await newApp();
    const A = await newOwner(app, 'joba', '잡 조경 가');
    const B = await newOwner(app, 'jobb', '잡 조경 나');
    const headers = { 'x-job-token': JOB_TOKEN };

    const listIds = async () => {
      const res = await fetch(`${SB.url}/rest/v1/workspaces?select=id`, {
        headers: { apikey: SB.serviceKey, authorization: `Bearer ${SB.serviceKey}` },
      });
      assert.equal(res.status, 200);
      return (await res.json()).map((r) => r.id);
    };
    const before = await listIds();
    // 미리보기(dry=1): 회사마다 payload 한 개씩 담긴 배열을 바로 돌려준다
    const res = await fetch(`${app.baseUrl}/api/jobs/daily?all=1&dry=1&date=2026-10-29`, { headers });
    assert.equal(res.status, 200);
    const body = await res.json();
    const after = await listIds();
    assert.ok(Array.isArray(body));
    // 공유 스택이라 다른 테스트가 회사를 만들 수 있다: 조회 전·후 어느 쪽과 같아야 한다
    assert.ok(body.length === before.length || body.length === after.length, `length ${body.length} vs ${before.length}/${after.length}`);
    const ids = body.map((p) => p.workspaceId);
    assert.equal(new Set(ids).size, ids.length, 'one payload per workspace');
    for (const id of [A.workspaceId, B.workspaceId]) assert.ok(ids.includes(id), 'own workspace is included');
    for (const p of body) {
      assert.equal(p.kind, 'bids');
      assert.ok('notifyUrl' in p, 'payload has notifyUrl');
      assert.ok(after.includes(p.workspaceId) || before.includes(p.workspaceId));
    }

    const rem = await fetch(`${app.baseUrl}/api/jobs/reminders?all=1&dry=1&date=2026-10-29`, { headers });
    assert.equal(rem.status, 200);
    assert.deepEqual(await rem.json(), []);

    // 실제 호출(dry 없음): 회사별 작업을 큐에 넣고 바로 202. 회사마다 실행 기록 한 줄이 생긴다
    const queued = await fetch(`${app.baseUrl}/api/jobs/reminders?all=1&date=2026-10-29`, { headers });
    assert.equal(queued.status, 202);
    const q = await queued.json();
    assert.equal(q.runId, 'reminders:2026-10-29');
    assert.equal(typeof q.enqueued, 'number');
    assert.equal(typeof q.skipped, 'number');
    assert.ok(q.enqueued + q.skipped >= 2, 'both companies were considered');
    const runsRes = await fetch(`${app.baseUrl}/api/jobs/reminders/runs?date=2026-10-29`, { headers });
    assert.equal(runsRes.status, 200);
    const runIds = (await runsRes.json()).map((r) => r.workspaceId);
    for (const id of [A.workspaceId, B.workspaceId]) assert.ok(runIds.includes(id), 'run recorded for own workspace');

    const noToken = await fetch(`${app.baseUrl}/api/jobs/daily?all=1`);
    assert.ok(noToken.status === 401 || noToken.status === 403, `no token ${noToken.status}`);
    const none = await fetch(`${app.baseUrl}/api/jobs/daily`, { headers });
    assert.equal(none.status, 400);
  });

  it('sb-accounts: zero external requests on platform screens', { skip: skipIfDown, timeout: 180000 }, async () => {
    const app = await newApp();
    const A = await newOwner(app, 'ext', '외부 조경');
    const context = await newContext();
    const page = await context.newPage();
    const urls = [];
    page.on('request', (r) => urls.push(r.url()));

    for (const p of ['/welcome', '/signup', '/login', '/reset']) await page.goto(`${app.baseUrl}${p}`);
    await context.addCookies(toPlaywrightCookies(app.baseUrl, A.cookie));
    for (const p of ['/account', '/workspaces/new', '/me', '/connections']) await page.goto(`${app.baseUrl}${p}`);

    assert.ok(urls.length >= 8, `visited pages produced requests (${urls.length})`);
    const outside = urls.filter((u) => !u.startsWith(app.baseUrl) && !u.startsWith('data:') && !u.startsWith('about:'));
    assert.deepEqual(outside, [], 'no request leaves the app origin');
  });

  it('sb-accounts: signup code mode and rate limit', { skip: skipIfDown, timeout: 180000 }, async () => {
    const code = 'e2e-code-1';
    const coded = await newApp({ APP_SIGNUP_MODE: 'code', APP_SIGNUP_CODE: code });
    const email = randomEmail('code');
    const noCode = await post(coded.baseUrl, '/signup', '', { email, password: PASSWORD, name: '코드' });
    assert.ok(noCode.status >= 400 && noCode.status < 500, `no code status ${noCode.status}`);
    assert.match(await noCode.text(), /가입 코드가 맞지 않습니다/);
    const wrong = await post(coded.baseUrl, '/signup', '', { email, password: PASSWORD, name: '코드', code: 'nope' });
    assert.match(await wrong.text(), /가입 코드가 맞지 않습니다/);
    const ok = await post(coded.baseUrl, '/signup', '', { email, password: PASSWORD, name: '코드', code, agree_terms: '1', agree_privacy: '1' });
    assert.equal(ok.status, 303);
    assert.match(ok.headers.get('location') ?? '', /^\/verify-notice/);

    const limited = await newApp();
    const statuses = [];
    let lastText = '';
    for (let i = 0; i < 11; i += 1) {
      const res = await post(limited.baseUrl, '/login', '', { email: randomEmail('rl'), password: 'wrong-password' });
      statuses.push(res.status);
      lastText = await res.text();
    }
    assert.ok(statuses[9] !== 429, `10th request is still handled (${statuses.join(',')})`);
    assert.ok(statuses[10] === 429 || /너무 여러 번/.test(lastText), `11th is limited (${statuses.join(',')})`);
  });
});
