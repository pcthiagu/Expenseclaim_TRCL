/**
 * Turns OCR text from a bill into SUGGESTED field values (date, biller, bill number, amount).
 *
 * Principles:
 *  - Suggestions only. The UI fills blank fields and tells the user to verify; it never overwrites what the
 *    user typed, and OCR output is never trusted for approval or limits (those are checked server-side).
 *  - A field is omitted when nothing plausible is found. Nothing is invented.
 *  - `confidence: 'high'` means a labelled value was found (e.g. "Grand Total 168.00", "Bill No: 4471");
 *    'low' means a fallback guess (largest amount on the page, first text line as biller, an unlabelled date).
 *  - Dates are read day-first (Indian bills), validated as real calendar dates, and must not be in the future.
 *  - Pure functions: no I/O, so they are testable and run in the browser, a worker or Node.
 *
 * Tuned on synthetic bills (restaurant, fuel, pharmacy, cab, hotel, lab, rail e-ticket). Real phone photos are
 * noisier; treat accuracy on your own bills as unknown until measured.
 */

export type Confidence = 'high' | 'low';
export interface Suggested<T> { value: T; confidence: Confidence; /** The OCR line the value came from. */ source: string }
export interface ReceiptSuggestion {
  date?: Suggested<string>;
  billerName?: Suggested<string>;
  billNumber?: Suggested<string>;
  amount?: Suggested<number>;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';

const clean = (s: string): string => s.replace(/[|_~`]+/g, ' ').replace(/\s+/g, ' ').trim();
const lines = (text: string): string[] => text.split(/\r?\n/).map(clean).filter(Boolean);
const pad = (n: number): string => (n < 10 ? '0' : '') + n;

/* ------------------------------------ amount ------------------------------------ */
const TIER1 = /(grand\s*total|net\s*payable|amount\s*payable|total\s*payable|net\s*amount|amount\s*due|total\s*amount|bill\s*amount|invoice\s*(?:total|amount|value)|total\s*fare|you\s*pay|amount\s*paid|total\s*due|total\s*invoice)/i;
const TIER2 = /\b(total|amount|fare|paid|payable)\b/i;
const EXCLUDE = /(sub\s*-?\s*total|\btax\b|gst|cgst|sgst|igst|cess|discount|round\s*-?\s*off|change|cash\s*(?:given|tender)|tender|balance|qty|quantity|\brate\b|per\s|\bkm\b|advance|\btip\b|service\s*charge|saving)/i;

function numbersIn(line: string): number[] {
  // Strip dates and long digit runs (phone numbers, GSTIN, PNR) so they are not read as money.
  const s = line.replace(/\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b/g, ' ').replace(/\b\d{9,}\b/g, ' ');
  const out: number[] = [];
  for (const m of s.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)(?![\w])/g)) {
    const v = parseFloat((m[1] ?? '').replace(/,/g, ''));
    if (Number.isFinite(v) && v > 0 && v <= 10_000_000) out.push(v);
  }
  return out;
}

/** The amount on a labelled line: the last figure that has decimals, else the last figure. */
function lineAmount(line: string): number | null {
  const nums = numbersIn(line);
  if (!nums.length) return null;
  const withDec = [...line.matchAll(/(\d[\d,]*\.\d{1,2})(?![\d])/g)].map((m) => parseFloat((m[1] ?? '').replace(/,/g, ''))).filter((v) => v > 0);
  return withDec.length ? (withDec[withDec.length - 1] as number) : (nums[nums.length - 1] as number);
}

function findAmount(ls: string[]): Suggested<number> | undefined {
  const best = (re: RegExp, skipExcluded: boolean): { v: number; line: string } | null => {
    let hit: { v: number; line: string } | null = null;
    for (const l of ls) {
      if (!re.test(l) || (skipExcluded && EXCLUDE.test(l.replace(re, ' ')))) continue;
      const v = lineAmount(l);
      if (v !== null && (!hit || v > hit.v)) hit = { v, line: l };
    }
    return hit;
  };
  const t1 = best(TIER1, false);
  if (t1) return { value: t1.v, confidence: 'high', source: t1.line };
  const t2 = best(TIER2, true);
  if (t2) return { value: t2.v, confidence: 'high', source: t2.line };
  // Fallback: the largest figure written with two decimals anywhere on the bill.
  let hit: { v: number; line: string } | null = null;
  for (const l of ls) {
    if (EXCLUDE.test(l)) continue;
    for (const m of l.matchAll(/(\d[\d,]*\.\d{2})(?![\d])/g)) {
      const v = parseFloat((m[1] ?? '').replace(/,/g, ''));
      if (v > 0 && v <= 10_000_000 && (!hit || v > hit.v)) hit = { v, line: l };
    }
  }
  return hit ? { value: hit.v, confidence: 'low', source: hit.line } : undefined;
}

/* ------------------------------------- date ------------------------------------- */
function validDate(y: number, m: number, d: number, now: Date): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  if (y < now.getFullYear() - 3) return null;
  const limit = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1); // bills are not dated in the future
  if (dt.getTime() > limit.getTime()) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
const fullYear = (y: number): number => (y < 100 ? 2000 + y : y);

function datesIn(line: string, now: Date): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\b(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})\b/g)) {
    const v = validDate(Number(m[1]), Number(m[2]), Number(m[3]), now); if (v) out.push(v);
  }
  for (const m of line.matchAll(/\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4}|\d{2})\b/g)) {
    const a = Number(m[1]), b = Number(m[2]), y = fullYear(Number(m[3]));
    const v = validDate(y, b, a, now) ?? (b > 12 ? validDate(y, a, b, now) : null); // day-first; swap only if month-first is the only valid reading
    if (v) out.push(v);
  }
  for (const m of line.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-.,]*${MON}[\\s\\-.,]*(\\d{4}|\\d{2})\\b`, 'gi'))) {
    const v = validDate(fullYear(Number(m[3])), MONTHS.indexOf((m[2] ?? '').toLowerCase()) + 1, Number(m[1]), now); if (v) out.push(v);
  }
  for (const m of line.matchAll(new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'))) {
    const v = validDate(Number(m[3]), MONTHS.indexOf((m[1] ?? '').toLowerCase()) + 1, Number(m[2]), now); if (v) out.push(v);
  }
  return out;
}

