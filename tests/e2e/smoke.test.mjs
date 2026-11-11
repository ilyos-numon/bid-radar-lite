import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { startNaraMock, startNotifySink, runN8n } from './helpers/mock-servers.mjs';

const LOG_DIR = 'test-results/e2e-logs';
const FIX = {
  match: 'tests/fixtures/nara-bids.json',
  nomatch: 'tests/e2e/fixtures/nara-bids-nomatch.json',
  error: 'tests/e2e/fixtures/nara-bids-error.json',
};
const ENV = {
  NARA_API_BASE: 'http://host.docker.internal:8794',
  NARA_API_KEY: 'dummy-key',
  NOTIFY_WEBHOOK_URL: 'http://host.docker.internal:8795/notify',
};

let nara;
let sink;

function savePayload(name, payload) {
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(`${LOG_DIR}/${name}`, JSON.stringify(payload, null, 2));
}

function execute(fixture) {
  nara.setFixture(fixture);
  return runN8n(['execute', '--id=bidRadarSmoke001'], ENV);
}

describe('bid-radar-smoke workflow', () => {
  before(async () => {
    spawnSync('docker', ['compose', 'stop', 'n8n'], { encoding: 'utf8' });
    nara = await startNaraMock({ port: 8794 });
    sink = await startNotifySink({ port: 8795 });
    const imp = runN8n(['import:workflow', '--input=/home/node/workflows/bid-radar-smoke.json']);
    assert.equal(imp.status, 0, `import failed: ${imp.stderr}`);
  });

  after(async () => {
    await nara?.close();
    await sink?.close();
  });

  beforeEach(() => {
    sink.received.length = 0;
    nara.requests.length = 0;
  });

  it('match: sends 3 matched bids', { timeout: 180000 }, async () => {
    const r = execute(FIX.match);
    assert.equal(r.status, 0, `execute failed: ${r.stderr}\n${r.stdout}`);
    await sleep(5000);
    assert.equal(sink.received.length, 1);
    const p = sink.received[0];
    savePayload('notify-match.json', p);
    assert.equal(p.count, 3);
    assert.deepEqual(p.items.map((i) => i.bidId), [
      '20261029007-000', '20261029001-000', '20261029002-000',
    ]);
    assert.equal((p.text.match(/왜 추천:/g) ?? []).length, 3);
    assert.ok(nara.requests.length >= 1);
    const q = nara.requests[0];
    assert.ok(q.path.endsWith('/getBidPblancListInfoCnstwk'), q.path);
    assert.equal(q.query.serviceKey, 'dummy-key');
    assert.equal(q.query.type, 'json');
  });

  it('nomatch: sends empty-day message', { timeout: 180000 }, async () => {
    const r = execute(FIX.nomatch);
    assert.equal(r.status, 0, `execute failed: ${r.stderr}\n${r.stdout}`);
    await sleep(5000);
    assert.equal(sink.received.length, 1);
    const p = sink.received[0];
    savePayload('notify-nomatch.json', p);
    assert.equal(p.count, 0);
    assert.equal(p.items.length, 0);
    assert.match(p.text, /^입찰 레이더 · \d{2}\/\d{2} 오늘은 조건에 맞는 새 공고가 없습니다$/);
  });

  it('error: api error sends nothing', { timeout: 180000 }, async () => {
    execute(FIX.error);
    await sleep(5000);
    assert.equal(sink.received.length, 0);
  });
});
