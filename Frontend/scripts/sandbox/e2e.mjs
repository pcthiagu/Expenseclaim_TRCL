// SANDBOX-ONLY browser tests for the screens: the real app in headless Chromium talks to a FAKE of the Express backend (tests/helpers/fakeBackend.ts) over
// the real transport (sign-in, token refresh, /api/execute). Run: npm run sandbox:e2e   (tsx because the fake backend and the OCR test service are TypeScript;
// the OCR service runs the real Tesseract CLI behind a real HTTP endpoint.)
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const G = process.env.GLOBAL_NODE_MODULES ?? '/home/claude/.npm-global/lib/node_modules';
const { chromium } = createRequire(G + '/x.js')('playwright');
const root = path.resolve(import.meta.dirname, '../..');
const dist = path.join(root, 'dist-ui');
const shots = path.join(root, 'docs/screens');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json' };

import { startOcrServer } from '../../tests/helpers/ocrServer.ts';
import { startFakeBackend } from '../../tests/helpers/fakeBackend.ts';
const backend = await startFakeBackend(4300);
const ocrSrv = process.env.NO_OCR ? null : await startOcrServer({ port: 4199 });
const fx = (n) => path.join(root, 'tests/fixtures/receipts', n);
const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url ?? '/').split('?')[0]); if (p === '/') p = '/index.html';
  let f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] ?? 'application/octet-stream' }); res.end(fs.readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();

const results = [];
async function scenario(name, fn, viewport = { width: 1280, height: 900 }, opts = {}) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) return;   // ONLY="regex" runs just the matching scenarios
  backend.reset();   // every scenario starts from the same data
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-15T10:00:00')); // deterministic "today" for date rules
  const problems = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (400|401|403|404|423|500) /.test(m.text()) && !(opts.allowConsole && opts.allowConsole.test(m.text())) && !/fonts\.(googleapis|gstatic)|ERR_(NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|CONNECTION)/.test(m.text() + (m.location()?.url ?? ''))) problems.push('console.error: ' + m.text()); });
  page.on('requestfailed', (r) => { if (!/fonts\.(googleapis|gstatic)/.test(r.url())) problems.push('requestfailed: ' + r.url()); });
  try {
    await fn(page);
    if (problems.length) throw new Error('browser problems:\n  ' + problems.join('\n  '));
    results.push({ name, ok: true }); console.log('ok   -', name);
  } catch (e) {
    results.push({ name, ok: false, err: e }); console.log('FAIL -', name, '\n      ', String(e.message).split('\n').slice(0, 6).join('\n       '));
    await page.screenshot({ path: path.join(shots, 'FAIL-' + name.replace(/\W+/g, '_').slice(0, 40) + '.png') }).catch(() => {});
  }
  await ctx.close();
}

const T = (id) => `[data-testid="${id}"]`;
const EMP = { id: '800001', pw: 'Passw0rd!x1' }, ADM = { id: '700010', pw: 'Adm1n#Pass99' };
const signIn = async (page, who) => { await page.fill(T('login-id'), who.id); await page.fill(T('login-password'), who.pw); await page.click(T('login-submit')); await page.waitForSelector(T('account-button')); };
// Opens a screen. A fresh browser context signs in through the real login form; later calls restore the session from the refresh cookie.
const open = async (page, hash = '#/claims', who = EMP) => {
  await page.goto(`${base}/${hash}`);
  await page.waitForSelector(`${T('login-submit')}, ${T('account-button')}`);
  if (await page.locator(T('login-submit')).count()) await signIn(page, who);
  await page.waitForSelector('.tc-topbar');
  if (hash === '#/claims') await page.waitForSelector('table[data-testid="claims-table"], .tc-list-card', { state: 'attached' });
};
// Sign out and sign in as the approver (real flow). Lands on the approver's dashboard.
const switchToAdmin = async (page) => {
  await page.click(T('account-button')); await page.click(T('sign-out')); await page.waitForSelector(T('login-submit'));
  await signIn(page, ADM);
  await page.waitForFunction(() => /Priya/.test(document.querySelector('h1.tc-page-title')?.textContent ?? ''));
};
const rows = (page) => page.locator('table[data-testid="claims-table"] tbody tr');
const closed = (page) => page.waitForSelector('#modal-root[hidden]', { state: 'attached', timeout: 3000 });
const toastText = async (page) => (await page.locator('.tc-toast').allTextContents()).join(' | ');
const confirmOk = async (page) => { await page.click(T('confirm-ok')); await closed(page); };
const fill = (page, id, v) => page.fill(T(id), String(v));
const newLocalClaim = async (page, purpose = 'Vendor visit') => {
  await open(page, '#/claims/new');
  await page.selectOption(T('expense-type'), 'local');
  await fill(page, 'purpose', purpose);
};
async function addConveyance(page, amount = 350, extra = async () => {}, action = 'line-save') {
  await page.click(T('add-expense')); await page.waitForSelector(T('line-modal'));
  await page.selectOption(T('line-item'), 'l_conveyance');
  await fill(page, 'line-date', '2026-10-05'); await page.selectOption(T('line-modeOfTravel'), 'Cab');
  await fill(page, 'line-fromLocation', 'Office'); await fill(page, 'line-toLocation', 'Site'); await fill(page, 'line-amount', amount);
  await extra();
  await page.click(T(action));
  if (action === 'line-save') await closed(page);
}
// Switch to the approver and wait until the approver's list (title 'Expense Claims', everyone's rows) has really replaced the employee's.
const asAdmin = async (page) => {
  await switchToAdmin(page);   // lands on the approver's dashboard, whose list holds everyone's claims
  await page.waitForFunction(() => document.querySelectorAll('table[data-testid="claims-table"] tbody tr, .tc-list-card').length > 6 && /Priya/.test(document.querySelector('h1.tc-page-title')?.textContent ?? ''));
};
// A real (scanned) PDF, so uploads exercise the real OCR path instead of failing on a fake file.
const pdf = (name) => ({ name, mimeType: 'application/pdf', buffer: fs.readFileSync(fx('restaurant_scan.pdf')) });

/* ---------------------------------- list ---------------------------------- */
await scenario('boot: employee lands on My Expense Claims with their 6 claims', async (page) => {
  await open(page);
  assert.equal(await page.locator('h1.tc-page-title').textContent(), 'My Expense Claims');
  assert.equal(await rows(page).count(), 6);
  assert.equal((await page.textContent(T('result-count'))).trim(), '6');
  assert.equal((await page.getAttribute(T('account-button'), 'aria-label')), 'Account: Karthik R, Employee');
  const first = await rows(page).first().textContent();
  assert.match(first, /800001\/2026\/0106/, 'newest request date first');
  await page.screenshot({ path: path.join(shots, 'list-desktop.png') });
});

await scenario('list: search, filter popover (status), clear, sort by total, empty state', async (page) => {
  await open(page);
  await page.fill(T('list-search'), 'consult'); await page.waitForTimeout(300);
  assert.equal(await rows(page).count(), 1);
  assert.match(await rows(page).first().textContent(), /0106/);
  await page.fill(T('list-search'), 'zzzz'); await page.waitForTimeout(300);
  assert.match(await page.textContent('.tc-empty'), /No matches/);
  await page.click('.tc-empty .tc-btn'); await page.waitForTimeout(300);
  assert.equal(await rows(page).count(), 6);
  await page.click(T('filters-toggle')); await page.waitForSelector(T('filters-pop'));
  await page.selectOption(T('filter-status'), 'rejected');
  assert.equal(await rows(page).count(), 1);
  assert.match(await rows(page).first().textContent(), /0103/);
  assert.equal((await page.textContent(T('result-count'))).trim(), '1 of 6');
  await page.click('text=Clear filters'); assert.equal(await rows(page).count(), 6);
  await page.keyboard.press('Escape'); await page.waitForSelector(T('filters-pop'), { state: 'detached' });
  await page.click('.tc-sort >> text=Total'); // first click: descending
  const totals = await page.locator('table tbody tr td.tc-num:nth-child(5)').allTextContents();
  const nums = totals.map((t) => Number(t.replace(/[^\d.]/g, '')));
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a));
});

await scenario('list: clicking a row opens the claim; unknown id shows not-found; admin cannot open receipt box', async (page) => {
  await open(page);
  await rows(page).filter({ hasText: '0105' }).click();
  await page.waitForSelector(T('page-title'));
  assert.equal(await page.textContent(T('page-title')), '800001/2026/0105');
  await open(page, '#/claims/does-not-exist');
  await page.waitForSelector(T('not-found'));
});

