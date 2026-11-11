import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startApp, setupOwner, openAs } from './helpers/app.mjs';

// 기존(PGlite) 모드: 예약 실행 꺼짐 안내는 APP_SCHEDULER_OFF=1 일 때만, 상태 확인·잡 주소는 하루 첫 방문을 일으키지 않는다
let browser;
const cleanups = [];

async function tipCount(env) {
  const app = await startApp({ env });
  cleanups.push(() => app.stop());
  const { cookie } = await setupOwner(app.baseUrl);
  const { context, page } = await openAs(browser, app.baseUrl, cookie);
  cleanups.push(() => context.close());
  await page.goto(`${app.baseUrl}/settings`);
  await page.locator('main').waitFor();
  return page.locator('main .tip[data-tip*="예약 실행을 꺼 두었습니다"]').count();
}

describe('app schedule note', () => {
  before(async () => {
    browser = await chromium.launch();
  });

  after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {});
    await browser?.close();
  });

  it('app-schedule-note: legacy mode shows the tip only when APP_SCHEDULER_OFF=1', { timeout: 120000 }, async () => {
    assert.equal(await tipCount({ APP_SCHEDULER_OFF: '1' }), 1);
    assert.equal(await tipCount({}), 0);
  });

  it('app-schedule-note: healthz, readyz and job routes never trigger day start', { timeout: 120000 }, async () => {
    const app = await startApp({ env: { APP_SCHEDULER_OFF: '1' } });
    cleanups.push(() => app.stop());
    for (const p of ['/healthz', '/readyz', '/healthz', '/readyz']) {
      const res = await fetch(`${app.baseUrl}${p}`);
      assert.equal(res.status, 200);
      await res.arrayBuffer();
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !app.stdout().includes('"/readyz"')) await new Promise((r) => setTimeout(r, 50));
    assert.ok(app.stdout().includes('"/readyz"'), 'readyz request was logged');
    assert.ok(!app.stdout().includes('/api/jobs/collect'), 'no collect job request line');
  });
});
