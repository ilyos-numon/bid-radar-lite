import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { startNaraMock, startNotifySink, runN8n } from './helpers/mock-servers.mjs';
import { startApp, setupOwner, NARA_FIXTURE } from './helpers/app.mjs';

const LOG_DIR = 'test-results/e2e-logs';
const SINK_URL = 'http://host.docker.internal:8795/notify';

let nara;
let sink;
let app;
let owner;

function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

describe('bid-radar-daily workflow', () => {
  before(async () => {
    spawnSync('docker', ['compose', 'stop', 'n8n'], { encoding: 'utf8' });
    sink = await startNotifySink({ port: 8795 });
    nara = await startNaraMock({ port: 8794 });
    nara.setFixture(NARA_FIXTURE);
    app = await startApp({
      env: {
        NARA_API_BASE: 'http://localhost:8794',
        NARA_API_KEY: 'dummy-key',
        NOTIFY_WEBHOOK_URL: SINK_URL.replace('host.docker.internal', 'localhost'),
      },
    });
    owner = await setupOwner(app.baseUrl);
    const imp = runN8n(['import:workflow', '--input=/home/node/workflows/bid-radar-daily.json']);
    assert.equal(imp.status, 0, `import failed: ${imp.stderr}`);
  });

  after(async () => {
    await app?.stop();
    await nara?.close();
    await sink?.close();
  });

  beforeEach(() => {
    sink.received.length = 0;
  });

  it('daily workflow: forwards bids notification', { timeout: 180000 }, async () => {
    const port = new URL(app.baseUrl).port;
    const r = runN8n(['execute', '--id=bidRadarDaily001'], {
      APP_BASE_URL: `http://host.docker.internal:${port}`,
      APP_JOB_TOKEN: 'e2e-job',
      NOTIFY_WEBHOOK_URL: SINK_URL,
    });
    assert.equal(r.status, 0, `execute failed: ${r.stderr}\n${r.stdout}`);
    await sleep(5000);
    assert.equal(sink.received.length, 1);
    const p = sink.received[0];
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(`${LOG_DIR}/notify-daily.json`, JSON.stringify(p, null, 2));
    assert.equal('notifyUrl' in p, false);
    assert.equal(p.kind, 'bids');
    assert.equal(p.count, 3);
    assert.deepEqual(p.items.map((i) => i.bidId), [
      '20261029007-000', '20261029001-000', '20261029002-000',
    ]);
    assert.ok(p.text.startsWith('입찰 레이더 · 10/29 새 공고 3건'), p.text);
    assert.equal((p.text.match(/왜 추천:/g) ?? []).length, 3);
    const lines = p.text.trimEnd().split('\n');
    assert.ok(lines[lines.length - 1].startsWith('설정 바꾸기:'), lines[lines.length - 1]);
  });

  it('daily workflow: app unreachable sends nothing', { timeout: 180000 }, async () => {
    const port = await closedPort();
    const r = runN8n(['execute', '--id=bidRadarDaily001'], {
      APP_BASE_URL: `http://host.docker.internal:${port}`,
      APP_JOB_TOKEN: 'e2e-job',
      NOTIFY_WEBHOOK_URL: SINK_URL,
    });
    assert.equal(r.status, 0, `execute exit: ${r.stderr}\n${r.stdout}`);
    await sleep(5000);
    assert.equal(sink.received.length, 0);
  });

  it('daily workflow: sends to the address saved in settings', { timeout: 180000 }, async () => {
    const saved = await fetch(`${app.baseUrl}/settings`, {
      method: 'POST',
      headers: { cookie: owner.cookie },
      body: new URLSearchParams({
        keywords: '조경, 수목, 가로수, 공원',
        regions: '경기, 서울',
        budgetMin: '30000000',
        budgetMax: '500000000',
        webhookUrl: SINK_URL,
      }),
      redirect: 'manual',
    });
    assert.equal(saved.status, 303);
    const deadPort = await closedPort();
    const port = new URL(app.baseUrl).port;
    const r = runN8n(['execute', '--id=bidRadarDaily001'], {
      APP_BASE_URL: `http://host.docker.internal:${port}`,
      APP_JOB_TOKEN: 'e2e-job',
      NOTIFY_WEBHOOK_URL: `http://host.docker.internal:${deadPort}/notify`,
    });
    assert.equal(r.status, 0, `execute failed: ${r.stderr}\n${r.stdout}`);
    await sleep(5000);
    assert.equal(sink.received.length, 1);
    const p = sink.received[0];
    assert.equal(p.kind, 'bids');
    assert.equal(p.count, 3);
    assert.equal('notifyUrl' in p, false);
  });
});