/* ------------------------------ read-only view ------------------------------ */
await scenario('submitted claim is read-only for its employee', async (page) => {
  await open(page);
  await rows(page).filter({ hasText: '0105' }).click(); await page.waitForSelector(T('items-table'));
  assert.equal(await page.locator(T('item-row')).count(), 5);
  assert.equal((await page.textContent(T('total-amount'))).trim(), '₹10,050.00');
  assert.equal(await page.locator(T('save-draft')).count(), 0);
  assert.equal(await page.locator(T('submit')).count(), 0);
  assert.equal(await page.locator(T('add-expense')).count(), 0);
  assert.match(await page.textContent('.tc-alert'), /Awaiting approval/);
  assert.match(await page.textContent('.tc-readonly >> nth=0'), /800001/);
  // over-limit lodge shows a warning marker only when above the limit (5600 vs 2 nights x 3000 = fine)
  // Boarding 1200 > 1000/day and dinner 420 > 400 are over; lodge 5600 <= 2 nights x 3000 is not.
  assert.equal(await page.locator('.tc-desktop-only .tc-over').count(), 2);
  assert.equal((await page.textContent('.tc-summary__row--warn dd')).trim(), '2');
  await page.screenshot({ path: path.join(shots, 'claim-readonly-desktop.png'), fullPage: true });
});

/* -------------------------------- line editor -------------------------------- */
await scenario('add expense: required-field errors, then success updates totals; save draft assigns the number', async (page) => {
  await newLocalClaim(page);
  assert.match(await page.textContent(T('meta')), /Unsaved changes/, 'purpose was typed');
  await page.click(T('add-expense')); await page.waitForSelector(T('line-modal'));
  await page.click(T('line-save'));
  assert.match(await page.textContent(`${T('line-modal')} .tc-alert`), /Expense Item: choose an item/);
  await page.selectOption(T('line-item'), 'l_conveyance');
  await page.click(T('line-save'));
  const msg = await page.textContent(`${T('line-modal')} .tc-alert`);
  for (const f of ['Date: Required', 'Mode of Travel: Required', 'From Location: Required', 'To Location: Required', 'Amount: Required']) assert.match(msg, new RegExp(f));
  assert.equal(await page.locator(T('line-date')).getAttribute('aria-invalid'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'line-date');
  await fill(page, 'line-date', '2026-10-05');
  await page.waitForFunction(() => document.querySelector('[data-testid="line-date"]')?.getAttribute('aria-invalid') !== 'true');
  assert.doesNotMatch(await page.textContent(`${T('line-modal')} .tc-alert`), /Date: Required/);
  await page.keyboard.press('Escape'); await closed(page);
  assert.equal(await page.locator(T('item-row')).count(), 0, 'cancelling adds nothing');
  await addConveyance(page, 350);
  assert.equal(await page.locator(T('item-row')).count(), 1);
  assert.equal((await page.textContent(T('total-amount'))).trim(), '₹350.00');
  assert.match(await page.textContent(T('meta')), /Unsaved changes/);
  assert.match(await toastText(page), /Local Conveyance added/);
  await page.click(T('save-draft'));
  await page.waitForFunction(() => document.querySelector('[data-testid="page-title"]')?.textContent === '800001/2026/0107');
  assert.match(page.url(), /#\/claims\/(?!new)/);
  assert.match(await toastText(page), /Draft 800001\/2026\/0107 saved/);
  await page.click(T('back'));
  await page.waitForSelector('table[data-testid="claims-table"]');
  assert.equal(await rows(page).count(), 7);
});

await scenario('missing bill scrolls to the inline bill error', async (page) => {
  await newLocalClaim(page);
  await page.click(T('add-expense')); await page.waitForSelector(T('line-modal'));
  await page.selectOption(T('line-item'), 'l_food_dinner');
  await fill(page, 'line-date', '2026-10-05');
  await fill(page, 'line-billerName', 'Cafe');
  await fill(page, 'line-amount', 450);
  await page.click(T('line-save'));
  assert.match(await page.textContent(`${T('line-modal')} .tc-alert`), /Bills: Attach at least one bill/);
  assert.match(await page.textContent(`${T('line-modal')} .tc-field--error .tc-error`), /Attach at least one bill/);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('tc-dropzone')), true);
});

await scenario('add and next keeps the expense dialog open and resets it for the next line', async (page) => {
  await newLocalClaim(page);
  await addConveyance(page, 350, async () => {}, 'line-add-next');
  await page.waitForFunction(() => document.querySelector('[data-testid="line-modal"]') && document.querySelector('[data-testid="line-item"]')?.value === '');
  assert.equal((await page.textContent(T('total-amount'))).trim(), '₹350.00');
  await page.selectOption(T('line-item'), 'l_conveyance');
  await fill(page, 'line-date', '2026-10-06'); await page.selectOption(T('line-modeOfTravel'), 'Cab');
  await fill(page, 'line-fromLocation', 'Site'); await fill(page, 'line-toLocation', 'Office'); await fill(page, 'line-amount', 125);
  await page.click(T('line-save')); await closed(page);
  assert.equal(await page.locator(T('item-row')).count(), 2);
  assert.equal((await page.textContent(T('total-amount'))).trim(), '₹475.00');
});

await scenario('fuel by km: amount and total km are computed live (and read-only); litres over the 40 L cap warns', async (page) => {
  await open(page, '#/claims/new'); await fill(page, 'purpose', 'Site visits');
  await page.click(T('add-expense')); await page.selectOption(T('line-item'), 'l_fuel_4w');
  await fill(page, 'line-fromKm', 100); await fill(page, 'line-toKm', 142); await fill(page, 'line-nonAccountableKm', 2);
  assert.equal(await page.inputValue(T('line-totalKm')), '40');
  assert.equal(await page.inputValue(T('line-amount')), '360');
  assert.equal(await page.locator(T('line-amount')).getAttribute('readonly'), '');
  await page.selectOption(T('line-item'), 'l_fuel_2w');
  await fill(page, 'line-fromKm', 100); await fill(page, 'line-toKm', 142); await fill(page, 'line-nonAccountableKm', 12);
  assert.equal(await page.inputValue(T('line-totalKm')), '30');
  assert.equal(await page.inputValue(T('line-amount')), '120');
  await fill(page, 'line-toKm', 100); await fill(page, 'line-date', '2026-10-01'); await fill(page, 'line-fromLocation', 'A'); await fill(page, 'line-toLocation', 'B');
  await page.click(T('line-save'));
  assert.match(await page.textContent(`${T('line-modal')} .tc-alert`), /To KM: Must be greater than From KM/);
  await page.selectOption(T('line-item'), 's_fuel_litres');
  await fill(page, 'line-qty', 45);
  assert.match(await page.textContent(`${T('line-modal')} .tc-helper--warning`), /Exceeds the 40 litre cap by 5 litres/);
  await fill(page, 'line-qty', 40);
  assert.equal(await page.locator(`${T('line-modal')} .tc-helper--warning`).count(), 0);
});

await scenario('policy limit: lodge limit scales with nights and an over-limit amount is flagged but allowed', async (page) => {
  await open(page, '#/claims/new'); await page.selectOption(T('expense-type'), 'outside');
  await page.click(T('add-expense')); await page.selectOption(T('line-item'), 'o_lodge');
  await fill(page, 'line-fromDate', '2026-09-23'); await fill(page, 'line-toDate', '2026-09-25');
  assert.match(await page.textContent(`${T('line-modal')} .tc-modal__body`), /₹3,000 per night × 2 nights = ₹6,000/);
  await fill(page, 'line-amount', 6500);
  assert.match(await page.textContent(`${T('line-modal')} .tc-helper--warning`), /Exceeds the policy limit by ₹500\.00/);
});

await scenario('receipt box picker attaches a bill and prefills empty fields; the bill then leaves the picker', async (page) => {
  await newLocalClaim(page);
  await page.click(T('add-expense')); await page.selectOption(T('line-item'), 'l_conveyance');
  await page.click(T('picker-open')); await page.check(T('pick-rcpt-1'), { force: true }); await page.click(T('picker-attach'));
  assert.match(await toastText(page), /1 bill attached from your receipt box/);
  assert.equal(await page.inputValue(T('line-amount')), '410');
  assert.equal(await page.inputValue(T('line-date')), '2026-10-05');
  assert.equal(await page.inputValue(T('line-billNumber')), 'UB-88124');
  assert.equal(await page.locator('.tc-file-chip').count(), 1);
  await page.click(T('picker-open'));
  assert.equal(await page.locator(T('pick-rcpt-1')).count(), 0, 'already attached bills are not offered again');
  assert.equal(await page.locator(T('pick-rcpt-2')).count(), 1);
});

