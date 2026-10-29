import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySuggestion, hasAnySuggestion, parseReceiptText } from '../src/domain/receiptOcr.ts';
import { hasTesseract, ocrFile } from './helpers/ocrCli.ts';

const NOW = new Date(2026, 9, 17); // 17 Oct 2026
const p = (t: string) => parseReceiptText(t, NOW);
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/receipts');

/* ---- end-to-end through the REAL Tesseract engine (synthetic bills; see scripts/ocr/gen_fixtures.py) ---- */
test('real Tesseract OCR -> parser: date, bill number, amount and biller for every synthetic bill (png, jpg, noisy+rotated, text/scanned PDF)', { skip: !hasTesseract() && 'tesseract not installed' }, () => {
  const expected = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')) as Record<string, { date: string; billerName: string; billNumber: string; amount: number }>;
  const names = Object.keys(expected);
  assert.ok(names.length >= 10);
  for (const f of names) {
    const s = p(ocrFile(path.join(dir, f)));
    const e = expected[f]!;
    assert.equal(s.date?.value, e.date, `${f} date`);
    assert.equal(s.billNumber?.value, e.billNumber, `${f} bill number`);
    assert.equal(s.amount?.value, e.amount, `${f} amount`);
    assert.equal(s.billerName?.value, e.billerName, `${f} biller`);
    assert.equal(s.amount?.confidence, 'high', `${f} amount is a labelled total`);
    assert.equal(s.billNumber?.confidence, 'high');
  }
});

/* ---- amount ---- */
test('amount: grand total beats sub total, tax and discount lines', () => {
  assert.equal(p('Sub Total 1,200.00\nGST 5% 60.00\nTotal 1,260.00').amount?.value, 1260);
  assert.equal(p('Items 3\nSub Total 500.00\nCGST 2.5% 12.50\nSGST 2.5% 12.50\nGrand Total 525.00\nCash 600.00\nChange 75.00').amount?.value, 525);
  assert.equal(p('Medicines 700.00\nDiscount 60.00\nNet Payable Rs 640.00').amount?.value, 640);
});
test('amount: Indian digit grouping, currency prefixes and words around the figure', () => {
  assert.equal(p('Total Amount: Rs. 1,05,600.00').amount?.value, 105600);
  assert.equal(p('TOTAL ₹ 12,345.50').amount?.value, 12345.5);
  assert.equal(p('Amount Payable INR 2200').amount?.value, 2200);
  assert.equal(p('Total Fare Rs 2450.00 (incl. taxes)').amount?.value, 2450);
});
test('amount: quantity/rate lines, phone numbers, GSTIN and dates are never read as money', () => {
  assert.equal(p('Ph: 044 24916789\nGSTIN 33AAACS1234F1Z5\nDate 21/09/2026\nQty 35.00 L\nRate 104.00\nAmount 3640.00').amount?.value, 3640);
  assert.equal(p('Total GST 45.00').amount, undefined, 'a tax-only line is not an amount');
  assert.equal(p('Ph: 9840012345\nBill No 4471').amount, undefined);
});
test('amount: with no labelled total, falls back to the largest two-decimal figure and says it is low confidence', () => {
  const a = p('Dosa 60.00\nCoffee 25.00\nVada 40.00\n125.00').amount;
  assert.deepEqual([a?.value, a?.confidence], [125, 'low']);
  assert.equal(p('Thank you for shopping').amount, undefined);
});

/* ---- date ---- */
test('date: day-first numeric, short year, month names, ISO', () => {
  assert.equal(p('Date: 05/10/2026').date?.value, '2026-10-05', 'ambiguous 05/10 is read day-first (5 Oct)');
  assert.equal(p('Date 21-09-2026').date?.value, '2026-09-21');
  assert.equal(p('Dt. 21.09.26').date?.value, '2026-09-21');
  assert.equal(p('Date: 21st Sep, 2026').date?.value, '2026-09-21');
  assert.equal(p('Bill Date: 09 Oct 2026').date?.value, '2026-10-09');
  assert.equal(p('Invoice date September 21, 2026').date?.value, '2026-09-21');
  assert.equal(p('Journey 23-Sep-2026').date?.value, '2026-09-23');
  assert.equal(p('2026-09-21 13:42').date?.value, '2026-09-21');
});
test('date: month-first is used only when day-first is impossible', () => {
  assert.equal(p('Date: 09/21/2026').date?.value, '2026-09-21');
});
test('date: future, impossible and very old dates are rejected', () => {
  assert.equal(p('Date: 25/12/2026').date, undefined, 'future');
  assert.equal(p('Date: 31/02/2026').date, undefined, '31 Feb');
  assert.equal(p('Date: 01/01/2019').date, undefined, 'older than 3 years');
  assert.equal(p('Date: 18/10/2026').date?.value, '2026-10-18', 'one day ahead tolerated for time-zone/clock skew');
});
test('date: labelled date wins over other dates; due/expiry dates are ignored', () => {
  const s = p('Due Date: 30/09/2026\nExp 12/2027\nDate: 21/09/2026');
  assert.deepEqual([s.date?.value, s.date?.confidence], ['2026-09-21', 'high']);
  const u = p('Printed 21/09/2026').date;
  assert.deepEqual([u?.value, u?.confidence], ['2026-09-21', 'low'], 'unlabelled date is low confidence');
});

