import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { createLogger, logger, logRequest, safePath, REDACT } from '../../app/core/log.mjs';

function capture(level = 'info') {
  const lines = [];
  const destination = new Writable({
    write(chunk, enc, cb) {
      for (const s of String(chunk).split('\n')) if (s.trim()) lines.push(JSON.parse(s));
      cb();
    },
  });
  return { log: createLogger({ level, destination }), lines };
}

test('log: password, token, cookie and nested values are [Redacted]', () => {
  const { log, lines } = capture();
  log.info(
    { password: 'pw-1', token: 'tk-1', authorization: 'Bearer x', cookie: 'a=b', apiKey: 'k-1', body: { password: 'pw-2', token: 'tk-2' }, req: { headers: { cookie: 'c=d' } }, keep: 'visible' },
    'hello',
  );
  assert.equal(lines.length, 1);
  const l = lines[0];
  assert.equal(l.password, '[Redacted]');
  assert.equal(l.token, '[Redacted]');
  assert.equal(l.authorization, '[Redacted]');
  assert.equal(l.cookie, '[Redacted]');
  assert.equal(l.apiKey, '[Redacted]');
  assert.equal(l.body.password, '[Redacted]');
  assert.equal(l.body.token, '[Redacted]');
  assert.equal(l.req.headers.cookie, '[Redacted]');
  assert.equal(l.keep, 'visible');
  assert.equal(l.msg, 'hello');
  assert.equal(l.level, 30);
  assert.ok(typeof l.time === 'number');
  assert.equal(l.pid, undefined);
  assert.equal(l.hostname, undefined);
});

test('log: request line shape hides invite token in path', () => {
  const { log, lines } = capture();
  logRequest({ method: 'GET', path: '/join/secret-token-123', status: 200, ms: 12, requestId: 'r1', workspaceId: 'w1' }, log);
  assert.deepEqual(
    { msg: lines[0].msg, method: lines[0].method, path: lines[0].path, status: lines[0].status, ms: lines[0].ms, requestId: lines[0].requestId, workspaceId: lines[0].workspaceId },
    { msg: 'request', method: 'GET', path: '/join/:token', status: 200, ms: 12, requestId: 'r1', workspaceId: 'w1' },
  );
  assert.ok(!JSON.stringify(lines[0]).includes('secret-token-123'));
  assert.equal(safePath('/today'), '/today');
});

test('log: level filter and bad level falls back to info', () => {
  const quiet = capture('warn');
  quiet.log.info('skip');
  quiet.log.warn('keep');
  assert.deepEqual(quiet.lines.map((l) => l.msg), ['keep']);
  const bad = capture('nonsense');
  assert.equal(bad.log.level, 'info');
});

test('log: default logger uses the redact list', () => {
  assert.equal(typeof logger.info, 'function');
  assert.ok(REDACT.includes('password') && REDACT.includes('req.headers.cookie'));
});