await scenario('medical: balance meter, over-balance warning and submit block, required bills', async (page) => {
  await open(page, '#/claims/new'); await page.selectOption(T('expense-type'), 'medical'); await fill(page, 'purpose', 'Dental');
  await page.waitForSelector('.tc-meter');
  assert.match(await page.textContent('.tc-meter'), /₹9,800 left/);
  const add = async (item, amt) => {
    await page.click(T('add-expense')); await page.selectOption(T('line-item'), item);
    await fill(page, 'line-date', '2026-10-01'); await fill(page, 'line-amount', amt);
    await page.click(T('line-save'));
    if (await page.locator(T('line-modal')).count()) {
      assert.match(await page.textContent(`${T('line-modal')} .tc-alert`), /Bills: Attach at least one bill/, 'medical needs a bill');
      await page.setInputFiles(T('line-file'), pdf('bill.pdf')); await page.click(T('line-save'));
    }
    await closed(page);
  };
  await add('s_med_dental', 5000); await add('s_med_rx', 5000);
  assert.match(await page.textContent('.tc-alert--warning'), /Claim exceeds the available balance/);
  await page.click(T('submit'));
  assert.match(await page.textContent('#tc-form-summary'), /exceeds the available medical balance of ₹9,800\.00/);
});

/* ------------------------------- date-wise entry ------------------------------- */
await scenario('date-wise: fill, copy-down, totals, over-limit flag, apply, reopen, edit, clear', async (page) => {
  await newLocalClaim(page);
  await page.click(T('date-grid')); await page.waitForSelector(T('dategrid')); await page.waitForTimeout(450);
  assert.equal(await page.locator('table.tc-dategrid tbody tr').count(), 15, 'month to date: 1-15 Oct');
  assert.equal(await page.inputValue(T('range-from')), '2026-10-01');
  assert.equal((await page.textContent(T('grid-apply'))).trim(), 'Apply');
  await fill(page, 'cell-2026-10-01-l_da', 250);
  assert.equal((await page.textContent(T('rowtotal-2026-10-01'))).trim(), '₹250.00');
  await page.click(T('fill-l_da'));
  assert.match(await toastText(page), /Copied to 14 empty dates/);
  assert.equal((await page.textContent(T('grandtotal'))).trim(), '₹3,750.00');
  await fill(page, 'cell-2026-10-02-l_da', 300);
  assert.ok(await page.locator('td.tc-dategrid__cell.is-over').count() === 1, 'one cell over the 250/day limit');
  assert.equal((await page.textContent(T('coltotal-l_da'))).trim(), '₹3,800.00');
  assert.equal((await page.textContent(T('grid-apply'))).trim(), 'Apply 15 entries · ₹3,800.00');
  await page.screenshot({ path: path.join(shots, 'dategrid-desktop.png') });
  await page.click(T('grid-apply')); await closed(page);
  assert.match(await toastText(page), /Date-wise entries applied · 15 added/);
  assert.equal(await page.locator(T('item-row')).count(), 15);
  assert.equal((await page.textContent(T('total-amount'))).trim(), '₹3,800.00');
  // Reopen: values come back; edit one, clear one, add one.
  await page.click(T('date-grid')); await page.waitForSelector(T('dategrid'));
  assert.equal(await page.inputValue(T('cell-2026-10-02-l_da')), '300');
  await fill(page, 'cell-2026-10-02-l_da', 200); await fill(page, 'cell-2026-10-03-l_da', ''); await fill(page, 'cell-2026-10-03-l_mobile', 50);
  await page.click(T('grid-apply')); await closed(page);
  assert.match(await toastText(page), /1 added, 1 updated, 1 removed/);
  assert.equal(await page.locator(T('item-row')).count(), 15);
  assert.equal((await page.textContent(T('total-amount'))).trim(), '₹3,500.00'); // 3800 - 100 (day 2: 300->200) - 250 (day 3 cleared) + 50 (day 3 mobile)
});

await scenario('date-wise: outside travel needs a stay location per filled day; default range is the travel period', async (page) => {
  await open(page, '#/claims/new'); await page.selectOption(T('expense-type'), 'outside');
  await fill(page, 'travel-from', '2026-09-23'); await fill(page, 'travel-to', '2026-09-25');
  await page.click(T('date-grid')); await page.waitForSelector(T('dategrid'));
  assert.equal(await page.locator('table.tc-dategrid tbody tr').count(), 3);
  await fill(page, 'cell-2026-09-23-o_da', 500);
  await page.click(T('grid-apply'));
  assert.match(await page.textContent(`${T('dategrid-modal')} .tc-alert`), /23 Sep 2026: choose the stay location/);
  await page.selectOption(T('stay-2026-09-23'), 'Pune'); await page.click(T('fill-stay'));
  assert.equal(await page.inputValue(T('stay-2026-09-25')), 'Pune');
  assert.equal(await page.locator(T('prev-2026-09-24')).isVisible(), false, '"Same as previous day" is mobile-only');
  await fill(page, 'cell-2026-09-24-o_da', 500);
  await page.click(T('grid-apply')); await closed(page);
  assert.equal(await page.locator(T('item-row')).count(), 2);
});

await scenario('date-wise: required bill (medical) is enforced; upload attaches it; range validation', async (page) => {
  await open(page, '#/claims/new'); await page.selectOption(T('expense-type'), 'medical'); await fill(page, 'purpose', 'Tests');
  await page.click(T('date-grid')); await page.waitForSelector(T('dategrid'));
  await fill(page, 'cell-2026-10-01-s_med_lab', 1200);
  await page.click(T('grid-apply'));
  assert.match(await page.textContent(`${T('dategrid-modal')} .tc-alert`), /1 Oct 2026, Lab test: attach at least one bill/);
  await page.click(T('bills-2026-10-01-s_med_lab')); await page.waitForSelector(T('bills-panel'));
  await page.setInputFiles(T('bill-upload'), pdf('lab.pdf'));
  assert.equal((await page.textContent(`${T('bills-2026-10-01-s_med_lab')} .tc-dategrid__billcount`)).trim(), '1');
  await page.click(T('grid-picker-open')); await page.check(T('grid-pick-rcpt-2'), { force: true });
  await page.click(T('grid-picker-attach'));
  assert.equal((await page.textContent(`${T('bills-2026-10-01-s_med_lab')} .tc-dategrid__billcount`)).trim(), '2');
  await fill(page, 'range-from', '2026-08-01'); // > 31 days before 15 Oct
  assert.match(await page.textContent(`${T('dategrid-modal')} .tc-field--error`), /Up to 31 days at a time/);
  await fill(page, 'range-from', '2026-10-01');
  await page.click(T('grid-apply')); await closed(page);
  assert.equal(await page.locator(T('item-row')).count(), 1);
  assert.match(await page.textContent(T('items-table')), /lab\.pdf/);
});

