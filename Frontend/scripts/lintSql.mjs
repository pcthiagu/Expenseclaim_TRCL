// Static checks for sql/TA/*.sql (no SQL Server needed). It CANNOT prove the SQL runs; it catches the mistakes a script can detect:
// unbalanced quotes/parentheses/BEGIN-END/CASE-END, CREATE OR ALTER not first in its batch, references to objects that do not exist,
// and alias.Column references to columns that do not exist on a TA_ table. Run: node scripts/lintSql.mjs
import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.SQL_DIR ?? path.resolve(import.meta.dirname, '../sql/TA');
const files = fs.readdirSync(dir).filter((f) => /^\d\d_.*\.sql$/.test(f)).sort();
const problems = [];
const bad = (f, msg) => problems.push(`${f}: ${msg}`);

// A small T-SQL tokenizer: removes comments (line comments, NESTABLE block comments) and replaces string literals with '' so the
// checks below only see code. Returns { code, openString } (openString = a string or block comment that never closes).
function tokenize(sql) {
  let out = ''; let i = 0; let state = 'code'; let depth = 0;
  while (i < sql.length) {
    const c = sql[i]; const n = sql[i + 1];
    if (state === 'code') {
      if (c === '-' && n === '-') { state = 'line'; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; depth = 1; i += 2; continue; }
      if (c === "'") { state = 'string'; out += "''"; i++; continue; }
      out += c; i++;
    } else if (state === 'line') { if (c === '\n') { state = 'code'; out += c; } i++; }
    else if (state === 'block') {
      if (c === '/' && n === '*') { depth++; i += 2; } else if (c === '*' && n === '/') { depth--; i += 2; if (depth === 0) state = 'code'; } else { if (c === '\n') out += c; i++; }
    } else { // string
      if (c === "'" && n === "'") { i += 2; } else if (c === "'") { state = 'code'; i++; } else { if (c === '\n') out += ''; i++; }
    }
  }
  return { code: out, open: state === 'string' ? 'a string literal' : state === 'block' ? 'a block comment' : null };
}
const strip = (sql) => tokenize(sql).code;
const all = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));

// ---- defined objects and table columns
const defined = new Map(); const columns = new Map();
for (const f of files) {
  const s = strip(all[f]);
  for (const m of s.matchAll(/CREATE\s+(?:OR\s+ALTER\s+)?(TABLE|VIEW|FUNCTION|PROCEDURE)\s+dbo\.(\w+)/gi)) defined.set(m[2].toLowerCase(), { kind: m[1].toUpperCase(), file: f });
  for (const m of s.matchAll(/CREATE\s+TABLE\s+dbo\.(\w+)\s*\(([\s\S]*?)\n\s*\);/gi)) {
    const cols = new Set();
    for (const line of m[2].split(/\n/)) { const c = /^\s*(\w+)\s+(?:NVARCHAR|VARCHAR|CHAR|INT|BIGINT|BIT|DATE|DATETIME2|DECIMAL|UNIQUEIDENTIFIER|ROWVERSION)/i.exec(line); if (c) cols.add(c[1].toLowerCase()); }
    columns.set(m[1].toLowerCase(), cols);
  }
}
// dbo.TA_vw_Employee is created through EXEC (N'CREATE VIEW ...') in 01_tables.sql (a CREATE VIEW must be first in its batch): invisible to a static scan.
defined.set('ta_vw_employee', { kind: 'VIEW', file: '01_tables.sql (dynamic)' });
for (const f of files) {   // columns added by re-runnable ALTER TABLE ... ADD statements
  for (const m of strip(all[f]).matchAll(/ALTER\s+TABLE\s+dbo\.(\w+)\s+ADD\s+(\w+)\s/gi)) columns.get(m[1].toLowerCase())?.add(m[2].toLowerCase());
}
const builtIns = new Set(['sys', 'sysobjects']);

