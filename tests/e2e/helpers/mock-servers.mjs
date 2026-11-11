import http from 'node:http';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// spawnSync blocks the main thread's event loop, so the HTTP servers run in a
// worker thread and report what they receive back through messages.
function startWorker(kind, port) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { kind, port } });
  return new Promise((resolve, reject) => {
    worker.once('error', reject);
    worker.on('message', function onMsg(msg) {
      if (msg.type === 'listening') resolve({ worker, port: msg.port });
    });
  });
}

function wrap(worker, sink) {
  worker.on('message', (msg) => {
    if (msg.type === 'record') sink.push(msg.value);
  });
  return () => new Promise((resolve) => {
    worker.once('exit', () => resolve());
    worker.postMessage({ type: 'close' });
  });
}

export async function startNaraMock({ port = 8794 } = {}) {
  const { worker } = await startWorker('nara', port);
  const requests = [];
  const close = wrap(worker, requests);
  return {
    setFixture(path) { worker.postMessage({ type: 'fixture', body: readFileSync(path, 'utf8') }); },
    requests,
    close,
  };
}

// port 0 picks a free port. POST /notify answers 200, POST /fail answers 500 (both record the JSON body in `received`).
export async function startNotifySink({ port = 8795 } = {}) {
  const { worker, port: actual } = await startWorker('sink', port);
  const received = [];
  const close = wrap(worker, received);
  return { received, baseUrl: `http://localhost:${actual}`, close };
}

if (!isMainThread && workerData?.kind) {
  const { kind, port } = workerData;
  let body = '{}';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (kind === 'nara') {
        const u = new URL(req.url, 'http://localhost');
        parentPort.postMessage({ type: 'record', value: { path: u.pathname, query: Object.fromEntries(u.searchParams) } });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
      } else {
        const failing = req.url === '/fail';
        if (req.method === 'POST' && (req.url === '/notify' || failing)) {
          try { parentPort.postMessage({ type: 'record', value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { /* ignore non-JSON */ }
        }
        res.writeHead(failing ? 500 : 200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    });
  });
  parentPort.on('message', (msg) => {
    if (msg.type === 'fixture') body = msg.body;
    if (msg.type === 'close') {
      server.closeAllConnections?.();
      server.close(() => process.exit(0));
    }
  });
  server.once('error', (e) => { throw e; });
  server.listen(port, () => parentPort.postMessage({ type: 'listening', port: server.address().port }));
}

export function runN8n(args, env = {}) {
  const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const r = spawnSync('docker', ['compose', 'run', '--rm', '-T', ...envArgs, 'n8n', ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