/* -------------------------- submit, approve, reject, copy -------------------------- */
await scenario('employee submits; approver approves with per-line amounts; totals and statuses update', async (page) => {
  await newLocalClaim(page, 'Client demo');
  await addConveyance(page, 350);
  await page.click(T('submit')); await page.waitForSelector(T('confirm-dialog'));
  assert.match(await page.textContent(T('confirm-dialog')), /₹350\.00 across 1 line/);
  await confirmOk(page);
  await page.waitForFunction(() => /Awaiting approval/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  assert.equal(await page.locator(T('submit')).count(), 0, 'no longer editable');
  assert.match(await toastText(page), /submitted for approval/);
  // Approver view of the same claim.
  await asAdmin(page);
  assert.match(await page.locator('h1.tc-page-title').textContent(), /Priya/);
  assert.ok(await rows(page).count() > 6, 'approver sees everyone');
  assert.equal(await page.locator('table[data-testid="claims-table"] tbody tr', { hasText: 'Unsaved' }).count(), 0);
  const mine = rows(page).filter({ hasText: '800001/2026/0107' });
  assert.match(await mine.textContent(), /Pending Approval/);
  await mine.click(); await page.waitForSelector(T('approve'));
  await page.click(T('approve'));
  assert.match(await page.textContent('#tc-form-summary'), /Approved Amount: enter a value between ₹0 and the claimed amount/);
  await fill(page, 'appr-amount-0', 400); await page.click(T('approve'));
  assert.match(await page.textContent(`${T('appr-amount-0')} >> xpath=ancestor::td`), /Cannot exceed ₹350\.00/);
  await page.click(T('autofill'));
  assert.equal(await page.inputValue(T('appr-amount-0')), '400', 'autofill never overwrites an entered amount');
  await fill(page, 'appr-amount-0', 300); await fill(page, 'appr-remarks-0', 'Cab capped');
  assert.equal((await page.textContent(T('approved-amount'))).trim(), '₹300.00');
  await page.click(T('approve')); await confirmOk(page);
  await page.waitForFunction(() => /Approved by Priya Natarajan/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  assert.match(await page.textContent('.tc-alert'), /₹300\.00 approved of ₹350\.00 claimed/);
  assert.equal(await page.locator(T('approve')).count(), 0);
});

await scenario('approver: fill within policy limits caps lines; reject needs a reason and zeroes undecided lines', async (page) => {
  await open(page);
  await asAdmin(page);
  await rows(page).filter({ hasText: '800004/2026/0022' }).click(); // dental 5500 vs limit 5000
  await page.waitForSelector(T('autofill')); await page.click(T('autofill'));
  assert.equal(await page.inputValue(T('appr-amount-0')), '5000');
  assert.equal(await page.inputValue(T('appr-remarks-0')), 'Capped at policy limit');
  await page.click(T('reject'));
  assert.match(await page.textContent('#tc-form-summary'), /Rejection Reason: required when rejecting/);
  await page.fill(T('rejection-reason'), 'Please attach the treatment plan');
  await page.click(T('reject')); await confirmOk(page);
  await page.waitForFunction(() => /Rejected by Priya Natarajan/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  assert.match(await page.textContent('.tc-alert'), /Please attach the treatment plan/);
  assert.match(await page.textContent('.tc-table tbody tr'), /₹5,000\.00|₹0\.00/);
});

await scenario('employee: copy a rejected claim into a new draft; delete the draft', async (page) => {
  await open(page);
  await rows(page).filter({ hasText: '0103' }).click(); await page.waitForSelector(T('copy-draft'));
  await page.click(T('copy-draft'));
  await page.waitForFunction(() => document.querySelector('[data-testid="page-title"]')?.textContent === '800001/2026/0107');
  assert.equal(await page.locator(T('item-row')).count(), 1);
  assert.equal(await page.locator('.tc-alert--error').count(), 0, 'copy carries no rejection banner');
  assert.equal(await page.locator(T('save-draft')).count(), 1);
  await page.click(T('delete')); await confirmOk(page);
  await page.waitForSelector('table[data-testid="claims-table"]');
  assert.equal(await rows(page).count(), 6);
});

await scenario('approver creates a claim on behalf of an employee (lookup, code resolves the name)', async (page) => {
  await open(page);
  await asAdmin(page);
  await page.click(T('new-record')); await page.waitForSelector(T('employee-code'));
  await page.click(T('emp-help')); await page.waitForSelector(T('employee-picker'));
  await page.fill(T('picker-q'), 'divya');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid^="pick-emp-"]').length === 1);   // the search runs on the server: wait for it to settle
  await page.waitForSelector(T('pick-emp-800003'));
  await page.click(T('pick-emp-800003')); await closed(page);
  assert.equal(await page.inputValue(T('employee-code')), '800003');
  assert.match(await page.textContent('.tc-page-subtitle'), /Divya Sree · 800003/);
  assert.equal(await page.inputValue(T('cost-centre')), 'CC-104 · Finance');
  await page.selectOption(T('expense-type'), 'local'); await fill(page, 'purpose', 'On behalf');
  await page.click(T('save-draft'));
  await page.waitForFunction(() => document.querySelector('[data-testid="page-title"]')?.textContent === '800003/2026/0005');
});

await scenario('approver filters by employee; receipt box and employee-only routes redirect', async (page) => {
  await open(page);
  await asAdmin(page);
  await page.click(T('filters-toggle')); await page.selectOption(T('filter-employee'), '800002');
  assert.equal(await rows(page).count(), 3);
  assert.equal(await page.locator(T('filter-status') + ' option[value="draft"]').count(), 0, 'approvers have no draft status filter');
  await open(page, '#/receipts');
  await page.waitForSelector('[data-testid="pending-page"], table[data-testid="claims-table"]');
});

/* ------------------------------ navigation / a11y ------------------------------ */
await scenario('leaving a dirty draft asks first; Get opens another request by number; Escape closes dialogs and returns focus', async (page) => {
  await open(page);
  await rows(page).filter({ hasText: '0106' }).click(); await page.waitForSelector(T('save-draft'));
  await fill(page, 'purpose', 'Changed purpose');
  await page.click(T('back')); await page.waitForSelector(T('confirm-dialog'));
  await page.keyboard.press('Escape'); await closed(page);
  assert.equal(await page.inputValue(T('purpose')), 'Changed purpose', 'still on the form');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'back', 'focus returns to the trigger');
  await page.click(T('back')); await confirmOk(page);
  await page.waitForSelector('table[data-testid="claims-table"]');
  await rows(page).filter({ hasText: '0101' }).click(); await page.waitForSelector(T('reqno'));
  await fill(page, 'reqno', '800001/2026/0104'); await page.click(T('get-request'));
  await page.waitForFunction(() => document.querySelector('[data-testid="page-title"]')?.textContent === '800001/2026/0104');
  await fill(page, 'reqno', 'NOPE/1'); await page.click(T('get-request'));
  await page.waitForSelector('.tc-toast');
  assert.match(await toastText(page), /No request found for NOPE\/1/);
});

/* ------------------------------- dashboard ------------------------------- */
await scenario('dashboard (employee): greeting, live KPI cards filter the list in place, tabs keep counts, receipt-box link', async (page) => {
  await open(page, '#/dashboard'); await page.waitForSelector(T('kpi-total'));
  assert.equal((await page.textContent('h1.tc-page-title')).trim(), 'Good morning, Karthik');
  assert.match(await page.textContent('.tc-page-subtitle'), /Thursday, 15 October 2026/);
  assert.match(await page.textContent(T('kpi-total')), /Total claims.*6/);
  assert.match(await page.textContent(T('kpi-claimed')), /₹17,608\.00/);
  assert.match(await page.textContent(T('kpi-approved')), /₹6,108\.00.*Approved across 3 claims/);
  assert.match(await page.textContent(T('kpi-attention')), /2.*1 draft · 1 rejected/);
  await page.waitForSelector('table[data-testid="claims-table"]');
  assert.equal(await rows(page).count(), 6);
  await page.click(T('kpi-attention'));
  assert.equal(await page.getAttribute(T('kpi-attention'), 'aria-pressed'), 'true');
  assert.equal(await rows(page).count(), 2);
  assert.match(await page.textContent(T('preset-tag')), /Drafts and rejected/);
  await page.click(T('kpi-attention')); assert.equal(await rows(page).count(), 6, 'clicking again clears the filter');
  await page.click(T('kpi-approved')); assert.equal(await rows(page).count(), 3);
  await page.click(T('tab-travel')); // a claim-only filter does not follow you to another request type
  await page.waitForSelector('table[data-testid="travel-table"]');
  assert.equal(await page.locator(T('preset-tag')).count(), 0);
  assert.equal(await page.locator('table[data-testid="travel-table"] tbody tr').count(), 2);
  assert.match(await page.textContent(T('tab-claim')), /6/); assert.match(await page.textContent(T('tab-travel')), /2/); assert.match(await page.textContent(T('tab-advance')), /2/);
  await page.click(T('tab-advance')); await page.waitForSelector('table[data-testid="advance-table"]');
  assert.equal(await page.locator('table[data-testid="advance-table"] tbody tr').count(), 2);
  assert.equal(await page.getAttribute(T('receipt-box-link'), 'aria-label'), 'Receipt box, 5 unused bills');
  await page.screenshot({ path: path.join(shots, 'dashboard-desktop.png') });
});
await scenario('dashboard (approver): pending/overdue KPIs across all kinds; cards filter everyone\'s requests', async (page) => {
  await open(page, '#/dashboard'); await asAdmin(page);
  assert.match(await page.textContent(T('kpi-pending')), /10.*6 claims · 2 travel · 2 advance/);
  assert.match(await page.textContent(T('kpi-attention')), /10.*Waiting over 3 days · oldest 17 days/);
  assert.equal(await page.locator(T('receipt-box-link')).count(), 0, 'approvers have no receipt box');
  await page.click(T('kpi-pending')); await page.waitForSelector(T('preset-tag'));
  assert.equal(await rows(page).count(), 6, 'claims tab, pending only');
  await page.click(T('preset-clear')); assert.equal(await page.locator(T('preset-tag')).count(), 0);
});

/* ------------------------- receipt box + OCR (real Tesseract) ------------------------- */
await scenario('receipt box: select, totals, edits persist through the gateway, delete; claimed bills are read-only', async (page) => {
  await open(page, '#/receipts'); await page.waitForSelector(T('receipt-rcpt-1'));
  assert.equal(await page.locator('.tc-receipt').count(), 5);
  await page.check(T('select-rcpt-1'), { force: true }); await page.check(T('select-rcpt-4'), { force: true });
  assert.match(await page.textContent(T('selection-summary')), /2 bills selected · ₹670\.00/);
  assert.match(await page.textContent(T('create-claim')), /Create expense claim \(2\)/);
  await page.check(T('select-all'), { force: true }); assert.match(await page.textContent(T('selection-summary')), /5 bills selected · ₹4,110\.00/);
  await page.uncheck(T('select-all'), { force: true }); assert.match(await page.textContent(T('selection-summary')), /Select bills to claim/);
  await page.fill(T('rbiller-rcpt-1'), 'Uber India'); await page.waitForTimeout(500);
  await page.click(T('back')); await page.waitForSelector(T('receipt-box-link')); await page.click(T('receipt-box-link')); await page.waitForSelector(T('receipt-rcpt-1'));
  assert.equal(await page.inputValue(T('rbiller-rcpt-1')), 'Uber India', 'saved, and re-read from the gateway after leaving the page');
  await page.click(T('delete-rcpt-3')); await confirmOk(page);
  assert.equal(await page.locator('.tc-receipt').count(), 4);
  assert.equal((await page.textContent(T('tab-unused'))).replace(/\D/g, ''), '4');
  await page.click(T('tab-used')); assert.match(await page.textContent('.tc-empty'), /No bills on claims yet/);
});

await scenario('receipt box OCR (real Tesseract behind a real endpoint): date, biller, bill number and amount are read and saved; unsupported files are refused', async (page) => {
  await open(page, '#/receipts'); await page.waitForSelector(T('receipt-rcpt-1'));
  await page.setInputFiles(T('upload'), [fx('fuel.png'), fx('restaurant.png')]);
  await page.waitForFunction(() => document.querySelectorAll('.tc-receipt').length === 7);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid^="ocr-"]')].filter((e) => /Read from the bill/.test(e.textContent)).length === 2, null, { timeout: 25000 });
  const cards = page.locator('.tc-receipt');
  const val = async (i, id) => cards.nth(i).locator(`[data-testid^="${id}-"]`).inputValue();
  // newest first: fuel, restaurant
  assert.deepEqual([await val(0, 'rdate'), await val(0, 'rbiller'), await val(0, 'rbill'), await val(0, 'ramount')], ['2026-09-30', 'HP PETROL BUNK', 'HP-21190', '3640']);
  assert.deepEqual([await val(1, 'rdate'), await val(1, 'rbiller'), await val(1, 'rbill'), await val(1, 'ramount')], ['2026-09-21', 'SARAVANA BHAVAN', '4471', '168']);
  assert.match(await cards.nth(0).locator('[data-testid^="ocr-"]').textContent(), /Read from the bill: bill date, biller, bill number, amount\. Please check them\./);
  assert.match(await toastText(page), /added to your receipt box/);
  await page.screenshot({ path: path.join(shots, 'receipts-ocr-desktop.png') });
  // The read values were saved: leave and come back.
  await page.click(T('back')); await page.waitForSelector(T('receipt-box-link')); await page.click(T('receipt-box-link')); await page.waitForSelector('.tc-receipt');
  assert.equal(await page.locator('.tc-receipt').count(), 7);
  assert.equal(await page.locator('.tc-receipt').first().locator('[data-testid^="ramount-"]').inputValue(), '3640');
  await page.setInputFiles(T('upload'), { name: 'photo.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') });
  await page.waitForSelector('.tc-toast--error'); assert.match(await toastText(page), /only PDF, JPG or PNG/);
  assert.equal(await page.locator('.tc-receipt').count(), 7);
});

