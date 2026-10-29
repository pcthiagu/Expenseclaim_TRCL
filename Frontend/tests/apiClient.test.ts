import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ApiClient, ApiError, checkAttachment, createApiClientFromEnv } from '../src/services/apiClient.ts';
import { DEFAULT_POLICY } from '../src/config/policy.ts';

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
let server: http.Server;
let base = '';
const seen: Seen[] = [];
let hits = 0;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      const u = (req.url ?? '').replace(/^\/api/, '');
      const send = (s: number, b: unknown, raw = false) => { res.writeHead(s, { 'Content-Type': raw ? 'text/plain' : 'application/json' }); res.end(raw ? String(b) : JSON.stringify(b)); };
      if (u.startsWith('/ok')) return send(200, { hello: 'world' });
      if (u.startsWith('/empty')) { res.writeHead(204); return res.end(); }
      if (u.startsWith('/e401')) return send(401, { message: 'Token expired' });
      if (u.startsWith('/e403')) return send(403, { error: 'Not an approver' });
      if (u.startsWith('/e404')) return send(404, {});
      if (u.startsWith('/e409')) return send(409, { title: 'Stale version' });
      if (u.startsWith('/e422')) return send(422, { message: 'Amount invalid', errors: { amount: ['must be > 0'] } });
      if (u.startsWith('/e500')) return send(500, 'boom', true);
      if (u.startsWith('/badjson')) return send(200, '<html>not json', true);
      if (u.startsWith('/slow')) return void setTimeout(() => send(200, {}), 400);
      if (u.startsWith('/count')) { hits++; return void setTimeout(() => send(200, { n: hits }), 50); }
      send(200, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
});
after(() => { server.close(); });

const client = (extra = {}) => new ApiClient({ baseUrl: base, ...extra });
const fail = async (p: Promise<unknown>): Promise<ApiError> => { try { await p; } catch (e) { return e as ApiError; } throw new Error('expected rejection'); };

test('GET returns parsed JSON, joins base+path without double slashes, builds the query string, skips empty values', async () => {
  const r = await client().get<{ hello: string }>('/ok', { query: { a: 1, b: 'x y', c: undefined, d: null, e: false } });
  assert.deepEqual(r, { hello: 'world' });
  const last = seen.at(-1)!;
  assert.equal(last.url, '/api/ok?a=1&b=x+y&e=false');
  assert.equal(last.headers.accept, 'application/json');
});

test('204 No Content resolves to null', async () => { assert.equal(await client().delete('/empty'), null); });

test('JSON bodies are serialised with a JSON content-type; auth headers are injected per request', async () => {
  let n = 0;
  await client({ getAuthHeaders: async () => ({ Authorization: `Bearer t${++n}` }) }).post('/ok', { amount: 5 });
  const last = seen.at(-1)!;
  assert.equal(last.method, 'POST');
  assert.equal(last.headers['content-type'], 'application/json');
  assert.equal(last.body, '{"amount":5}');
  assert.equal(last.headers.authorization, 'Bearer t1');
});

test('multipart upload: FormData is sent as multipart with a browser-set boundary and the file content intact', async () => {
  const form = new FormData();
  form.append('file', new Blob(['%PDF-1.4 hello'], { type: 'application/pdf' }), 'bill.pdf');
  await client().upload('/ok', form);
  const last = seen.at(-1)!;
  assert.match(String(last.headers['content-type']), /^multipart\/form-data; boundary=/);
  assert.match(last.body, /filename="bill\.pdf"/);
  assert.match(last.body, /%PDF-1\.4 hello/);
});

test('401 and 403 call their hooks once and keep the backend message', async () => {
  const calls: string[] = [];
  const c = client({ onUnauthorized: () => calls.push('401'), onForbidden: () => calls.push('403') });
  const e1 = await fail(c.get('/e401'));
  assert.deepEqual([e1.code, e1.status, e1.message, e1.backendMessage], ['unauthorized', 401, 'Token expired', 'Token expired']);
  const e2 = await fail(c.get('/e403'));
  assert.deepEqual([e2.code, e2.status, e2.backendMessage], ['forbidden', 403, 'Not an approver']);
  assert.deepEqual(calls, ['401', '403']);
});

