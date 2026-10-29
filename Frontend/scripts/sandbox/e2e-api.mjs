// SANDBOX-ONLY: runs the REAL frontend in api mode (VITE_DATA_MODE=api) in headless Chromium against a fake of the existing Express backend
// (tests/helpers/fakeBackend.ts). Run: npm run sandbox:e2e:api
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startFakeBackend } from '../../tests/helpers/fakeBackend.ts';
const G = process.env.GLOBAL_NODE_MODULES ?? '/home/claude/.npm-global/lib/node_modules';
const { chromium } = createRequire(G + '/x.js')('playwright');
const root = path.resolve(import.meta.dirname, '../..');
const dist = path.join(root, 'dist-api');
const fx = (n) => path.join(root, 'tests/fixtures/receipts', n);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json' };

const backend = await startFakeBackend(4300);
// Static server with SPA fallback (so /reset-password?token=... serves the app, like Vite's dev/preview server).
const web = http.createServer((req, res) => {
  const p = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let f = path.join(dist, p === '/' ? '/index.html' : p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${web.address().port}`;
const browser = await chromium.launch();

const T = (id) => `[data-testid="${id}"]`;
const results = [];
async function scenario(name, fn, opts = {}) {
  backend.reset();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00'));
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (400|401|403|404|423|500) /.test(m.text()) && !(opts.allowConsole && opts.allowConsole.test(m.text())) && !/fonts\.(googleapis|gstatic)|ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION)/.test(m.text() + (m.location()?.url ?? ''))) problems.push('console.error: ' + m.text()); });
  try {
    await fn(page, ctx);
    if (problems.length) throw new Error('browser problems:\n  ' + problems.join('\n  '));
    results.push({ name, ok: true }); console.log('ok   -', name);
  } catch (e) {
    results.push({ name, ok: false }); console.log('FAIL -', name, '\n      ', String(e.message).split('\n').slice(0, 6).join('\n       '));
    await page.screenshot({ path: path.join(root, 'docs/screens', 'FAIL-api-' + name.replace(/\W+/g, '_').slice(0, 40) + '.png') }).catch(() => {});
  }
  await ctx.close();
}
const openApp = async (page, p = '/') => { await page.goto(base + p); await page.waitForSelector(`${T('login-submit')}, ${T('account-button')}, ${T('auth-card')}, .tc-alert`); };
const signIn = async (page, id, pw) => { await page.fill(T('login-id'), id); await page.fill(T('login-password'), pw); await page.click(T('login-submit')); };
const greeting = (page, re) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('h1.tc-page-title')?.textContent ?? ''), re.source);
const loginAs = async (page, id = '800001', pw = 'Passw0rd!x1', who = /Karthik/) => { await openApp(page); await signIn(page, id, pw); await greeting(page, who); };

await scenario('signed out: the app shows sign-in and no data; empty and wrong credentials are explained', async (page) => {
  await openApp(page); await page.waitForSelector(T('login-submit'));
  assert.equal(await page.locator('.tc-kpi').count(), 0);
  await page.click(T('login-submit')); assert.match(await page.textContent(T('login-error')), /Enter your employee ID and password/);
  await signIn(page, '800001', 'wrong-password');
  await page.waitForFunction(() => /Invalid employee ID or password/.test(document.querySelector('[data-testid="login-error"]')?.textContent ?? ''));
  assert.equal(await page.inputValue(T('login-password')), '', 'the password is cleared after a failed attempt');
  assert.equal(backend.stats.executes, 0, 'no data call is made while signed out');
  await signIn(page, '800009', 'Locked#Pass1');
  await page.waitForFunction(() => /temporarily locked/.test(document.querySelector('[data-testid="login-error"]')?.textContent ?? ''));
});

await scenario('employee signs in: dashboard loads through /api/execute (TA_ procedures only, no identity in the body)', async (page) => {
  await loginAs(page);
  await page.waitForSelector('table[data-testid="claims-table"]');
  assert.equal(await page.locator('table[data-testid="claims-table"] tbody tr').count(), 6);
  assert.match(await page.textContent(T('kpi-claimed')), /₹17,608\.00/);
  assert.ok(backend.stats.executes > 3);
  // The server forces ExecutedBy from the token; the browser never sends who it is.
  assert.equal(backend.stats.lastExecute.ExecutedBy, '800001');
  assert.equal(backend.stats.lastExecute.RequestedBy, undefined);
  assert.equal(await page.locator(T('stale-scripts')).count(), 0, 'no out-of-date banner when the database matches the app');
});

await scenario('reload keeps you signed in (session restored from the httpOnly refresh cookie); sign out ends it, even after a reload', async (page) => {
  await loginAs(page);
  const before = backend.stats.refreshes;
  await page.reload(); await greeting(page, /Karthik/);
  assert.equal(backend.stats.refreshes, before + 1, 'one refresh restored the session');
  assert.equal(await page.locator(T('login-submit')).count(), 0);
  await page.click(T('account-button')); await page.click(T('sign-out'));
  await page.waitForSelector(T('login-submit')); assert.match(await page.textContent('.tc-alert'), /signed out/);
  await page.reload(); await page.waitForSelector(T('login-submit'));
  assert.equal(await page.locator('.tc-kpi').count(), 0, 'no data after sign-out');
});

await scenario('an expired access token is refreshed silently: the user is not interrupted', async (page) => {
  backend.setAccessTtl(1200); await loginAs(page);
  await page.waitForTimeout(1800); // the access token is now expired
  const before = backend.stats.refreshes;
  await page.click(T('tab-travel')); await page.waitForSelector('table[data-testid="travel-table"]');
  assert.equal(await page.locator('table[data-testid="travel-table"] tbody tr').count(), 2);
  assert.ok(backend.stats.refreshes >= before + 1, 'refreshed via the cookie');
  assert.equal(await page.locator(T('login-submit')).count(), 0);
});

await scenario('when the session cannot be refreshed (revoked) the user is returned to sign-in with an explanation', async (page) => {
  backend.setAccessTtl(1000); await loginAs(page);
  backend.revokeAllRefresh(); await page.waitForTimeout(1500);
  await page.click(T('tab-travel'));
  await page.waitForSelector(T('login-submit'));
  assert.match(await page.textContent('.tc-alert'), /session has ended/);
});

await scenario('approver signs in: approvals queue works; an employee cannot open it', async (page) => {
  await loginAs(page, '700010', 'Adm1n#Pass99', /Priya/);
  await page.waitForSelector(T('kpi-pending')); assert.match(await page.textContent(T('kpi-pending')), /10.*6 claims · 2 travel · 2 advance/);
  await page.goto(`${base}/#/approvals`); await page.waitForSelector(T('queue-table'));
  assert.equal(await page.locator(`${T('queue-table')} tbody tr`).count(), 10);
  // approve one through the real transport
  await page.locator(`${T('queue-table')} tbody tr`, { hasText: '800003/2026/0004' }).click(); await page.waitForSelector(T('approve'));
  await page.click(T('autofill')); await page.click(T('approve')); await page.click(T('confirm-ok'));
  await page.waitForFunction(() => /Approved by Priya Natarajan/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  await page.click(T('account-button')); await page.click(T('sign-out')); await page.waitForSelector(T('login-submit'));
  await signIn(page, '800001', 'Passw0rd!x1'); await greeting(page, /Karthik/);
  await page.goto(`${base}/#/approvals`); await page.waitForTimeout(600);
  assert.match(page.url(), /#\/dashboard$/);
});

await scenario('files: upload goes through TA_usp_UploadAttachment (base64), the stored file opens in a new tab via the protected route with the token', async (page, ctx) => {
  await loginAs(page);
  await page.goto(`${base}/#/claims/new`); await page.waitForSelector(T('add-expense'));
  await page.selectOption(T('expense-type'), 'local'); await page.fill(T('purpose'), 'Lunch with client');
  await page.click(T('add-expense')); await page.selectOption(T('line-item'), 'l_food_lunch');
  const bytes = fs.readFileSync(fx('restaurant_scan.pdf'));
  await page.setInputFiles(T('line-file'), [{ name: 'lunch-bill.pdf', mimeType: 'application/pdf', buffer: bytes }]);
  await page.waitForSelector(`${T('line-modal')} ${T('open-attachment')}`); // an uploaded (stored) file is openable
  assert.equal(backend.stats.lastExecute.DocType, 'TA_CLAIM');
  await page.fill(T('line-date'), '2026-10-05'); await page.fill(T('line-billerName'), 'Truffles'); await page.fill(T('line-amount'), '420');
  await page.click(T('line-save')); await page.waitForSelector('#modal-root[hidden]', { state: 'attached' });
  await page.click(T('save-draft')); await page.waitForFunction(() => /^800001\/2026\/\d{4}$/.test(document.querySelector('[data-testid="page-title"]')?.textContent ?? ''));
  // reload: the attachment metadata (stored name + docType) came back from the server
  await page.reload(); await page.waitForSelector(T('items-table'));
  // Headless Chromium has no PDF viewer, so a PDF blob is downloaded instead of displayed; either way the delivered bytes are what counts.
  let download = null;
  ctx.on('page', (p) => p.on('download', (d) => { download = d; }));
  const [tab] = await Promise.all([ctx.waitForEvent('page'), page.click(`${T('items-table')} ${T('open-attachment')}`)]);
  await page.waitForFunction(() => true); // let the click settle
  const deadline = Date.now() + 8000;
  while (!download && !tab.url().startsWith('blob:') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  let delivered;
  if (download) delivered = fs.readFileSync(await download.path());
  else delivered = Buffer.from(await tab.evaluate(() => fetch(location.href).then((r) => r.arrayBuffer()).then((b) => Array.from(new Uint8Array(b)))));
  assert.equal(delivered.length, bytes.length, 'the preview delivers exactly the uploaded bytes');
  assert.ok(delivered.equals(bytes), 'byte-for-byte identical');
  assert.ok(backend.stats.viewAuth.length >= 1 && backend.stats.viewAuth.every((h) => /^Bearer AT-/.test(h ?? '')), 'the file route is only ever called with the access token');
  await tab.close().catch(() => {});
});

await scenario('an approver can also act as an employee: View-as switch, receipt box in the employee view, choice kept after reload; plain employees get no switch', async (page) => {
  await loginAs(page, '700010', 'Adm1n#Pass99', /Priya/);
  await page.waitForSelector(T('view-switch'));
  assert.equal(await page.inputValue(T('view-switch')), 'admin', 'an approver starts in the approver view');
  assert.equal(await page.locator(T('receipt-box-link')).count(), 0, 'the approver view has no receipt box');
  await page.selectOption(T('view-switch'), 'employee');
  await page.waitForSelector(T('receipt-box-link'));
  await page.waitForSelector(T('kpi-claimed'));                          // the employee dashboard (employee KPIs)
  assert.equal(backend.stats.lastExecute.ActAs, 'employee', 'the app tells the server which view it is acting in');
  assert.match(await page.textContent('.tc-toast'), /Now viewing as Employee/);
  await page.goto(`${base}/#/receipts`); await page.waitForSelector(T('receipt-rcpt-1'));       // not redirected: the receipt box is open in the employee view
  await page.goto(`${base}/#/approvals`); await page.waitForFunction(() => location.hash === '#/dashboard');   // the approvals queue is not available in the employee view
  await page.goto(`${base}/#/receipts`); await page.waitForSelector(T('receipt-rcpt-1'));
  await page.reload(); await page.waitForSelector(T('receipt-rcpt-1'));
  assert.equal(await page.inputValue(T('view-switch')), 'employee', 'the chosen view survives a reload');
  await page.selectOption(T('view-switch'), 'admin');
  await page.waitForSelector(T('kpi-pending'));
  assert.equal(await page.locator(T('receipt-box-link')).count(), 0);
  await page.goto(`${base}/#/receipts`); await page.waitForFunction(() => location.hash === '#/dashboard');       // the receipt box is not available in the approver view
  await page.goto(`${base}/#/approvals`); await page.waitForSelector(T('queue-table'));
  assert.equal(backend.stats.lastExecute.ActAs, undefined, 'back in the approver view no narrowing hint is sent');
  await page.click(T('account-button')); await page.click(T('sign-out')); await page.waitForSelector(T('login-submit'));
  await signIn(page, '800001', 'Passw0rd!x1'); await greeting(page, /Karthik/);
  assert.equal(await page.locator(T('view-switch')).count(), 0, 'a person who is not an approver has no switch');
  assert.equal(backend.stats.lastExecute.ActAs, undefined);
});

await scenario('a database whose scripts are older than the app is reported by name, so nothing fails mysteriously', async (page) => {
  backend.setSchemaStale(true);
  await loginAs(page);
  await page.waitForSelector(T('stale-scripts'));
  const t = await page.textContent(T('stale-scripts'));
  assert.match(t, /05_procs_requests\.sql/); assert.match(t, /07_procs_receipts\.sql/); assert.doesNotMatch(t, /01_tables|03_functions|04_procs/);
  await page.waitForSelector('table[data-testid="claims-table"]', { timeout: 8000 });   // the app still works; the banner explains what to re-run
});

await scenario('policy comes from the database: a limit changed in the reference data is the limit shown on the claim line', async (page) => {
  backend.setReferenceEdit((d) => { d.types.find((t) => t.key === 'outside').items.find((i) => i.key === 'o_lodge').limit = 3500; });
  await loginAs(page);
  await page.goto(`${base}/#/claims/new`); await page.waitForSelector(T('add-expense'));
  await page.selectOption(T('expense-type'), 'outside');
  await page.click(T('add-expense')); await page.selectOption(T('line-item'), 'o_lodge');
  await page.waitForFunction(() => /₹3,500 per night/.test(document.querySelector('[data-testid="line-modal"]')?.textContent ?? ''));
  assert.doesNotMatch(await page.textContent(T('line-modal')), /₹3,000 per night/);
});

await scenario('server errors: business errors keep their message and class; SQL internals never reach the screen', async (page) => {
  await loginAs(page);
  await page.goto(`${base}/#/claims/does-not-exist`); await page.waitForSelector(T('not-found')); // "[NOT_FOUND] Record not found" arrives as HTTP 500
  backend.failNext(500, "Invalid object name 'dbo.TA_Receipts'.");
  await page.goto(`${base}/#/receipts`); await page.waitForSelector('.tc-alert--error');
  const t = await page.textContent('.tc-alert--error');
  assert.doesNotMatch(t, /dbo|Invalid object|TA_Receipts/); assert.match(t, /could not complete the request/);
}, { allowConsole: /500/ });

await scenario('forgot password: generic confirmation; reset link page enforces the policy and shows the server message', async (page) => {
  await openApp(page); await page.click(T('forgot-link')); await page.fill(T('forgot-id'), '800001'); await page.click(T('forgot-submit'));
  await page.waitForSelector(T('forgot-done')); assert.match(await page.textContent(T('forgot-done')), /If that account exists/);
  await openApp(page, '/reset-password?token=good-token'); await page.waitForSelector(T('reset-submit'));
  await page.fill(T('new-password'), 'abc'); assert.match(await page.textContent('.tc-helper--warning'), /at least 10 characters/);
  await page.fill(T('confirm-password'), 'abd'); await page.click(T('reset-submit')); assert.match(await page.textContent(T('reset-error')), /at least 10/);
  await page.fill(T('new-password'), 'Str0ng#Password1'); await page.fill(T('confirm-password'), 'Different#Pass1'); await page.click(T('reset-submit')); assert.match(await page.textContent(T('reset-error')), /do not match/);
  await page.fill(T('confirm-password'), 'Str0ng#Password1'); await page.click(T('reset-submit')); await page.waitForSelector(T('reset-done'));
  await page.click(T('reset-signin')); await page.waitForSelector(T('login-submit')); assert.equal(new URL(page.url()).pathname, '/', 'the reset path is removed');
  await openApp(page, '/reset-password?token=used-token'); await page.fill(T('new-password'), 'Str0ng#Password1'); await page.fill(T('confirm-password'), 'Str0ng#Password1'); await page.click(T('reset-submit'));
  await page.waitForFunction(() => /already been used/.test(document.querySelector('[data-testid="reset-error"]')?.textContent ?? ''));
});

await scenario('change password: wrong current password is refused; success ends every session and the new password works', async (page) => {
  await loginAs(page);
  await page.click(T('account-button')); await page.click(T('change-password')); await page.waitForSelector(T('change-password-modal'));
  await page.fill(T('current-password'), 'not-my-password'); await page.fill(T('new-password'), 'N3w#Password99'); await page.fill(T('confirm-password'), 'N3w#Password99'); await page.click(T('change-submit'));
  await page.waitForFunction(() => /Current password is incorrect/.test(document.querySelector('[data-testid="change-error"]')?.textContent ?? ''));
  await page.fill(T('current-password'), 'Passw0rd!x1'); await page.click(T('change-submit'));
  await page.waitForSelector(T('login-submit')); assert.match(await page.textContent('.tc-alert'), /Password changed/);
  await signIn(page, '800001', 'Passw0rd!x1'); await page.waitForFunction(() => /Invalid employee/.test(document.querySelector('[data-testid="login-error"]')?.textContent ?? ''));
  await signIn(page, '800001', 'N3w#Password99'); await greeting(page, /Karthik/);
});

await scenario('an account that must change its password is stopped at a change-password screen before any data', async (page) => {
  await openApp(page); await signIn(page, '800002', 'Temp#Pass123');
  await page.waitForSelector(T('change-submit')); assert.match(await page.textContent(T('auth-card')), /Choose a new password/);
  assert.equal(backend.stats.executes, 1, 'only the session call ran (to learn the user), no screen data');
  await page.fill(T('current-password'), 'Temp#Pass123'); await page.fill(T('new-password'), 'Fresh#Password77'); await page.fill(T('confirm-password'), 'Fresh#Password77'); await page.click(T('change-submit'));
  await page.waitForSelector(T('login-submit')); await signIn(page, '800002', 'Fresh#Password77'); await page.waitForSelector('h1.tc-page-title');
});

await scenario('magic link: signs in, removes the one-time token from the address bar and opens the request it points to', async (page) => {
  await openApp(page, '/?guid=good-guid');
  await page.waitForFunction(() => document.querySelector('[data-testid="page-title"]')?.textContent === '800001/2026/0105', null, { timeout: 8000 });
  assert.ok(!page.url().includes('guid='));
  await openApp(page, '/?guid=bad-guid').catch(() => {});
});

await browser.close(); web.close(); backend.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} api-mode browser scenarios passed`);
process.exit(failed.length ? 1 : 0);
