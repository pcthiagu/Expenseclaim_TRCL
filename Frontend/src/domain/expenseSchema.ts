import type {
  ExpenseItemDef, ExpenseTypeDef, FieldDef, FieldKey, RecordKind, ReferenceData, RequestStatus,
} from '../types/domain';

/**
 * Expense types, items, field definitions and option lists are NOT defined in the app. They are loaded from the database
 * (TA_usp_GetReferenceData -> setReferenceData) when the app starts, into the live objects below. Until then they are empty;
 * the app does not start without them. Statuses and kinds are workflow concepts of the app itself and stay in code.
 */
export const FIELD_DEFS = {} as Record<FieldKey, FieldDef>;
export const EXPENSE_TYPES: ExpenseTypeDef[] = [];
export const LOOKUPS: Record<string, string[]> = {};
let loaded = false;
export const isReferenceDataLoaded = (): boolean => loaded;
/** An option list from the database (MODES, CITIES, TRAVEL_PURPOSE, ESTIMATE_ITEM, COST_CENTRE); empty when the list does not exist. */
export const lookup = (key: string): readonly string[] => LOOKUPS[key] ?? [];

/** The field keys the app knows how to draw. The DATABASE defines labels, rules and which items use which fields; a new key needs a screen change. */
export const KNOWN_FIELD_KEYS: readonly FieldKey[] = [
  'date', 'fromDate', 'toDate', 'fromTime', 'toTime', 'time', 'modeOfTravel', 'stayLocation', 'fromLocation', 'toLocation', 'billerName', 'billNumber',
  'fromKm', 'toKm', 'totalKm', 'nonAccountableKm', 'qty', 'amount', 'limit', 'remarks', 'alongWith', 'attachment',
];

/** Replaces the live reference data (in place, so every module sees it). Throws a readable error if the database data is unusable. */
export function setReferenceData(data: ReferenceData): void {
  if (!data || !Array.isArray(data.fields) || !Array.isArray(data.types) || typeof data.lookups !== 'object' || data.lookups === null) throw new Error('The reference data from the database is not in the expected shape.');
  const known = new Set<string>(KNOWN_FIELD_KEYS);
  const defs = {} as Record<FieldKey, FieldDef>;
  for (const r of data.fields) {
    if (!known.has(r.key)) throw new Error(`The database defines a field the app does not know how to show: "${r.key}".`);
    const d: FieldDef = { label: r.label, type: r.type };
    if (r.required) d.required = true;
    if (r.computed) d.computed = true;
    if (r.full) d.full = true;
    if (r.readonly) d.readonly = true;
    if (r.options) d.options = r.options;
    if (r.placeholder) d.placeholder = r.placeholder;
    if (r.helper) d.helper = r.helper;
    if (typeof r.min === 'number') d.min = r.min;
    if (typeof r.step === 'number') d.step = r.step;
    defs[r.key as FieldKey] = d;
  }
  if (!data.types.length) throw new Error('The database has no expense types configured (TA_ExpenseType).');
  const seen = new Set<string>();
  for (const t of data.types) {
    if (!t.items?.length) throw new Error(`Expense type "${t.key}" has no items configured (TA_ExpenseItem).`);
    for (const i of t.items) {
      if (seen.has(i.key)) throw new Error(`Expense item "${i.key}" is defined twice.`);
      seen.add(i.key);
      for (const f of i.fields) if (!defs[f]) throw new Error(`Expense item "${i.key}" uses field "${f}", which has no definition (TA_FieldDef).`);
      const raw = i as typeof i & { EnforceEligibility?: unknown };
      const flag = raw.enforceEligibility ?? raw.EnforceEligibility;
      if (flag != null && flag !== '') {
        const normalized = String(flag).trim().toUpperCase();
        if (normalized !== 'Y' && normalized !== 'N') throw new Error(`Expense item "${i.key}" has an invalid enforce eligibility flag; expected Y or N.`);
      }
    }
  }
  for (const k of Object.keys(FIELD_DEFS)) delete (FIELD_DEFS as Record<string, unknown>)[k];
  Object.assign(FIELD_DEFS, defs);
  EXPENSE_TYPES.splice(0, EXPENSE_TYPES.length, ...data.types.map((t) => ({
    ...t,
    items: t.items.map((i) => {
      const raw = i as typeof i & { EnforceEligibility?: unknown };
      const flag = raw.enforceEligibility ?? raw.EnforceEligibility;
      return { ...i, ...(flag == null || flag === '' ? {} : { enforceEligibility: String(flag).trim().toUpperCase() as 'Y' | 'N' }) };
    }),
  })));
  for (const k of Object.keys(LOOKUPS)) delete LOOKUPS[k];
  for (const [k, v] of Object.entries(data.lookups)) LOOKUPS[k] = [...new Set(v)];   // a list never shows the same value twice (also keeps React keys unique)
  loaded = true;
}

/** Column order for the desktop line-item grid (Screen Layout – Desktop). */
export const GRID_COLUMNS: readonly FieldKey[] = [
  'date', 'billerName', 'billNumber', 'amount', 'qty', 'limit', 'remarks', 'attachment',
  'fromLocation', 'toLocation', 'stayLocation', 'modeOfTravel',
  'fromDate', 'toDate', 'fromTime', 'toTime',
  'fromKm', 'toKm', 'totalKm', 'nonAccountableKm', 'alongWith',
];

export interface StatusDef { key: RequestStatus; label: string; tone: 'neutral' | 'info' | 'success' | 'error' }
export const STATUSES: Record<RequestStatus, StatusDef> = {
  draft: { key: 'draft', label: 'Draft', tone: 'neutral' },
  submitted: { key: 'submitted', label: 'Submitted', tone: 'info' },
  approved: { key: 'approved', label: 'Approved', tone: 'success' },
  rejected: { key: 'rejected', label: 'Rejected', tone: 'error' },
};

export interface KindDef { key: RecordKind; label: string; plural: string; route: string; icon: string }
export const KINDS: Record<RecordKind, KindDef> = {
  claim: { key: 'claim', label: 'Expense Claim', plural: 'Expense Claims', route: 'claims', icon: 'receipt' },
  travel: { key: 'travel', label: 'Travel Request', plural: 'Travel Requests', route: 'travel', icon: 'plane' },
  advance: { key: 'advance', label: 'Advance Request', plural: 'Advance Requests', route: 'advance', icon: 'banknote' },
};
Object.defineProperty(KINDS, 'travel', { enumerable: false });

export function typeByKey(key: string | undefined | null, types: readonly ExpenseTypeDef[] = EXPENSE_TYPES): ExpenseTypeDef | null {
  return types.find((t) => t.key === key) ?? null;
}

export function itemByKey(typeKey: string, itemKey: string, types: readonly ExpenseTypeDef[] = EXPENSE_TYPES): ExpenseItemDef | null {
  const t = typeByKey(typeKey, types);
  return t?.items.find((i) => i.key === itemKey) ?? null;
}

/** Items marked `fixed` become the columns of the date-wise entry grid. */
export function fixedItems(type: ExpenseTypeDef): ExpenseItemDef[] {
  return type.items.filter((i) => i.fixed);
}
