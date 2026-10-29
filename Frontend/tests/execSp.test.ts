import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAuthStore } from '../src/auth/authStore.ts';
import { readAppConfig } from '../src/config/appConfig.ts';
import { ApiError } from '../src/services/apiClient.ts';
import { authedFetchOf, buildError, createExecSp, looksLikeInternals } from '../src/services/execSp.ts';
import { attachmentViewPath, createFileClient } from '../src/services/fileApi.ts';

/** A fake of the existing backend: /api/execute (Bearer check, TOKEN_EXPIRED), /api/auth/refresh, /api/attachment/view/... */
interface Seen { method: string; url: string; auth?: string; body: string }
let server: http.Server; let base = '';
const seen: Seen[] = [];
let validToken = 'T1'; let refreshCalls = 0; let refreshOk = true; let refreshDelay = 0;
let nextExecute: (() => { status: number; body: unknown }) | null = null;

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const s: Seen = { method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: Buffer.concat(chunks).toString() };
      seen.push(s);
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (s.url === '/api/auth/refresh') {
        refreshCalls++; if (refreshDelay) await new Promise((r) => setTimeout(r, refreshDelay));
        if (!refreshOk) return send(401, { success: false, message: 'Refresh token invalid' });
        validToken = 'T' + (refreshCalls + 1);
        return send(200, { success: true, data: { accessToken: validToken, user: { employeeId: 'E7', name: 'Priya' } } });
      }
      if (s.url === '/api/execute') {
        if (s.auth !== `Bearer ${validToken}`) return send(401, { success: false, code: 'TOKEN_EXPIRED', message: 'jwt expired' });
        if (nextExecute) { const r = nextExecute(); nextExecute = null; return send(r.status, r.body); }
        const { spName, params } = JSON.parse(s.body);
        return send(200, { success: true, data: { echo: spName, params }, message: 'OK' });
      }
      if (s.url.startsWith('/api/attachment/view/')) {
        if (s.auth !== `Bearer ${validToken}`) return send(401, { success: false, code: 'TOKEN_EXPIRED' });
        if (s.url.includes('secret-other')) return send(403, { success: false, message: 'Not allowed' });
        if (s.url.includes('missing-file')) return send(404, { success: false, message: 'File not found' });
        res.writeHead(200, { 'Content-Type': 'application/pdf' }); return res.end('%PDF-1.4 hello');
      }
      send(404, { success: false, message: 'nope' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { server.close(); });

function setup(token: string | null = 'T1', user: { employeeId: string } | null = { employeeId: 'E1' }) {
  validToken = 'T1'; refreshCalls = 0; refreshOk = true; refreshDelay = 0; seen.length = 0; nextExecute = null;
  const store = createAuthStore(); if (token) store.setAuthState(token, user);
  return { store, execSp: createExecSp({ baseUrl: base, store, timeoutMs: 2000 }) };
}
const fail = async (p: Promise<unknown>): Promise<ApiError> => { try { await p; } catch (e) { if (e instanceof ApiError) return e; throw e; } throw new Error('expected rejection'); };

test('config: base URL from env (default http://localhost:4000), trailing slashes removed, timeout default 20 s', () => {
  assert.deepEqual(readAppConfig({}), { apiBaseUrl: 'http://localhost:4000', apiTimeoutMs: 20000 });
  assert.deepEqual(readAppConfig({ VITE_API_BASE_URL: 'https://hr.example.com//', VITE_API_TIMEOUT_MS: '5000' }), { apiBaseUrl: 'https://hr.example.com', apiTimeoutMs: 5000 });
});

test('execSp posts {spName, params} to /api/execute with the Bearer token and returns data; the browser sends NO identity (the server adds ExecutedBy)', async () => {
  const { execSp } = setup();
  const data = await execSp('SOME_SP', { a: 1 }) as { echo: string; params: Record<string, unknown> };
  assert.equal(data.echo, 'SOME_SP');
  assert.deepEqual(data.params, { a: 1 });
  const s = seen[0]!;
  assert.deepEqual([s.method, s.url, s.auth], ['POST', '/api/execute', 'Bearer T1']);
});

test('an expired access token is refreshed ONCE via /api/auth/refresh and the call is retried once; the new token and user are stored', async () => {
  const { execSp, store } = setup('OLD');
  const data = await execSp('X', {}) as { params: Record<string, unknown> };
  assert.equal(refreshCalls, 1);
  assert.equal(store.getAccessToken(), 'T2'); assert.equal(store.getCurrentUser()?.employeeId, 'E7');
  assert.deepEqual(seen.map((s) => [s.url, s.auth]), [['/api/execute', 'Bearer OLD'], ['/api/auth/refresh', undefined], ['/api/execute', 'Bearer T2']]);
  assert.deepEqual(data.params, {}, 'no identity is sent, before or after the refresh');
});

test('concurrent calls that all hit TOKEN_EXPIRED share ONE refresh', async () => {
  const { execSp } = setup('OLD'); refreshDelay = 80;
  const results = await Promise.all([execSp('A'), execSp('B'), execSp('C'), execSp('D')]);
  assert.equal(results.length, 4); assert.equal(refreshCalls, 1);
  assert.equal(seen.filter((s) => s.url === '/api/execute').length, 8, 'four initial attempts + four retries');
});

test('if the refresh fails the auth state is cleared and an "unauthorized" error is raised (the app then shows login); subscribers are notified', async () => {
  const { execSp, store } = setup('OLD'); refreshOk = false;
  let notified = 0; store.subscribe(() => { notified++; });
  const e = await fail(execSp('X'));
  assert.equal(e.code, 'unauthorized'); assert.equal(store.getAccessToken(), null); assert.equal(store.getCurrentUser(), null); assert.ok(notified >= 1);
  assert.equal(seen.filter((s) => s.url === '/api/execute').length, 1, 'no second attempt after a failed refresh');
});

test('a retried call that is rejected again does not loop: exactly one refresh and two execute attempts', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url.replace(/^https?:\/\/[^/]+/, ''));
    return url.endsWith('/api/auth/refresh')
      ? new Response(JSON.stringify({ success: true, data: { accessToken: 'NEW' } }), { status: 200 })
      : new Response(JSON.stringify({ success: false, code: 'TOKEN_EXPIRED', message: 'jwt expired' }), { status: 401 }); // even the new token is refused
  }) as unknown as typeof fetch;
  const store = createAuthStore(); store.setAuthState('OLD', null);
  const e = await fail(createExecSp({ baseUrl: 'http://x', store, fetchImpl })('X'));
  assert.equal(e.code, 'unauthorized');
  assert.deepEqual(calls, ['/api/execute', '/api/auth/refresh', '/api/execute']);
});