function findDate(ls: string[], now: Date): Suggested<string> | undefined {
  const label = /(date|dt\b|dated|journey|issued|bill\s*dt|invoice\s*dt|travel)/i;
  const skip = /(due|expiry|expires|valid|dob|birth|mfg|exp\b)/i;
  let first: Suggested<string> | undefined;
  for (const l of ls) {
    if (skip.test(l)) continue;
    const ds = datesIn(l, now);
    if (!ds.length) continue;
    if (label.test(l)) return { value: ds[0] as string, confidence: 'high', source: l };
    if (!first) first = { value: ds[0] as string, confidence: 'low', source: l };
  }
  return first;
}

/* ---------------------------------- bill number ---------------------------------- */
const P1 = /(bill|invoice|inv|receipt|rcpt|cash\s*memo|voucher|order|booking|trip|txn|transaction|ref(?:erence)?|ticket|document|doc)\s*(?:(?:no|number|num|nr|id)\b|#)\.?\s*[:#\-]?\s*([A-Z0-9][A-Z0-9\-/]{1,24})/i;
const P2 = /\b(pnr)\s*(?:no|number)?\s*[:#\-]?\s*([A-Z0-9]{5,12})/i;

function findBillNumber(ls: string[]): Suggested<string> | undefined {
  for (const l of ls) {
    const m = P1.exec(l) ?? P2.exec(l);
    const tok = (m?.[2] ?? '').replace(/[-/.]+$/, '');
    if (m && /\d/.test(tok) && tok.length >= 2) return { value: tok, confidence: 'high', source: l };
  }
  return undefined;
}

/* ------------------------------------- biller ------------------------------------- */
const NOT_NAME = /^(tax\s*invoice|invoice|receipt|bill|cash\s*memo|original|duplicate|copy|trip\s*receipt|gstin|gst|phone|ph\b|tel|mob|date|time|welcome|thank|customer|www\.|http|email|e-?mail)/i;
const LABELLED = /^(sold\s*by|billed\s*by|merchant|restaurant|hotel|shop|store|seller)\s*[:\-]\s*(.{3,60})$/i;

function findBiller(ls: string[]): Suggested<string> | undefined {
  for (const l of ls.slice(0, 10)) { const m = LABELLED.exec(l); if (m?.[2]) return { value: clean(m[2]), confidence: 'high', source: l }; }
  for (const l of ls.slice(0, 8)) {
    const letters = (l.match(/[A-Za-z]/g) ?? []).length;
    const nonSpace = l.replace(/\s/g, '').length;
    if (NOT_NAME.test(l) || letters < 3 || letters / Math.max(1, nonSpace) < 0.6 || l.length > 60) continue;
    if ((l.match(/\d/g) ?? []).length >= 4) continue; // addresses, phone numbers, GSTIN
    if (/[:]\s*\S/.test(l)) continue; // "Label: value" lines are fields, not the name
    return { value: l.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.)]+$/g, ''), confidence: 'low', source: l };
  }
  return undefined;
}

