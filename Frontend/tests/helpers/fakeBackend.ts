import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ServerEngine } from './engine/serverEngine.ts';
import { ApiError } from '../../src/services/apiClient.ts';
import { SP } from '../../src/services/spContract.ts';
import { EXPECTED_SCHEMA_REV, SCHEMA_SCRIPTS } from '../../src/config/schemaRev.ts';
import { loadReferenceSchema } from './referenceData.ts';
import type { ReferenceData } from '../../src/types/domain.ts';

/**
 * A fake of the EXISTING Express backend, following its source (routes/auth.js, routes/execute.js, middleware/auth.js, spWhitelist.js,
 * execProcedure.js) closely enough to drive the real frontend end to end:
 *  - POST /api/auth/login|refresh|logout|change-password|forgot-password|reset-password, GET /api/auth/magic-login
 *  - httpOnly cookie hrms_refresh_token (Path=/api/auth, SameSite=Strict), rotated on refresh; reuse revokes everything
 *  - POST /api/execute: Bearer check (401 TOKEN_EXPIRED), whitelist (403), `ExecutedBy` forced from the token, errors as HTTP 500 {message}
 *  - TA_usp_UploadAttachment handled by name (base64 -> stored file), GET /api/attachment/view/:docType/:fileName
 * Business logic = the in-memory ServerEngine (the same rules the SPs must implement). It is NOT SQL Server.
 */
const USERS: Record<string, { pw: string; name: string; role: string; demo: 'employee' | 'admin'; mustChange?: boolean; locked?: boolean }> = {
  '800001': { pw: 'Passw0rd!x1', name: 'Karthik R', role: 'Employee', demo: 'employee' },
  '700010': { pw: 'Adm1n#Pass99', name: 'Priya Natarajan', role: 'Admin', demo: 'admin' },
  '800002': { pw: 'Temp#Pass123', name: 'Mani Bharathi', role: 'Employee', demo: 'employee', mustChange: true },
  '800009': { pw: 'Locked#Pass1', name: 'Locked User', role: 'Employee', demo: 'employee', locked: true },
};
const WHITELIST = new Set<string>(Object.values(SP));
const policyOk = (p: string): boolean => p.length >= 10 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[^A-Za-z0-9]/.test(p);

export interface FakeBackend {
  url: string; close: () => void;
  stats: { logins: number; refreshes: number; executes: number; viewAuth: Array<string | undefined>; lastExecute: Record<string, unknown> | null };
  setAccessTtl(ms: number): void; setSchemaStale(stale: boolean): void; setPolicy(o: { policy?: Record<string, unknown> }): void; setReferenceEdit(edit: ((d: ReferenceData) => void) | null): void; revokeAllRefresh(): void; failNext(status: number, message: string): void;
  storedFile(docType: string, name: string): Buffer | undefined; reset(): void;
}

