import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setReferenceData } from '../../src/domain/expenseSchema.ts';
import type { ReferenceData } from '../../src/types/domain.ts';

/**
 * Builds the reference data (what TA_usp_GetReferenceData returns) by READING sql/TA/02_seed_reference.sql, so the tests and the fake backend run on exactly
 * the data the database will hold: the SQL file is the single source of truth, there is no second copy in TypeScript.
 */
type Cell = string | number | null;
type Row = Record<string, Cell>;
const seedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sql/TA/02_seed_reference.sql');

function parseTuples(text: string): Cell[][] {
  const rows: Cell[][] = [];
  let i = 0;
  const ws = (): void => { while (i < text.length && /\s/.test(text[i]!)) i++; };
  while (i < text.length) {
    if (text[i] !== '(') { i++; continue; }
    i++;
    const row: Cell[] = [];
    for (;;) {
      ws();
      if (text.startsWith("N'", i) || text[i] === "'") {
        i += text[i] === 'N' ? 2 : 1;
        let v = '';
        for (;;) {
          if (text[i] === "'" && text[i + 1] === "'") { v += "'"; i += 2; } else if (text[i] === "'") { i++; break; } else { v += text[i++]; }
          if (i > text.length) throw new Error('unterminated string in the seed');
        }
        row.push(v);
      } else if (text.startsWith('NULL', i)) { row.push(null); i += 4; }
      else {
        const m = /^-?\d+(?:\.\d+)?/.exec(text.slice(i));
        if (!m) throw new Error(`cannot read a value near: ${text.slice(i, i + 30)}`);
        row.push(Number(m[0])); i += m[0].length;
      }
      ws();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ')') { i++; break; }
      throw new Error(`unexpected character in the seed: ${text.slice(i, i + 20)}`);
    }
    rows.push(row);
  }
  return rows;
}

/** table name -> rows, from every `MERGE ... USING (VALUES ...) AS s (cols)` and `INSERT ... SELECT ... FROM (VALUES ...) AS s (...)` in the seed. */
export function parseSeed(): Record<string, Row[]> {
  const sql = fs.readFileSync(seedPath, 'utf8');
  const out: Record<string, Row[]> = {};
  for (const m of sql.matchAll(/MERGE dbo\.(TA_\w+) AS t USING \(VALUES\n([\s\S]*?)\n\) AS s \(([^)]*)\)/g)) {
    const cols = m[3]!.split(',').map((c) => c.trim());
    out[m[1]!] = parseTuples(m[2]!).map((t) => Object.fromEntries(cols.map((c, i) => [c, t[i] ?? null])));
  }
  for (const m of sql.matchAll(/INSERT dbo\.(TA_\w+) \(([^)]*)\)\nSELECT [^\n]*? FROM \(VALUES\n([\s\S]*?)\n\) AS s \(/g)) {
    const cols = m[2]!.split(',').map((c) => c.trim());
    out[m[1]!] = parseTuples(m[3]!).map((t) => Object.fromEntries(cols.map((c, i) => [c, t[i] ?? null])));
  }
  return out;
}

const some = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as T;   // FOR JSON omits NULLs

/** The same JSON the procedure returns, built from the seed. `costCentres` stands for the cost centres of the active employees. */
export function buildReferenceData(costCentres: string[] = ['CC-TEST']): ReferenceData {
  const seed = parseSeed();
  const bySort = (a: Row, b: Row): number => Number(a.SortOrder) - Number(b.SortOrder);
  const fields = [...seed.TA_FieldDef!].sort(bySort).map((r) => ({
    key: String(r.FieldKey), label: String(r.Label), type: r.FieldType as never, required: r.IsRequired === 1, computed: r.IsComputed === 1, full: r.IsFull === 1, readonly: r.IsReadonly === 1,
    ...some({ options: r.OptionsKey as string | null, placeholder: r.Placeholder as string | null, helper: r.Helper as string | null, min: r.MinValue as number | null, step: r.StepValue as number | null }),
  }));
  const types = [...seed.TA_ExpenseType!].sort(bySort).map((t) => ({
    key: String(t.TypeKey), label: String(t.Label), short: String(t.ShortLabel), family: t.Family as never, ...some({ description: t.Description as string | null }),
    showBalance: t.ShowBalance === 1, travelPeriod: t.TravelPeriod === 1,
    items: seed.TA_ExpenseItem!.filter((i) => i.TypeKey === t.TypeKey).sort(bySort).map((i) => ({
      key: String(i.ItemKey), label: String(i.Label), fields: JSON.parse(String(i.FieldList)) as never[], fixed: i.IsFixed === 1, attachmentOptional: i.AttachmentOptional === 1,
      ...some({ short: i.ShortLabel as string | null, compute: i.Compute as never, rate: i.RateKey as never, limit: i.LimitAmount as number | null, limitPer: i.LimitPer as never, limitQty: i.LimitQty as number | null, helper: i.Helper as string | null }),
    })),
  }));
  const lookups: Record<string, string[]> = {};
  for (const r of [...(seed.TA_Lookup ?? [])].sort(bySort)) (lookups[String(r.ListKey)] ??= []).push(String(r.Value));
  if (costCentres.length) lookups.COST_CENTRE = [...costCentres].sort();
  return { fields, types, lookups } as ReferenceData;
}

/** Loads the registry the way the app does at start-up. Call once at the top of any test that touches expense types or items. */
export function loadReferenceSchema(costCentres?: string[]): ReferenceData {
  const data = buildReferenceData(costCentres);
  setReferenceData(data);
  return data;
}