/* ---- bill number ---- */
test('bill number: labelled forms; the label word alone is never the number', () => {
  assert.equal(p('Bill No: 4471').billNumber?.value, '4471');
  assert.equal(p('Bill No. AD-55821').billNumber?.value, 'AD-55821');
  assert.equal(p('Invoice No.: INV/2026/0091').billNumber?.value, 'INV/2026/0091');
  assert.equal(p('Order ID: OD123456789012').billNumber?.value, 'OD123456789012');
  assert.equal(p('PNR: 4412098765').billNumber?.value, '4412098765');
  assert.equal(p('Receipt # R-5582').billNumber?.value, 'R-5582');
  assert.equal(p('Bill Date: 09 Oct 2026').billNumber, undefined, '"Bill Date" is not "Bill No"');
  assert.equal(p('Invoice Date: 25/09/2026\nTAX INVOICE').billNumber, undefined);
  assert.equal(p('GSTIN: 33AAACS1234F1Z5').billNumber, undefined);
  assert.equal(p('Bill No: ABC').billNumber, undefined, 'a number token must contain a digit');
});

/* ---- biller ---- */
test('biller: first real name line; skips headings, addresses, phone and GSTIN; labelled seller wins', () => {
  assert.equal(p('TAX INVOICE\nORIGINAL\nLEMON TREE HOTEL\nWhitefield 560066\nTotal 100.00').billerName?.value, 'LEMON TREE HOTEL');
  assert.equal(p('044 24916789\nGSTIN: 33AAA\nHotel Sangeetha\nBill No 7781').billerName?.value, 'Hotel Sangeetha');
  assert.deepEqual([p('Sold by: Murugan Idli Shop\nBill No 912').billerName?.value, p('Sold by: Murugan Idli Shop').billerName?.confidence], ['Murugan Idli Shop', 'high']);
  assert.equal(p('Date: 21/09/2026\nTotal 10.00').billerName, undefined, 'no name line -> no guess');
  assert.equal(p('SARAVANA BHAVAN\nTotal 168.00').billerName?.confidence, 'low');
  assert.equal(p('SARAVANA BHAVAN').billerName, undefined, 'a lone name line does not look like a bill, so no biller is suggested');
  assert.equal(p('Hello world').billerName, undefined);
});

/* ---- robustness ---- */
test('empty, garbage and non-bill text produce no suggestions (and never throw)', () => {
  for (const t of ['', '   \n\n ', '@@@ ### !!!', 'Hello world', '\u0000\u0001', 'x'.repeat(5000)]) {
    assert.equal(hasAnySuggestion(p(t)), false, JSON.stringify(t.slice(0, 20)));
  }
  assert.doesNotThrow(() => parseReceiptText(undefined as unknown as string));
});

test('applySuggestion fills only blanks and reports what it filled; user input is never overwritten', () => {
  const s = p('SARAVANA BHAVAN\nBill No: 4471\nDate: 21/09/2026\nGrand Total 168.00');
  const blank = applySuggestion({ date: '', billerName: '', billNumber: '', amount: '' }, s);
  assert.deepEqual(blank.fields, { date: '2026-09-21', billerName: 'SARAVANA BHAVAN', billNumber: '4471', amount: 168 });
  assert.deepEqual(blank.filled, ['date', 'billerName', 'billNumber', 'amount']);
  const typed = applySuggestion({ date: '2026-09-01', billerName: 'My cafe', billNumber: 'X1', amount: 99 }, s);
  assert.deepEqual(typed.fields, { date: '2026-09-01', billerName: 'My cafe', billNumber: 'X1', amount: 99 });
  assert.deepEqual(typed.filled, []);
  const part = applySuggestion({ date: '', billerName: '  ', billNumber: '', amount: 0 }, s);
  assert.deepEqual(part.filled, ['date', 'billerName', 'billNumber', 'amount'], 'whitespace and 0 count as blank');
});

test('multi-pass text (form-feed separated): each field comes from the FIRST pass that found it; later passes only fill gaps', () => {
  const pass1 = 'SARAVANA BHAVAN\nBill No: 4471\nGrand Total 168.00';          // no date
  const pass2 = 'SARAVANA BHAVAN\nBill No: 9999\nDate: 21/09/2026\nGrand Total 1680.00'; // different (worse) bill no and amount
  const s = p(pass1 + '\f' + pass2);
  assert.deepEqual([s.billNumber?.value, s.amount?.value, s.date?.value], ['4471', 168, '2026-09-21'], 'pass 1 wins where it found a value; the date was only in pass 2');
  assert.equal(p(pass1 + '\f' + '   \n').amount?.value, 168, 'blank trailing passes (Tesseract / pdftotext end pages with \\f) are ignored');
  assert.deepEqual(p(pass1).date, undefined);
});
test('isComplete is true only when date, bill number and amount were all read', async () => {
  const { isComplete } = await import('../src/domain/receiptOcr.ts');
  assert.equal(isComplete(p('Date: 21/09/2026\nBill No: 4471\nTotal 168.00')), true);
  assert.equal(isComplete(p('Bill No: 4471\nTotal 168.00')), false);
});