test('a 401 that is NOT TOKEN_EXPIRED does not trigger a refresh', async () => {
  const { execSp } = setup('T1'); nextExecute = () => ({ status: 401, body: { success: false, message: 'Account disabled' } });
  const e = await fail(execSp('X'));
  assert.deepEqual([e.code, e.status, refreshCalls], ['unauthorized', 401, 0]);
  assert.equal(e.message, 'Account disabled');
});

test('success:false keeps the backend message; HTTP status picks the error class (400/422 validation, 403 forbidden, 404 not found, 409 conflict)', async () => {
  const { execSp } = setup();
  for (const [status, code] of [[200, 'client'], [400, 'validation'], [422, 'validation'], [403, 'forbidden'], [404, 'not_found'], [409, 'conflict']] as const) {
    nextExecute = () => ({ status, body: { success: false, message: 'Only drafts can be edited' } });
    const e = await fail(execSp('X'));
    assert.deepEqual([e.code, e.message], [code, 'Only drafts can be edited'], String(status));
    assert.deepEqual(e.details, { summary: ['Only drafts can be edited'] });
  }
  nextExecute = () => ({ status: 400, body: { success: false, message: '[FORBIDDEN] You cannot edit this request' } });
  const e = await fail(execSp('X')); assert.deepEqual([e.code, e.message], ['forbidden', 'You cannot edit this request'], 'the optional [CODE] convention still wins');
});