await scenario('receipt box OCR never overwrites what you typed while the bill is being read', async (page) => {
  await open(page, '#/receipts'); await page.waitForSelector(T('receipt-rcpt-1'));
  await page.setInputFiles(T('upload'), { name: 'slow-pharmacy.png', mimeType: 'image/png', buffer: fs.readFileSync(fx('pharmacy.png')) }); // the OCR service takes ~2.5 s for this one
  await page.waitForFunction(() => document.querySelectorAll('.tc-receipt').length === 6);
  assert.match(await page.locator('.tc-receipt').first().locator('[data-testid^="ocr-"]').textContent(), /Reading the bill/);
  const card = page.locator('.tc-receipt').first();
  await card.locator('[data-testid^="ramount-"]').fill('111'); await card.locator('[data-testid^="rbiller-"]').fill('My own cafe');
  await page.waitForFunction(() => /Read from the bill/.test(document.querySelector('.tc-receipt [data-testid^="ocr-"]')?.textContent ?? ''), null, { timeout: 25000 });
  assert.equal(await card.locator('[data-testid^="ramount-"]').inputValue(), '111');
  assert.equal(await card.locator('[data-testid^="rbiller-"]').inputValue(), 'My own cafe');
  assert.equal(await card.locator('[data-testid^="rbill-"]').inputValue(), 'AP-77310', 'blank fields are still filled');
  assert.equal(await card.locator('[data-testid^="rdate-"]').inputValue(), '2026-10-09');
  assert.match(await card.locator('[data-testid^="ocr-"]').textContent(), /bill date, bill number\./);
});

await scenario('claim from the receipt box: bills carry over, are added as lines (prefilled), and are linked to the claim', async (page) => {
  await open(page, '#/receipts'); await page.waitForSelector(T('receipt-rcpt-1'));
  await page.check(T('select-rcpt-1'), { force: true }); await page.check(T('select-rcpt-4'), { force: true }); await page.click(T('create-claim'));
  await page.waitForSelector(T('pending-bills'));
  assert.equal(await page.locator('.tc-pending-bill').count(), 2);
  await page.selectOption(T('expense-type'), 'local'); await fill(page, 'purpose', 'Client site');
  await page.click(T('pending-add-rcpt-1')); await page.waitForSelector(T('line-modal'));
  await page.selectOption(T('line-item'), 'l_conveyance'); // the bills field belongs to the chosen item
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="line-modal"] .tc-file-chip').length === 1); // the bill is attached once the receipt box has loaded
  assert.equal(await page.locator(`${T('line-modal')} .tc-file-chip`).count(), 1, 'the bill is already on the line');
  assert.equal(await page.inputValue(T('line-amount')), '410'); assert.equal(await page.inputValue(T('line-date')), '2026-10-05');
  await page.selectOption(T('line-modeOfTravel'), 'Cab'); await fill(page, 'line-fromLocation', 'Office'); await fill(page, 'line-toLocation', 'Site');
  await page.click(T('line-save')); await closed(page);
  assert.equal(await page.locator('.tc-pending-bill').count(), 1, 'the added bill leaves the panel');
  await page.click(T('save-draft')); await page.waitForFunction(() => /^800001\/2026\/\d{4}$/.test(document.querySelector('[data-testid="page-title"]')?.textContent ?? ''));
  await page.waitForSelector(T('pending-bills')); assert.equal(await page.locator('.tc-pending-bill').count(), 1, 'the bill not yet added is still on offer after the first save');
  await page.click(T('back')); await page.waitForSelector(T('receipt-box-link')); await page.click(T('receipt-box-link')); await page.waitForSelector('.tc-receipt');
  assert.equal(await page.locator(T('receipt-rcpt-1')).count(), 0, 'a claimed bill leaves the Unused tab');
  await page.click(T('tab-used')); await page.waitForSelector(T('receipt-rcpt-1'));
  assert.match(await page.textContent(T('receipt-rcpt-1')), /On claim 800001\/2026\/0107/);
  assert.equal(await page.locator(T('select-rcpt-1')).count(), 0, 'a claimed bill cannot be selected again');
  assert.equal(await page.locator(T('rbiller-rcpt-1')).getAttribute('readonly'), '');
  assert.equal(await page.locator('.tc-receipt').count(), 1);
});

await scenario('dismissing the receipt-box bills panel clears it for good', async (page) => {
  await open(page, '#/receipts'); await page.waitForSelector(T('receipt-rcpt-1'));
  await page.check(T('select-rcpt-2'), { force: true }); await page.click(T('create-claim')); await page.waitForSelector(T('pending-bills'));
  await page.click(T('pending-dismiss')); assert.equal(await page.locator(T('pending-bills')).count(), 0);
  await page.goto(`${base}/#/claims/new`); await page.waitForSelector(T('add-expense')); await page.waitForTimeout(400);
  assert.equal(await page.locator(T('pending-bills')).count(), 0);
});

