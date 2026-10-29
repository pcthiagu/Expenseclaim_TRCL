import { DEFAULT_POLICY } from '../config/policy';

/**
 * Formatting helpers ported from js/store.js (TC.fmt). Date strings are 'YYYY-MM-DD' (optionally
 * followed by 'THH:mm[:ss]'); they are parsed as LOCAL calendar dates, as in the prototype.
 * Functions that depend on "now" accept it as a parameter so they are testable.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const nf2 = new Intl.NumberFormat(DEFAULT_POLICY.locale, { style: 'currency', currency: DEFAULT_POLICY.currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat(DEFAULT_POLICY.locale, { style: 'currency', currency: DEFAULT_POLICY.currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });
const nfn = new Intl.NumberFormat(DEFAULT_POLICY.locale);

function pad(n: number): string { return (n < 10 ? '0' : '') + n; }

/** parseFloat that maps anything non-finite to 0 (prototype `num`). Note: parseFloat('1,000') === 1. */
export function num(v: unknown): number {
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : 0;
}

export function parseDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const p = String(iso).slice(0, 10).split('-');
  if (p.length < 3 || !p[2]) return null;
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

export const money = (n: unknown): string => nf2.format(num(n));
/** Rounds to a whole rupee for display only. */
export const money0 = (n: unknown): string => nf0.format(Math.round(num(n)));
export const numFmt = (n: unknown): string => nfn.format(num(n));

export function date(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function longDate(iso: string | null | undefined): string {
  const d = parseDate(iso);
  if (!d) return '—';
  return `${DAYS_LONG[d.getDay()]}, ${d.getDate()} ${MONTHS_LONG[d.getMonth()]} ${d.getFullYear()}`;
}

export function monthLabel(ym: string): string {
  const p = String(ym).split('-');
  return `${MONTHS[Number(p[1]) - 1]} ${p[0]}`;
}

export function time(t: string | null | undefined): string {
  if (!t) return '—';
  const p = String(t).split(':');
  const h = Number(p[0]);
  const ap = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12}:${p[1] || '00'} ${ap}`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const parts = String(iso).split('T');
  return date(parts[0]) + (parts[1] ? ', ' + time(parts[1]) : '');
}

export function today(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function nowIso(now: Date = new Date()): string {
  return `${today(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

export function daysBetween(a: string | null | undefined, b: string | null | undefined): number {
  const da = parseDate(a);
  const db = parseDate(b);
  if (!da || !db) return 0;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

export function daysAgo(iso: string | null | undefined, now: Date = new Date()): number {
  return daysBetween(iso, today(now));
}

export function waiting(iso: string | null | undefined, now: Date = new Date()): string {
  const d = daysAgo(iso, now);
  if (d <= 0) return 'Today';
  if (d === 1) return '1 day';
  return `${d} days`;
}

export function fileSize(bytes: unknown): string {
  const b = num(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}

export function initials(name: string | null | undefined): string {
  return String(name ?? '').split(/\s+/).filter(Boolean).slice(0, 2).map((s) => (s[0] ?? '').toUpperCase()).join('');
}

export function dash(v: unknown): string {
  return v === undefined || v === null || v === '' ? '—' : String(v);
}

export function plural(n: number, one: string, many?: string): string {
  return `${n} ${n === 1 ? one : (many ?? one + 's')}`;
}

/** Calendar-safe day arithmetic on 'YYYY-MM-DD' strings (UTC based, as the date-wise grid does). */
export function addDays(iso: string, n: number): string {
  const p = iso.split('-');
  const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]) + n));
  return d.toISOString().slice(0, 10);
}

export const fmt = {
  num, money, money0, numFmt, date, longDate, monthLabel, time, dateTime, today, nowIso,
  daysBetween, daysAgo, waiting, fileSize, initials, dash, plural, addDays,
};