function parseOnePass(text: string, now: Date): ReceiptSuggestion {
  const ls = lines(text ?? '');
  const out: ReceiptSuggestion = {};
  const date = findDate(ls, now); if (date) out.date = date;
  const no = findBillNumber(ls); if (no) out.billNumber = no;
  const amt = findAmount(ls); if (amt) out.amount = amt;
  // A first-line "name" is only a plausible biller when the text also looks like a bill (or the seller is labelled).
  const biller = findBiller(ls);
  if (biller && (biller.confidence === 'high' || out.date || out.billNumber || out.amount)) out.billerName = biller;
  return out;
}

/**
 * Parses OCR text from a bill. `now` is injectable for tests.
 * The text may hold several OCR PASSES over the same image (or several PDF pages) separated by a form feed (\f). Each field is
 * taken from the FIRST pass that found it, so a cleaned-up second pass only fills what the first pass missed. Measured on
 * degraded synthetic bills this beat either pass alone, at the cost of occasional wrong values on very poor images, which is why
 * every suggestion is shown for the user to check.
 */
export function parseReceiptText(text: string, now: Date = new Date()): ReceiptSuggestion {
  const passes = String(text ?? '').split('\f').filter((t) => t.trim());
  if (passes.length <= 1) return parseOnePass(passes[0] ?? '', now);
  const out: ReceiptSuggestion = {};
  for (const t of passes) {
    const s = parseOnePass(t, now);
    if (!out.date && s.date) out.date = s.date;
    if (!out.billerName && s.billerName) out.billerName = s.billerName;
    if (!out.billNumber && s.billNumber) out.billNumber = s.billNumber;
    if (!out.amount && s.amount) out.amount = s.amount;
  }
  return out;
}

/** True when a pass found everything worth finding, so a second (slower) pass is unnecessary. */
export const isComplete = (s: ReceiptSuggestion): boolean => !!(s.date && s.billNumber && s.amount);

/** Fields the user has not filled yet, taken from a suggestion. Never overwrites existing values. */
export interface ReceiptFields { date: string; billerName: string; billNumber: string; amount: number | '' }
export function applySuggestion(cur: ReceiptFields, s: ReceiptSuggestion): { fields: ReceiptFields; filled: Array<keyof ReceiptFields> } {
  const fields = { ...cur };
  const filled: Array<keyof ReceiptFields> = [];
  if (!cur.date && s.date) { fields.date = s.date.value; filled.push('date'); }
  if (!cur.billerName.trim() && s.billerName) { fields.billerName = s.billerName.value; filled.push('billerName'); }
  if (!cur.billNumber.trim() && s.billNumber) { fields.billNumber = s.billNumber.value; filled.push('billNumber'); }
  if ((cur.amount === '' || cur.amount === 0) && s.amount) { fields.amount = s.amount.value; filled.push('amount'); }
  return { fields, filled };
}
export const hasAnySuggestion = (s: ReceiptSuggestion): boolean => !!(s.date || s.billerName || s.billNumber || s.amount);