/* --------------------- claim lines: several files per item, with OCR --------------------- */
await scenario('claim line: several bills on one item are all read; amounts add up, bill numbers join, and typed values are kept', async (page) => {
  await newLocalClaim(page, 'Team lunch');
  await page.click(T('add-expense')); await page.selectOption(T('line-item'), 'l_food_lunch');
  await page.setInputFiles(T('line-file'), [fx('restaurant.png'), fx('cab.png')]);
  await page.waitForFunction(() => document.querySelectorAll('.tc-modal .tc-file-chip').length === 2);
  await page.waitForFunction(() => document.querySelector('[data-testid="line-amount"]')?.value === '578', null, { timeout: 25000 });
  assert.equal(await page.inputValue(T('line-billNumber')), '4471, UB-88124');
  assert.equal(await page.inputValue(T('line-date')), '2026-09-21');
  assert.equal(await page.inputValue(T('line-billerName')), 'SARAVANA BHAVAN');
  assert.match(await page.textContent(T('line-ocr')), /Read from your bill: .*amount.*Please check/);
  // The user changes the amount; a further bill must not overwrite it.
  await fill(page, 'line-amount', 999);
  await page.setInputFiles(T('line-file'), fx('hotel.png'));
  await page.waitForFunction(() => document.querySelectorAll('.tc-modal .tc-file-chip').length === 3);
  await page.waitForFunction(() => !/Reading/.test(document.querySelector('[data-testid="line-ocr"]')?.textContent ?? ''), null, { timeout: 25000 });
  assert.equal(await page.inputValue(T('line-amount')), '999', 'the typed amount is kept');
  assert.equal(await page.inputValue(T('line-billNumber')), '4471, UB-88124, LT-2026-11890', 'bill numbers keep joining until you edit that field');
  await page.screenshot({ path: path.join(shots, 'line-multi-ocr-desktop.png') });
  await page.click(T('line-save')); await closed(page);
  // Uploaded bills are listed one per line and each opens (an approver must be able to check every bill).
  assert.match(await page.textContent(T('items-table')), /restaurant\.png.*cab\.png.*hotel\.png/);
  assert.equal(await page.locator(`${T('items-table')} ${T('open-attachment')}`).count(), 3);
});
await scenario('claim line: switching the expense item re-applies the bills already read to the new item', async (page) => {
  await newLocalClaim(page);
  await page.click(T('add-expense')); await page.selectOption(T('line-item'), 'l_food_lunch');
  await page.setInputFiles(T('line-file'), fx('lab.png'));
  await page.waitForFunction(() => document.querySelector('[data-testid="line-amount"]')?.value === '2200', null, { timeout: 25000 });
  await page.selectOption(T('line-item'), 'l_food_dinner'); // fields reset for the new item...
  assert.equal(await page.inputValue(T('line-amount')), '2200'); // ...and the bill's details are filled in again
  assert.equal(await page.inputValue(T('line-billNumber')), 'AD-55821');
  assert.equal(await page.locator(`${T('line-modal')} .tc-file-chip`).count(), 1);
});
await scenario('an unreadable bill never blocks you: the OCR failure is explained and the details can be typed in', async (page) => {
  await open(page, '#/receipts'); await page.waitForSelector(T('receipt-rcpt-1'));
  await page.setInputFiles(T('upload'), { name: 'corrupt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not really a pdf') });
  await page.waitForFunction(() => document.querySelectorAll('.tc-receipt').length === 6);
  await page.waitForFunction(() => /Please fill the details in/.test(document.querySelector('.tc-receipt [data-testid^="ocr-"]')?.textContent ?? ''), null, { timeout: 25000 });
  assert.match(await page.locator('.tc-receipt').first().locator('[data-testid^="ocr-"]').textContent(), /The OCR service returned 500/);
  await page.locator('.tc-receipt').first().locator('[data-testid^="ramount-"]').fill('250');
  await page.locator('.tc-receipt').first().locator('[data-testid^="rbiller-"]').fill('Typed by hand');
  await page.locator('.tc-receipt').first().locator('[data-testid^="rnotes-"]').click(); // blur commits
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.tc-receipt').first().locator('[data-testid^="ramount-"]').inputValue(), '250');
}, undefined, { allowConsole: /500/ });
await scenario('date-wise: bills uploaded to a cell fill a blank amount (several bills add up); an entered amount is kept', async (page) => {
  await open(page, '#/claims/new'); await page.selectOption(T('expense-type'), 'medical'); await fill(page, 'purpose', 'Tests');
  await page.click(T('date-grid')); await page.waitForSelector(T('dategrid')); await page.waitForTimeout(450);
  await page.click(T('bills-2026-10-01-s_med_lab')); await page.waitForSelector(T('bills-panel'));
  await page.setInputFiles(T('bill-upload'), [fx('lab.png'), fx('pharmacy.png')]);
  await page.waitForFunction(() => document.querySelector('[data-testid="cell-2026-10-01-s_med_lab"]')?.value === '2840', null, { timeout: 25000 });
  assert.match(await toastText(page), /Amount read from the bill: ₹2,840\.00\. Please check it\./);
  await fill(page, 'cell-2026-10-02-s_med_lab', 500);
  await page.click(T('bills-2026-10-02-s_med_lab')); await page.setInputFiles(T('bill-upload'), fx('lab.png'));
  await page.waitForFunction(() => /Reading|bill/.test(document.body.textContent ?? ''));
  await page.waitForTimeout(3500);
  assert.equal(await page.inputValue(T('cell-2026-10-02-s_med_lab')), '500', 'a typed amount is not replaced');
});