for (const f of files) {
  const raw = all[f]; const s = strip(raw);
  const open = tokenize(raw).open;
  if (open) bad(f, `${open} is never closed`);
  let depth = 0; for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (depth < 0) break; }
  if (depth !== 0) bad(f, `unbalanced parentheses (${depth > 0 ? depth + ' unclosed' : 'extra )'})`);

  // BEGIN/END balance per batch: BEGIN TRAN/TRANSACTION and BEGIN TRY/CATCH are special
  s.split(/^\s*GO\s*$/gim).forEach((batch, i) => {
    const begins = (batch.match(/\bBEGIN\b(?!\s+(?:TRAN|TRANSACTION|TRY|CATCH)\b)/gi) ?? []).length;
    const cases = (batch.match(/\bCASE\b/gi) ?? []).length;
    const ends = (batch.match(/\bEND\b(?!\s+(?:TRY|CATCH)\b)/gi) ?? []).length;
    if (begins + cases !== ends) bad(f, `batch ${i + 1}: BEGIN(${begins}) + CASE(${cases}) != END(${ends})`);
    for (const kw of ['TRY', 'CATCH']) {
      const b = (batch.match(new RegExp(`\\bBEGIN\\s+${kw}\\b`, 'gi')) ?? []).length, e = (batch.match(new RegExp(`\\bEND\\s+${kw}\\b`, 'gi')) ?? []).length;
      if (b !== e) bad(f, `batch ${i + 1}: BEGIN ${kw} (${b}) != END ${kw} (${e})`);
    }
    // CREATE OR ALTER must be the first statement in its batch
    const create = /CREATE\s+(?:OR\s+ALTER\s+)?(?:PROCEDURE|FUNCTION|VIEW)\b/i.exec(batch);
    if (create && batch.slice(0, create.index).replace(/\s+/g, '') !== '' && !/^(\s*SET\s+NOCOUNT\s+ON\s*;?\s*)$/i.test(batch.slice(0, create.index)) && /\S/.test(batch.slice(0, create.index))) bad(f, `batch ${i + 1}: CREATE ... is not the first statement in its batch`);
    if ((batch.match(/CREATE\s+(?:OR\s+ALTER\s+)?(?:PROCEDURE|FUNCTION|VIEW)\b/gi) ?? []).length > 1) bad(f, `batch ${i + 1}: more than one CREATE PROCEDURE/FUNCTION/VIEW in a batch`);
  });
  if (!/\bGO\s*$/i.test(raw.trim())) bad(f, 'file does not end with GO');

  // references to dbo.* objects
  for (const m of s.matchAll(/\bdbo\.(\w+)/gi)) { const n = m[1].toLowerCase(); if (!defined.has(n) && !builtIns.has(n) && !/^ta_zz_/.test(n)) bad(f, `references dbo.${m[1]} which is not defined in sql/TA`); }

  // alias.Column against TA_ table columns, statement by statement
  for (const stmt of s.split(/;|\bGO\b/i)) {
    const alias = new Map();
    for (const m of stmt.matchAll(/\b(?:FROM|JOIN|UPDATE|DELETE)\s+dbo\.(TA_\w+)\s*(?:AS\s+)?(\w+)?/gi)) {
      const t = m[1].toLowerCase(); const a = (m[2] ?? '').toLowerCase();
      if (a && !/^(WITH|ON|WHERE|SET|JOIN|LEFT|INNER|CROSS|OUTER|WHEN|USING|VALUES|SELECT|FOR|ORDER|GROUP)$/i.test(a)) alias.set(a, t);
    }
    for (const m of stmt.matchAll(/\b(\w+)\.(\w+)\b/g)) {
      const a = m[1].toLowerCase(); const c = m[2].toLowerCase(); const t = alias.get(a);
      if (t && columns.has(t) && !columns.get(t).has(c)) bad(f, `column ${m[1]}.${m[2]} does not exist on dbo.${t}`);
    }
  }
}

// every procedure the frontend calls exists
const contract = fs.readFileSync(path.resolve(import.meta.dirname, '../src/services/spContract.ts'), 'utf8');   // (the contract check always uses the repo copy)
for (const m of contract.matchAll(/'(TA_usp_\w+)'/g)) if (!defined.has(m[1].toLowerCase())) problems.push(`spContract.ts: ${m[1]} is not created by sql/TA`);

console.log(`${files.length} files, ${defined.size} objects (${[...defined.values()].filter((d) => d.kind === 'PROCEDURE').length} procedures)`);
if (problems.length) { console.log('\nPROBLEMS:\n - ' + problems.join('\n - ')); process.exit(1); }
console.log('static checks passed (syntax and execution are NOT verified: run the files on SQL Server)');