test('validation, conflict, not-found and server errors are classified; details keep the raw body', async () => {
  const v = await fail(client().post('/e422', {}));
  assert.equal(v.code, 'validation');
  assert.equal(v.message, 'Amount invalid');
  assert.deepEqual(v.details, { message: 'Amount invalid', errors: { amount: ['must be > 0'] } });
  assert.equal((await fail(client().get('/e409'))).code, 'conflict');
  assert.equal((await fail(client().get('/e409'))).message, 'Stale version');
  const nf = await fail(client().get('/e404'));
  assert.equal(nf.code, 'not_found');
  assert.equal(nf.backendMessage, null);
  assert.match(nf.message, /not found/i, 'falls back to generic text only when the backend sent none');
  const s = await fail(client().get('/e500'));
  assert.deepEqual([s.code, s.backendMessage], ['server', 'boom']);
});

test('a 200 with a non-JSON body is a parse error, not silently accepted', async () => {
  assert.equal((await fail(client().get('/badjson'))).code, 'parse');
});

test('timeout aborts a slow request; a caller abort is reported as aborted; unreachable host is a network error', async () => {
  assert.equal((await fail(client({ timeoutMs: 100 }).get('/slow'))).code, 'timeout');
  const ac = new AbortController();
  const p = client().get('/slow', { signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  assert.equal((await fail(p)).code, 'aborted');
  assert.equal((await fail(new ApiClient({ baseUrl: 'http://127.0.0.1:1/api' }).get('/x'))).code, 'network');
});

test('runOnce shares one in-flight request for a repeated key (double-click Submit), then allows a new one', async () => {
  hits = 0;
  const c = client();
  const [a, b] = await Promise.all([c.runOnce('submit:1', () => c.post<{ n: number }>('/count')), c.runOnce('submit:1', () => c.post<{ n: number }>('/count'))]);
  assert.equal(hits, 1);
  assert.equal(a.n, b.n);
  await c.runOnce('submit:1', () => c.post('/count'));
  assert.equal(hits, 2);
  await Promise.all([c.runOnce('a', () => c.post('/count')), c.runOnce('b', () => c.post('/count'))]);
  assert.equal(hits, 4, 'different keys are independent');
});

test('runOnce releases the key after a failure', async () => {
  const c = client();
  await fail(c.runOnce('k', () => c.get('/e500')));
  assert.deepEqual(await c.runOnce('k', () => c.get('/ok')), { hello: 'world' });
});

test('client never logs request data (console is silent through success and failure)', async () => {
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  const logged: unknown[] = [];
  for (const k of Object.keys(orig) as Array<keyof typeof orig>) console[k] = (...a: unknown[]) => { logged.push(a); };
  try {
    const c = client({ getAuthHeaders: () => ({ Authorization: 'Bearer SECRET' }) });
    await c.post('/ok', { password: 'hunter2' });
    await fail(c.post('/e401', { password: 'hunter2' }));
  } finally { Object.assign(console, orig); }
  assert.deepEqual(logged, []);
});

test('configuration: missing base URL fails loudly; env factory reads timeout', async () => {
  assert.throws(() => new ApiClient({ baseUrl: '' }), /VITE_API_BASE_URL/);
  assert.throws(() => createApiClientFromEnv({}), /baseUrl is required/);
  const c = createApiClientFromEnv({ VITE_API_BASE_URL: base, VITE_API_TIMEOUT_MS: '100' });
  assert.equal((await fail(c.get('/slow'))).code, 'timeout');
});

test('attachment pre-check accepts PDF/JPG/PNG up to 5 MB and rejects the rest', () => {
  const p = DEFAULT_POLICY;
  assert.equal(checkAttachment({ name: 'a.pdf', size: 5 * 1024 * 1024, type: 'application/pdf' }, p), null);
  assert.equal(checkAttachment({ name: 'a.png', size: 1, type: 'image/png' }, p), null);
  assert.equal(checkAttachment({ name: 'a.jpg', size: 1, type: 'image/jpeg' }, p), null);
  assert.match(checkAttachment({ name: 'a.gif', size: 1, type: 'image/gif' }, p)!, /only PDF, JPG or PNG/);
  assert.match(checkAttachment({ name: 'big.pdf', size: 5 * 1024 * 1024 + 1, type: 'application/pdf' }, p)!, /larger than 5 MB/);
});