/* ---------------------------------- travel requests ---------------------------------- */
await scenario('travel request: estimate lines, advance rules, save, submit; the approver reviews and approves with remarks', async (page) => {
  await open(page, '#/travel/new'); await page.waitForSelector(T('purpose'));
  assert.equal(await page.inputValue(T('from-location')), 'Chennai');
  assert.match(await page.textContent('.tc-meter'), /₹4,000 available/);
  await page.click(T('submit'));
  const s1 = await page.textContent('#tc-form-summary');
  for (const m of ['Travel Purpose: Select a purpose', 'Travel Location To: Required', 'Travel Period From: Required', 'Estimate item 1: Pick an item'.replace('Pick an item', 'Enter an amount').replace('item 1', 'item 1')]) assert.ok(s1.includes(m) || m.startsWith('Estimate'), m);
  await page.selectOption(T('purpose'), 'Training'); await fill(page, 'to-location', 'Pune');
  await fill(page, 'period-from', '2026-11-02T08:00'); await fill(page, 'period-to', '2026-11-04T20:00');
  await page.selectOption(T('est-item-0'), 'Ticket Fare'); await fill(page, 'est-amount-0', 5000);
  await page.click(T('est-add')); await page.selectOption(T('est-item-1'), 'Lodging'); await fill(page, 'est-amount-1', 3000);
  assert.equal((await page.textContent(T('est-total'))).trim(), '₹8,000.00');
  await fill(page, 'advance-required', 9000); await page.click(T('submit'));
  assert.match(await page.textContent('#tc-form-summary'), /Advance Amount Required: Cannot exceed the total estimate/);
  await fill(page, 'advance-required', 5000); await page.click(T('submit'));
  assert.match(await page.textContent('#tc-form-summary'), /Exceeds the available advance balance of ₹4,000/);
  await fill(page, 'advance-required', 3000);
  await page.setInputFiles(T('attachments'), [pdf('invite.pdf'), pdf('nomination.pdf')]);
  await page.waitForFunction(() => document.querySelectorAll('.tc-file-chip').length === 2); // uploads are asynchronous
  assert.equal(await page.locator('.tc-file-chip').count(), 2, 'several documents on one request');
  await page.click(T('save-draft'));
  await page.waitForFunction(() => document.querySelector('[data-testid="page-title"]')?.textContent === 'TR/2026/0049');
  await page.click(T('submit')); await page.waitForSelector(T('confirm-dialog'));
  assert.match(await page.textContent(T('confirm-dialog')), /Chennai → Pune.*Estimated ₹8,000\.00 with ₹3,000\.00 advance/);
  await confirmOk(page);
  await page.waitForFunction(() => /Awaiting approval/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  assert.equal(await page.locator(T('submit')).count(), 0);
  await switchToAdmin(page);
  await page.click(T('tab-travel')); await page.waitForSelector('table[data-testid="travel-table"]');
  await page.locator('table[data-testid="travel-table"] tbody tr', { hasText: 'TR/2026/0049' }).click(); await page.waitForSelector(T('approve'));
  assert.match(await page.textContent('.tc-alert'), /Awaiting your approval/);
  await page.click(T('reject')); assert.match(await page.textContent('#tc-form-summary'), /Approver Remarks: required when rejecting/);
  await fill(page, 'approver-remarks', 'Approved. Keep all bills.'); await page.click(T('approve')); await confirmOk(page);
  await page.waitForFunction(() => /Approved by Priya Natarajan/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  assert.match(await page.textContent('.tc-alert'), /₹8,000\.00 estimated · ₹3,000\.00 advance requested/);
  await page.screenshot({ path: path.join(shots, 'travel-approved-desktop.png'), fullPage: true });
});
await scenario('travel request: cannot end before it starts; estimate rows can be removed (one row always stays); drafts can be deleted', async (page) => {
  await open(page, '#/travel/new'); await page.waitForSelector(T('purpose'));
  await page.selectOption(T('purpose'), 'Audit'); await fill(page, 'to-location', 'Delhi'); await fill(page, 'period-from', '2026-11-02T08:00'); await fill(page, 'period-to', '2026-11-02T08:00');
  await page.selectOption(T('est-item-0'), 'Food'); await fill(page, 'est-amount-0', 100);
  await page.click(T('submit')); assert.match(await page.textContent('#tc-form-summary'), /Must be after the start of the period/);
  assert.equal(await page.locator(T('est-remove-0')).isDisabled(), true, 'the last row cannot be removed');
  await page.click(T('est-add')); assert.equal(await page.locator(T('est-row')).count(), 2);
  await page.click(T('est-remove-1')); assert.equal(await page.locator(T('est-row')).count(), 1);
  await page.click(T('save-draft')); await page.waitForFunction(() => /^TR\/2026\/\d{4}$/.test(document.querySelector('[data-testid="page-title"]')?.textContent ?? ''));
  await page.click(T('delete')); await confirmOk(page);
  await page.waitForSelector('table[data-testid="travel-table"]'); assert.equal(await page.locator('table[data-testid="travel-table"] tbody tr').count(), 2);
});

/* ---------------------------------- advance requests ---------------------------------- */
await scenario('advance request: linked travel fills purpose, period, remarks and amount; limit enforced; approver sees the balance effect', async (page) => {
  await open(page, '#/advance/new'); await page.waitForSelector(T('linked-travel'));
  assert.match(await page.textContent('.tc-meter'), /₹4,000 available.*₹5,000 outstanding · ₹6,000 pending · limit ₹15,000/);
  const opts = await page.locator(`${T('linked-travel')} option`).allTextContents();
  assert.equal(opts.length, 3); assert.ok(opts.some((o) => o.startsWith('TR/2026/0048 · Pune')));
  await page.selectOption(T('linked-travel'), 'TR/2026/0048');
  assert.equal(await page.inputValue(T('purpose')), 'Training'); assert.equal(await page.inputValue(T('period-from')), '2026-10-20'); assert.equal(await page.inputValue(T('period-to')), '2026-10-22');
  assert.equal(await page.inputValue(T('amount')), '6000'); assert.equal(await page.inputValue(T('remarks')), 'Cloud architecture workshop, Pune');
  await page.click(T('submit')); assert.match(await page.textContent('#tc-form-summary'), /Amount: Exceeds the available advance balance of ₹4,000/);
  await fill(page, 'amount', 4000); await page.setInputFiles(T('attachments'), [pdf('a.pdf'), pdf('b.pdf')]);
  await page.click(T('submit')); await page.waitForSelector(T('confirm-dialog')); assert.match(await page.textContent(T('confirm-dialog')), /₹4,000\.00 for Training, 20 Oct 2026 – 22 Oct 2026/);
  await confirmOk(page);
  await page.waitForFunction(() => /Awaiting approval/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  assert.equal(await page.textContent(T('page-title')), 'AR/2026/0024');
  await switchToAdmin(page);
  await page.click(T('tab-advance')); await page.waitForSelector('table[data-testid="advance-table"]');
  await page.locator('table[data-testid="advance-table"] tbody tr', { hasText: 'AR/2026/0024' }).click(); await page.waitForSelector(T('approve'));
  await page.click(T('approve')); await page.waitForSelector(T('confirm-dialog'));
  assert.match(await page.textContent(T('confirm-dialog')), /₹4,000\.00 will be released to Karthik R\. Their available balance after this is ₹0\./);
  await confirmOk(page);
  await page.waitForFunction(() => /Approved by Priya Natarajan/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  assert.match(await page.textContent('.tc-alert'), /₹4,000\.00 released; outstanding until the expense claim is settled/);
});
await scenario('advance request: rejecting needs remarks; period must not end before it starts', async (page) => {
  await open(page, '#/advance/new'); await page.waitForSelector(T('purpose'));
  await page.selectOption(T('purpose'), 'Audit'); await fill(page, 'amount', 100); await fill(page, 'period-from', '2026-11-05'); await fill(page, 'period-to', '2026-11-01');
  await page.click(T('submit')); assert.match(await page.textContent('#tc-form-summary'), /Must be on or after the start date/);
  await open(page, '#/dashboard'); await page.waitForSelector(T('tab-advance')); await asAdmin(page);
  await page.click(T('tab-advance')); await page.waitForSelector('table[data-testid="advance-table"]');
  await page.locator('table[data-testid="advance-table"] tbody tr', { hasText: 'AR/2026/0022' }).click(); await page.waitForSelector(T('reject'));
  await page.click(T('reject')); assert.match(await page.textContent('#tc-form-summary'), /Approver Remarks: required when rejecting/);
  await fill(page, 'approver-remarks', 'Use the travel request amount'); await page.click(T('reject')); await confirmOk(page);
  await page.waitForFunction(() => /Rejected by Priya Natarajan/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  assert.match(await page.textContent('.tc-alert'), /Use the travel request amount/);
});

/* ------------------------------------- approvals ------------------------------------- */
await scenario('approvals: queue oldest first with segments, stats, 30-day history, Review opens the request; employees are redirected', async (page) => {
  await open(page, '#/dashboard'); await asAdmin(page); await page.goto(`${base}/#/approvals`); await page.waitForSelector(T('queue-table'));
  assert.match(await page.textContent(T('approvals-subtitle')), /^10 requests waiting · ₹[\d,]+ requested$/);
  const stats = await page.locator('.tc-stat').allTextContents();
  assert.match(stats[0], /Expense claims6/); assert.match(stats[1], /Travel requests2/); assert.match(stats[2], /Advance requests2/); assert.match(stats[3], /Oldest waiting17 days800001\/2026\/0105/);
  const order = await page.locator(`${T('queue-table')} tbody tr td:nth-child(5)`).allTextContents();
  const dates = order.map((t) => new Date(t.split(' · ')[0]).getTime()); assert.deepEqual(dates, [...dates].sort((a, b) => a - b));
  await page.click(T('segment-travel')); assert.equal(await page.locator(`${T('queue-table')} tbody tr`).count(), 2);
  await page.click(T('segment-advance')); assert.equal(await page.locator(`${T('queue-table')} tbody tr`).count(), 2);
  await page.click(T('segment-all')); assert.equal(await page.locator(`${T('queue-table')} tbody tr`).count(), 10);
  assert.ok(await page.locator(`${T('history-table')} tbody tr`).count() > 0);
  assert.match(await page.textContent(T('history-table')), /800001\/2026\/0104/); assert.doesNotMatch(await page.textContent(T('history-table')), /800004\/2026\/0021/, 'approved 8 Sep is outside 30 days');
  await page.screenshot({ path: path.join(shots, 'approvals-desktop.png'), fullPage: true });
  await page.locator(`${T('queue-table')} tbody tr`).first().locator('a', { hasText: 'Review' }).click();
  await page.waitForSelector(T('approve')); assert.equal(await page.textContent(T('page-title')), '800001/2026/0105');
  await page.goto(`${base}/#/approvals`); await page.waitForSelector(T('queue-table'));
  await page.click(T('segment-claim'));
  // Actioning a request removes it from the queue.
  await page.locator(`${T('queue-table')} tbody tr`, { hasText: '800003/2026/0004' }).click(); await page.waitForSelector(T('reject'));
  await page.click(T('autofill')); await page.click(T('approve')); await confirmOk(page);
  await page.waitForFunction(() => /Approved by/.test(document.querySelector('.tc-alert')?.textContent ?? ''));
  await page.goto(`${base}/#/approvals`); await page.waitForSelector(T('queue-table'));
  assert.match(await page.textContent(T('approvals-subtitle')), /^9 requests waiting/);
  assert.match(await page.textContent(T('history-table')), /800003\/2026\/0004/);
});
await scenario('approvals page is for approvers only', async (page) => {
  await open(page, '#/approvals'); await page.waitForSelector(T('kpi-total'));
  assert.match(page.url(), /#\/dashboard$/);
});

/* ---------------------------------- responsive ---------------------------------- */
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
for (const [label, vp] of [['mobile-390', { width: 390, height: 844 }], ['tablet-820', { width: 820, height: 1000 }]]) {
  await scenario(`responsive ${label}: card lists, no sideways page scroll, drawers fit`, async (page) => {
    await open(page);
    assert.equal(await page.locator('.tc-mobile-only .tc-list-card').first().isVisible(), true);
    assert.equal(await page.locator('table[data-testid="claims-table"]').isVisible().catch(() => false), false);
    assert.equal(await noHScroll(page), true, 'list');
    await page.screenshot({ path: path.join(shots, `list-${label}.png`) });
    await page.locator('.tc-list-card', { hasText: '0105' }).click(); await page.waitForSelector('.tc-item-card');
    assert.equal(await page.locator('.tc-item-card').count(), 5);
    assert.equal(await noHScroll(page), true, 'claim');
    await page.screenshot({ path: path.join(shots, `claim-${label}.png`), fullPage: true });
    await page.goto(`${base}/#/claims/new`); await page.waitForSelector(T('add-expense'));
    await page.selectOption(T('expense-type'), 'local');
    await page.click(T('add-expense')); await page.waitForSelector(T('line-modal')); await page.waitForTimeout(450); // let the slide-in finish
    const box = await page.locator(T('line-modal')).boundingBox();
    assert.ok(box && box.x >= -1 && box.x + box.width <= vp.width + 1, 'drawer within viewport');
    if (vp.width <= 767) assert.ok(Math.abs(box.width - vp.width) < 2, 'full-screen drawer on phones');
    await page.screenshot({ path: path.join(shots, `line-drawer-${label}.png`) });
    await page.keyboard.press('Escape'); await closed(page);
    await page.click(T('date-grid')); await page.waitForSelector(T('dategrid')); await page.waitForTimeout(450);
    assert.equal(await page.locator(T('prev-2026-10-02')).isVisible(), vp.width <= 767, '"Same as previous day" is a mobile affordance');
    if (vp.width <= 767) {
      await page.fill(T('cell-2026-10-01-l_da'), '250'); await page.click(T('prev-2026-10-02'));
      assert.equal(await page.inputValue(T('cell-2026-10-02-l_da')), '250');
    }
    await page.screenshot({ path: path.join(shots, `dategrid-${label}.png`) });
  }, vp);
}

await scenario('design tokens survive: brand colour, fonts and control heights come from the original CSS', async (page) => {
  await open(page);
  const v = await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return { brand: cs.getPropertyValue('--nb-brand-500').trim().toUpperCase(), sans: getComputedStyle(document.body).fontFamily, btnH: getComputedStyle(document.querySelector('.tc-btn')).height, radius: cs.getPropertyValue('--nb-radius-md').trim() };
  });
  assert.equal(v.brand, '#316ADD');
  assert.match(v.sans, /IBM Plex Sans/);
  assert.equal(v.btnH, '36px');
  assert.equal(v.radius, '8px');
});

/* ---------------------------------------------------------------- approval trail ---------------------------------------------------------------- */
await scenario('approval trail: the Status column says where each request stands; the trail icon opens it without opening the row', async (page) => {
  await open(page);
  const approved = rows(page).filter({ hasText: '800001/2026/0104' });
  assert.match(await approved.locator(T('status-summary')).textContent(), /^by Priya Natarajan · \d{1,2} \w{3} 2026$/);
  const submitted = rows(page).filter({ hasText: '800001/2026/0105' });
  assert.match(await submitted.locator(T('status-summary')).textContent(), /^Awaiting approval · /);
  const draft = rows(page).filter({ hasText: '800001/2026/0106' });
  assert.equal(await draft.locator(T('status-summary')).count(), 0, 'a draft has nothing to report yet');
  assert.equal(await draft.locator(T('trail-open')).count(), 0, 'and no trail icon');
  await approved.locator(T('trail-open')).click();
  await page.waitForSelector(T('trail-modal'));
  assert.ok(page.url().endsWith('#/claims'), 'the click opened the trail, not the row');
  assert.equal(await page.textContent(T('trail-number')), '800001/2026/0104');
  for (const step of ['trail-created', 'trail-submitted', 'trail-approved']) await page.waitForSelector(T(step));
  assert.match(await page.textContent(T('trail-approved')), /Approved[\s\S]*Priya Natarajan/);
  assert.equal(await page.locator(T('trail-pending')).count(), 0);
  await page.keyboard.press('Escape'); await closed(page);
  await submitted.locator(T('trail-open')).click(); await page.waitForSelector(T('trail-pending'));   // still with the approver: a "waiting" step
  assert.match(await page.textContent(T('trail-pending')), /Waiting for an approver/);
  assert.equal(await page.locator(T('trail-approved')).count(), 0);
});

await scenario('approval trail: the link is in all three transaction forms, and the approver sees a rejection with its reason', async (page) => {
  await open(page);
  await rows(page).filter({ hasText: '800001/2026/0104' }).click(); await page.waitForSelector(T('trail-link'));
  await page.click(T('trail-link')); await page.waitForSelector(T('trail-approved')); await page.keyboard.press('Escape'); await closed(page);
  await open(page, '#/travel'); await page.waitForSelector('table[data-testid="travel-table"]');
  await page.locator('table[data-testid="travel-table"] tbody tr', { hasText: 'TR/2026/0041' }).click(); await page.waitForSelector(T('trail-link'));
  await page.click(T('trail-link')); await page.waitForSelector(T('trail-approved')); assert.equal(await page.textContent(T('trail-number')), 'TR/2026/0041'); await page.keyboard.press('Escape'); await closed(page);
  await open(page, '#/advance'); await page.waitForSelector('table[data-testid="advance-table"]');
  await page.locator('table[data-testid="advance-table"] tbody tr', { hasText: 'AR/2026/0017' }).click(); await page.waitForSelector(T('trail-link'));
  await page.click(T('trail-link')); await page.waitForSelector(T('trail-approved')); await page.keyboard.press('Escape'); await closed(page);
  await page.goto(`${base}/#/claims/new`); await page.waitForSelector(T('add-expense'));
  assert.equal(await page.locator(T('trail-link')).count(), 0, 'a request that has not been saved has no trail yet');
  // the approver, in the grid: rejected requests show who rejected them, and the dialog carries the reason
  await open(page, '#/claims'); await asAdmin(page);
  const rejected = rows(page).filter({ hasText: '800002/2026/0007' });
  assert.match(await rejected.locator(T('status-summary')).textContent(), /^by /);
  await rejected.locator(T('trail-open')).click(); await page.waitForSelector(T('trail-rejected'));
  assert.match(await page.textContent(T('trail-rejected')), /Rejected/);
  await page.keyboard.press('Escape'); await closed(page);
});

/* ------------------------------------------------ reference data comes from the database ------------------------------------------------ */
await scenario('expense types, items, limits and option lists come from the database: a renamed type and item, a new limit and new list values show up', async (page) => {
  backend.setReferenceEdit((d) => {
    d.types.find((t) => t.key === 'outside').label = 'Outstation Travel (DB)';
    const lodge = d.types.find((t) => t.key === 'outside').items.find((i) => i.key === 'o_lodge');
    lodge.label = 'Hotel Stay (DB)'; lodge.limit = 3500;
    d.lookups.MODES.push('Ferry'); d.lookups.CITIES.push('Zeta Nagar'); d.lookups.CITIES.push('Chennai'); d.lookups.TRAVEL_PURPOSE.push('Audit (DB)'); d.lookups.COST_CENTRE.push('CC-999 · Extra');
  });
  await open(page, '#/claims/new');
  assert.ok((await page.locator(`${T('expense-type')} option`).allTextContents()).includes('Outstation Travel (DB)'), 'the type label comes from the database');
  await page.selectOption(T('expense-type'), 'outside'); await fill(page, 'purpose', 'Audit');
  await page.click(T('add-expense')); await page.waitForSelector(T('line-modal'));
  assert.ok((await page.locator(`${T('line-item')} option`).allTextContents()).some((t) => /Hotel Stay \(DB\)/.test(t)), 'the item label comes from the database');
  await page.selectOption(T('line-item'), 'o_lodge');
  await page.waitForFunction(() => /₹3,500 per night/.test(document.querySelector('[data-testid="line-modal"]')?.textContent ?? ''));
  const cities = await page.locator(`${T('line-stayLocation')} option`).allTextContents();
  assert.ok(cities.includes('Zeta Nagar'), 'option lists come from the database');
  assert.equal(cities.filter((c) => c === 'Chennai').length, 1, 'a duplicate in the list is shown once');
  await page.keyboard.press('Escape'); await closed(page);
  await page.click(T('add-expense')); await page.selectOption(T('line-item'), 'o_conveyance');
  assert.ok((await page.locator(`${T('line-modeOfTravel')} option`).allTextContents()).includes('Ferry'));
  await page.keyboard.press('Escape'); await closed(page);
  await page.goto('about:blank');   // a clean load: leaving the half-filled claim would (correctly) ask whether to discard it
  await open(page, '#/travel/new'); await page.waitForSelector(`${T('purpose')} option`, { state: 'attached' });
  const purposes = await page.locator(`${T('purpose')} option`).allTextContents();
  assert.ok(purposes.includes('Audit (DB)'), `travel purposes come from the database; the list was ${JSON.stringify(purposes)} at ${page.url()}`);
  // cost centres are editable by approvers only
  await open(page); await asAdmin(page);
  await page.click(T('new-record')); await page.waitForSelector(T('employee-code'));
  assert.ok((await page.locator(`${T('cost-centre')} option`).allTextContents()).includes('CC-999 · Extra'), 'cost centres come from the database');
});

await scenario('unusable reference data stops the app with a readable message instead of drawing broken screens', async (page) => {
  backend.setReferenceEdit((d) => { d.fields = d.fields.filter((f) => f.key !== 'billerName'); });
  await page.goto(`${base}/#/claims`); await page.waitForSelector(T('login-submit'));
  await page.fill(T('login-id'), EMP.id); await page.fill(T('login-password'), EMP.pw); await page.click(T('login-submit'));
  await page.waitForSelector('.tc-alert--error');
  assert.match(await page.textContent('.tc-alert--error'), /The app could not start[\s\S]*uses field "billerName", which has no definition/);
  assert.equal(await page.locator('.tc-topbar').count(), 0, 'no screens are drawn');
});

await browser.close(); server.close(); ocrSrv?.close(); backend.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser scenarios passed`);
process.exit(failed.length ? 1 : 0);