test('SQL Server / driver internals are never shown: they become a generic message', async () => {
  const { execSp } = setup();
  for (const msg of ["Invalid object name 'dbo.TA_Requests'.", 'Msg 547, Level 16, State 0, Procedure TA_usp_X, Line 12', 'RequestError: Timeout expired', 'Violation of PRIMARY KEY constraint PK_x', 'at execProcedure (C:\\app\\sql\\exec.js:44:11)', "EXEC TA_usp_GetPendingApprovals @JsonParam = '{}'"]) {
    nextExecute = () => ({ status: 500, body: { success: false, message: msg } });
    const e = await fail(execSp('X'));
    assert.equal(e.code, 'server'); assert.doesNotMatch(e.message, /dbo|Msg 547|RequestError|PRIMARY|execProcedure|EXEC /); assert.match(e.message, /could not complete the request/); assert.equal(e.details, null);
  }
  assert.equal(looksLikeInternals('Only drafts can be edited'), false);
  assert.equal(buildError(500, { message: 'x'.repeat(400) }).message.length < 200, true, 'very long messages are not shown either');
});

test('network failure and timeout are typed; a non-JSON body is a parse error', async () => {
  const dead = createExecSp({ baseUrl: 'http://127.0.0.1:1', store: createAuthStore(), timeoutMs: 500 });
  assert.equal((await fail(dead('X'))).code, 'network');
  const slow = createExecSp({ baseUrl: base, store: (() => { const s = createAuthStore(); s.setAuthState('T1', null); return s; })(), timeoutMs: 50, fetchImpl: ((_u: string, i: RequestInit) => new Promise((_r, rej) => { (i.signal as AbortSignal).addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); })) as unknown as typeof fetch });
  assert.equal((await fail(slow('X'))).code, 'timeout');
  const bad = createExecSp({ baseUrl: base, store: createAuthStore(), fetchImpl: (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch });
  assert.equal((await fail(bad('X'))).code, 'parse');
});

test('protected files: the path segments are percent-encoded (a slash in a transaction number stays inside ONE segment)', () => {
  assert.equal(attachmentViewPath('TravelRequest', 'TR/2026/0048 bill #1.pdf'), '/api/attachment/view/TravelRequest/TR%2F2026%2F0048%20bill%20%231.pdf');
  assert.equal(attachmentViewPath('a/b', '../../etc/passwd'), '/api/attachment/view/a%2Fb/..%2F..%2Fetc%2Fpasswd');
});

test('protected files: fetched with the Bearer token (and refreshed on TOKEN_EXPIRED); 403 and 404 become typed errors; upload is explicitly unconfigured', async () => {
  const { execSp } = setup('OLD');
  const files = createFileClient({ baseUrl: base, authedFetch: authedFetchOf(execSp) });
  const blob = await files.fetchAttachment('TravelRequest', 'TR/2026/0048.pdf');
  assert.equal(await blob.text(), '%PDF-1.4 hello'); assert.equal(blob.type, 'application/pdf');
  assert.equal(refreshCalls, 1);
  const got = seen.filter((s) => s.url.startsWith('/api/attachment/view/')).at(-1)!;
  assert.deepEqual([got.url, got.auth], ['/api/attachment/view/TravelRequest/TR%2F2026%2F0048.pdf', 'Bearer T2']);
  const e = await fail(files.fetchAttachment('TravelRequest', 'secret-other.pdf'));
  assert.deepEqual([e.code, e.message], ['forbidden', 'Not allowed']);
  const nf = await fail(files.fetchAttachment('TravelRequest', 'missing-file.pdf'));
  assert.deepEqual([nf.code, nf.message, nf.status], ['not_found', 'File not found', 404]);
  const p = await files.openPreview('TravelRequest', 'a.pdf');
  assert.match(p.url, /^blob:/); p.revoke();
});
