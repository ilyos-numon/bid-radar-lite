import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { rateLimiter } from 'hono-rate-limiter';
import { openDb } from '../../app/core/db.mjs';
import { createPgRateStore, clientIp, rateKey } from '../../app/core/rate-store.mjs';

// supabase/migrations 의 rate_limits 와 같은 모양
const RATE_TABLE = 'CREATE TABLE IF NOT EXISTS rate_limits (key text primary key, hits integer not null, reset_at timestamptz not null)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('rate-store: postgres store', () => {
  let db;
  before(async () => {
    db = await openDb({ memory: true });
    await db.admin(RATE_TABLE);
  });
  after(async () => {
    await db.close();
  });

  test('rate-store: 11th hit → totalHits 11; after the window → 1', async () => {
    const store = createPgRateStore({ db, windowMs: 300 });
    let last;
    for (let i = 0; i < 11; i += 1) last = await store.increment('client-a');
    assert.equal(last.totalHits, 11);
    assert.ok(last.resetTime instanceof Date);
    assert.ok(last.resetTime.getTime() > Date.now() - 1000);
    await sleep(400);
    const fresh = await store.increment('client-a');
    assert.equal(fresh.totalHits, 1);
  });

  test('rate-store: stores hashed key only; decrement and resetKey', async () => {
    const store = createPgRateStore({ db, windowMs: 60000 });
    await store.increment('client-b');
    await store.increment('client-b');
    const rows = (await db.admin('SELECT key, hits FROM rate_limits WHERE key = $1', [rateKey('client-b')])).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key.length, 16);
    assert.equal((await db.admin("SELECT count(*)::integer AS n FROM rate_limits WHERE key LIKE '%client%'")).rows[0].n, 0);
    await store.decrement('client-b');
    assert.equal((await store.get('client-b')).totalHits, 1);
    await store.resetKey('client-b');
    assert.equal(await store.get('client-b'), undefined);
    assert.equal((await store.increment('client-b')).totalHits, 1);
  });

  test('rate-store: two stores on one db share counts (two servers)', async () => {
    const a = createPgRateStore({ db, windowMs: 60000 });
    const b = createPgRateStore({ db, windowMs: 60000 });
    await a.increment('client-c');
    assert.equal((await b.increment('client-c')).totalHits, 2);
  });

  test('rate-store: init takes windowMs from limiter options when not given', async () => {
    const store = createPgRateStore({ db });
    store.init({ windowMs: 200 });
    await store.increment('client-d');
    await sleep(300);
    assert.equal((await store.increment('client-d')).totalHits, 1);
  });

  test('rate-store: hono-rate-limiter with the store → 429 on the 11th POST', async () => {
    const app = new Hono();
    app.use('*', rateLimiter({ windowMs: 60000, limit: 10, standardHeaders: 'draft-6', keyGenerator: () => 'client-e', store: createPgRateStore({ db, windowMs: 60000 }) }));
    app.post('/login', (c) => c.text('ok'));
    for (let i = 0; i < 10; i += 1) assert.equal((await app.request('/login', { method: 'POST' })).status, 200);
    assert.equal((await app.request('/login', { method: 'POST' })).status, 429);
  });
});

describe('rate-store: clientIp', () => {
  const ctx = (xff, socket = 'socket-addr') => ({
    req: { header: (name) => (name === 'x-forwarded-for' ? xff : undefined) },
    env: { incoming: { socket: { remoteAddress: socket } } },
  });

  test('rate-store: hops=0 uses the socket address and ignores XFF', () => {
    assert.equal(clientIp(0)(ctx('spoofed, real-client')), 'socket-addr');
    assert.equal(clientIp(undefined)(ctx('spoofed')), 'socket-addr');
  });

  test('rate-store: XFF hops=1 picks the last value', () => {
    assert.equal(clientIp(1)(ctx('spoofed, real-client')), 'real-client');
    assert.equal(clientIp('1')(ctx(' only-one ')), 'only-one');
  });

  test('rate-store: XFF hops=2 picks the second from the end', () => {
    assert.equal(clientIp(2)(ctx('spoofed, real-client, proxy-1')), 'real-client');
  });

  test('rate-store: too few XFF entries or none falls back to socket', () => {
    assert.equal(clientIp(3)(ctx('a, b')), 'socket-addr');
    assert.equal(clientIp(1)(ctx(undefined)), 'socket-addr');
    assert.equal(clientIp(1)({ req: { header: () => undefined }, env: {} }), 'local');
  });
});