export async function startFakeBackend(port: number): Promise<FakeBackend> {
  let gw = new ServerEngine({ now: () => new Date(2026, 9, 15, 10, 0, 0), newId: (() => { let n = 0; return () => `fb-${++n}`; })() });
  let accessTtl = 60_000;
  const access = new Map<string, { employeeId: string; exp: number }>();
  const refresh = new Map<string, { employeeId: string; revoked: boolean }>();
  const files = new Map<string, Buffer>();
  const stats: FakeBackend['stats'] = { logins: 0, refreshes: 0, executes: 0, viewAuth: [], lastExecute: null };
  let failNext: { status: number; message: string } | null = null;
  let schemaStale = false;
  let policyOverride: { policy?: Record<string, unknown> } = {};
  let referenceEdit: ((d: ReferenceData) => void) | null = null;   // lets a test change what 'the database' returns as reference data
  loadReferenceSchema();                                          // the engine's business rules read expense types/items from the registry
  const passwords: Record<string, string> = Object.fromEntries(Object.entries(USERS).map(([k, v]) => [k, v.pw]));

  const server = http.createServer((req, res) => {
    const origin = String(req.headers.origin ?? '');
    const cors: Record<string, string> = { 'Access-Control-Allow-Origin': origin || '*', 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': 'content-type, authorization', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', Vary: 'Origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const send = (status: number, body: unknown, extra: Record<string, string | string[]> = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...cors, ...extra }); res.end(JSON.stringify(body)); };
      const url = new URL(req.url ?? '/', 'http://x');
      let body: Record<string, any> = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { body = {}; }
      const cookieOf = (name: string): string | undefined => String(req.headers.cookie ?? '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];
      const issue = (employeeId: string): { token: string; setCookie: string } => {
        const token = 'AT-' + crypto.randomUUID(); access.set(token, { employeeId, exp: Date.now() + accessTtl });
        const rt = crypto.randomBytes(24).toString('hex'); refresh.set(rt, { employeeId, revoked: false });
        return { token, setCookie: `hrms_refresh_token=${rt}; Path=/api/auth; HttpOnly; SameSite=Strict` };
      };
      const userOf = (id: string) => ({ employeeId: id, name: USERS[id]?.name, role: USERS[id]?.role });
      const bearer = (): { employeeId: string } | 'expired' | null => {
        const h = String(req.headers.authorization ?? ''); const t = h.startsWith('Bearer ') ? h.slice(7) : null;
        if (!t) return null; const a = access.get(t); if (!a) return null; return a.exp < Date.now() ? 'expired' : { employeeId: a.employeeId };
      };
      const needAuth = (): { employeeId: string } | null => {
        const b = bearer();
        if (b === 'expired') { send(401, { success: false, message: 'Access token expired', code: 'TOKEN_EXPIRED' }); return null; }
        if (!b) { send(401, { success: false, message: 'Unauthorized' }); return null; }
        return b;
      };
      try {
        /* ------------------------------ auth ------------------------------ */
        if (url.pathname === '/api/auth/login' && req.method === 'POST') {
          const u = USERS[String(body.employeeId)];
          if (!body.employeeId || !body.password) return send(400, { success: false, message: 'Employee ID and password are required.' });
          if (u?.locked) return send(423, { success: false, message: 'Account temporarily locked until 11:00:00 AM.' });
          if (!u || passwords[String(body.employeeId)] !== body.password) return send(401, { success: false, message: 'Invalid employee ID or password.' });
          stats.logins++; const { token, setCookie } = issue(String(body.employeeId));
          return send(200, { success: true, data: { accessToken: token, user: { ...userOf(String(body.employeeId)), mustChangePassword: !!u.mustChange } } }, { 'Set-Cookie': setCookie });
        }
        if (url.pathname === '/api/auth/refresh' && req.method === 'POST') {
          const rt = cookieOf('hrms_refresh_token'); stats.refreshes++;
          if (!rt) return send(401, { success: false, message: 'No refresh token.' });
          const st = refresh.get(rt);
          if (!st) return send(401, { success: false, message: 'Invalid refresh token.' });
          if (st.revoked) { for (const v of refresh.values()) if (v.employeeId === st.employeeId) v.revoked = true; return send(401, { success: false, message: 'Session invalidated, please log in again.' }, { 'Set-Cookie': 'hrms_refresh_token=; Path=/api/auth; Max-Age=0' }); }
          st.revoked = true; const { token, setCookie } = issue(st.employeeId);
          return send(200, { success: true, data: { accessToken: token, user: userOf(st.employeeId) } }, { 'Set-Cookie': setCookie });
        }
        if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
          const rt = cookieOf('hrms_refresh_token'); const st = rt ? refresh.get(rt) : undefined; if (st) st.revoked = true;
          return send(200, { success: true, message: 'Logged out.' }, { 'Set-Cookie': 'hrms_refresh_token=; Path=/api/auth; Max-Age=0' });
        }
        if (url.pathname === '/api/auth/change-password' && req.method === 'POST') {
          const a = needAuth(); if (!a) return;
          if (!body.currentPassword || !body.newPassword) return send(400, { success: false, message: 'Current and new password are required.' });
          if (!policyOk(String(body.newPassword))) return send(400, { success: false, message: 'Must be at least 10 characters long.' });
          if (passwords[a.employeeId] !== body.currentPassword) return send(401, { success: false, message: 'Current password is incorrect.' });
          passwords[a.employeeId] = String(body.newPassword); if (USERS[a.employeeId]) USERS[a.employeeId]!.mustChange = false;
          for (const v of refresh.values()) if (v.employeeId === a.employeeId) v.revoked = true;
          return send(200, { success: true, message: 'Password changed. Please log in again.' }, { 'Set-Cookie': 'hrms_refresh_token=; Path=/api/auth; Max-Age=0' });
        }
        if (url.pathname === '/api/auth/forgot-password' && req.method === 'POST') return send(200, { success: true, message: 'If that account exists, a reset link has been sent to its email.' });
        if (url.pathname === '/api/auth/reset-password' && req.method === 'POST') {
          if (!body.token || !body.newPassword) return send(400, { success: false, message: 'Token and new password are required.' });
          if (!policyOk(String(body.newPassword))) return send(400, { success: false, message: 'Must be at least 10 characters long.' });
          if (body.token === 'used-token') return send(400, { success: false, message: 'This reset link has already been used or is no longer valid.' });
          if (body.token !== 'good-token') return send(400, { success: false, message: 'This reset link is invalid.' });
          return send(200, { success: true, message: 'Password reset. You can now log in.' });
        }
        if (url.pathname === '/api/auth/magic-login' && req.method === 'GET') {
          if (url.searchParams.get('guid') !== 'good-guid') return send(401, { success: false, message: 'This login link is invalid, used, or expired.' });
          const { token, setCookie } = issue('800001');
          return send(200, { success: true, data: { accessToken: token, user: userOf('800001'), transactionNo: '800001/2026/0105' } }, { 'Set-Cookie': setCookie });
        }
        /* ----------------------------- files ----------------------------- */
        if (url.pathname.startsWith('/api/attachment/view/') && req.method === 'GET') {
          stats.viewAuth.push(req.headers.authorization);
          const a = needAuth(); if (!a) return;
          const [docType = '', fileName = ''] = url.pathname.slice('/api/attachment/view/'.length).split('/').map(decodeURIComponent);
          const f = files.get(`${docType.toUpperCase()}/${fileName}`);
          if (!f) return send(404, { success: false, message: 'File not found' });
          res.writeHead(200, { 'Content-Type': fileName.endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream', ...cors }); return res.end(f);
        }
        /* ----------------------------- execute ----------------------------- */
        if (url.pathname === '/api/execute' && req.method === 'POST') {
          const a = needAuth(); if (!a) return;
          stats.executes++;
          if (failNext) { const f = failNext; failNext = null; return send(f.status, { success: false, message: f.message }); }
          const { spName, params } = body as { spName?: string; params?: Record<string, any> };
          if (!spName) return send(400, { success: false, message: 'spName is required' });
          if (!WHITELIST.has(spName)) return send(403, { success: false, message: `Stored procedure '${spName}' is not permitted` });
          const P: Record<string, any> = { ...(params ?? {}), ExecutedBy: a.employeeId }; // identity is forced from the token, never the body
          stats.lastExecute = P;
          const u = USERS[a.employeeId];
          // ActAs='employee' can only NARROW an approver to the employee experience; the session still reports the capability.
          const asEmployee = P.ActAs === 'employee' && spName !== SP.getSession;
          gw.setSession(u?.demo === 'admin' && asEmployee ? 'employee' : (u?.demo ?? 'employee'));
          try {
            let data: unknown = null;
            switch (spName) {
              case SP.getSession: {
                // What TA_usp_GetSession returns: the person plus the installed script revisions (a stale database misses or has older stamps).
                const schema = Object.fromEntries(SCHEMA_SCRIPTS.map((n) => [n, EXPECTED_SCHEMA_REV]));
                if (schemaStale) { delete (schema as Record<string, string>)['07_procs_receipts']; (schema as Record<string, string>)['05_procs_requests'] = '2026-10-01-a'; }
                data = { ...(await gw.getSession()), schema }; break;
              }
              case SP.getPolicy: { const snap = await gw.getPolicy(); data = { policy: { ...(snap?.policy ?? {}), ...(policyOverride.policy ?? {}) } }; break; }
              case SP.getLocationPolicyLimit: data = null; break; // No location rules are configured in the fake backend.
              case SP.getReferenceData: { const d = structuredClone(await gw.getReferenceData()); if (referenceEdit) referenceEdit(d); data = d; break; }
              case SP.getApprovalTrail: data = await gw.getApprovalTrail(P.Kind, P.Id); break;
              case SP.listRequests: data = await gw.listRecords({ kind: P.Kind, employeeCode: P.EmployeeCode, status: P.Status, search: P.Search, from: P.From, to: P.To, page: P.Page, pageSize: P.PageSize, sortKey: P.SortKey, sortDir: P.SortDir }); break;
              case SP.getRequest: data = await gw.getRecord(P.Kind, P.Id); break;
              case SP.saveRequestDraft: data = await gw.saveDraft({ ...P.Request, kind: P.Kind }); break;
              case SP.submitRequest: data = await gw.submit(P.Kind, P.Id); break;
              case SP.deleteDraft: await gw.deleteDraft(P.Kind, P.Id); break;
              case SP.copyRejectedClaim: data = await gw.copyRejectedClaim(P.Id); break;
              case SP.approveRequest: data = await gw.approve(P.Kind, P.Id, { lines: P.Lines, approverComments: P.ApproverComments, approverRemarks: P.ApproverRemarks }); break;
              case SP.rejectRequest: data = await gw.reject(P.Kind, P.Id, { lines: P.Lines, approverComments: P.ApproverComments, approverRemarks: P.ApproverRemarks, rejectionReason: P.RejectionReason }); break;
              case SP.listPendingApprovals: data = await gw.listPendingApprovals(); break;
              case SP.listApprovalHistory: data = await gw.listApprovalHistory(P.Days); break;
              case SP.listReceipts: data = await gw.listReceipts(); break;
              case SP.createReceipts: data = await gw.uploadReceipts((P.Files as Array<{ Name: string; Size: number; Type: string }>).map((f) => new File([new Uint8Array(f.Size)], f.Name, { type: f.Type }))); break;
              case SP.updateReceipt: data = await gw.updateReceipt(P.Receipt); break;
              case SP.deleteReceipt: await gw.deleteReceipt(P.Id); break;
              case SP.lookupEmployees: data = await gw.lookupEmployees(P.Query); break;
              case SP.uploadAttachment: { // like execProcedure.saveAttachment: base64 -> a file on disk, then the SP result
                if (!P.Base64Content) throw new Error('Base64Content is required.');
                const stored = `${String(P.ExecutedBy).replace(/[^\w]/g, '')}_${Date.now()}_${crypto.randomUUID().replace(/-/g, '')}${String(P.FileName).slice(String(P.FileName).lastIndexOf('.'))}`;
                files.set(`${String(P.DocType).toUpperCase()}/${stored}`, Buffer.from(String(P.Base64Content), 'base64'));
                data = { storedFileName: stored }; break;
              }
              default: throw new Error(`no handler for ${spName}`);
            }
            return send(200, { success: true, data, message: 'OK' });
          } catch (e) {
            // A THROW in an SP reaches the browser as HTTP 500 with the message; business errors carry the [CODE] prefix of docs/05-sp-contract.md.
            const msg = e instanceof ApiError ? `[${e.code.toUpperCase()}] ${e.message}` : String(e instanceof Error ? e.message : e);
            return send(500, { success: false, message: msg });
          }
        }
        send(404, { success: false, message: 'Not found' });
      } catch (e) { send(500, { success: false, message: 'Internal server error' }); }
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), stats,
    setAccessTtl: (ms) => { accessTtl = ms; },
    setSchemaStale: (v) => { schemaStale = v; },
    setPolicy: (o) => { policyOverride = o; },
    setReferenceEdit: (f) => { referenceEdit = f; },
    revokeAllRefresh: () => { for (const v of refresh.values()) v.revoked = true; },
    failNext: (status, message) => { failNext = { status, message }; },
    storedFile: (d, n) => files.get(`${d.toUpperCase()}/${n}`),
    reset: () => { gw = new ServerEngine({ now: () => new Date(2026, 9, 15, 10, 0, 0) }); access.clear(); refresh.clear(); files.clear(); accessTtl = 60_000; failNext = null; schemaStale = false; policyOverride = {}; referenceEdit = null; stats.logins = stats.refreshes = stats.executes = 0; stats.viewAuth = []; for (const [k, v] of Object.entries(USERS)) passwords[k] = v.pw; USERS['800002']!.mustChange = true; },
  };
}
