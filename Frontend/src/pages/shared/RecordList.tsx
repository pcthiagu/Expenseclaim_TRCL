import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../../app/AppContext';
import { navigate } from '../../app/router';
import { Icon } from '../../components/common/Icon';
import { Tabs } from '../../components/common/Tabs';
import { Alert, Button, EmptyState, Pagination, StatusBadge, TypeTag } from '../../components/common/ui';
import { StatusCell, trailSummary } from './ApprovalTrail';
import { Field } from '../../components/forms/Field';
import { claimApproved, claimTotal, recordAmount } from '../../domain/calc';
import { EXPENSE_TYPES, KINDS, STATUSES } from '../../domain/expenseSchema';
import { defaultSortDir, emptyFilters, matchesNonStatus, paginate, sortRows, type ListFilters, type Sort } from '../../domain/lists';
import { statusLabel } from '../../domain/workflow';
import { ApiError } from '../../services/apiClient';
import type { Employee, ExpenseClaim, RecordKind, RequestStatus, TravelClaimRecord } from '../../types/domain';
import { date, dash, money } from '../../utils/format';

export interface ListPreset { label: string; test: (r: TravelClaimRecord) => boolean; kind: RecordKind | null }

interface KindState { f: ListFilters; sort: Sort; page: number; pageSize: number }
const states = new Map<RecordKind, KindState>();
const stateFor = (k: RecordKind): KindState => { let s = states.get(k); if (!s) { s = { f: emptyFilters(), sort: { key: 'requestDate', dir: 'desc' }, page: 1, pageSize: 10 }; states.set(k, s); } return s; };

const hrefOf = (r: TravelClaimRecord): string => `#/${KINDS[r.kind].route}/${encodeURIComponent(r.id)}`;
const routeOf = (k: RecordKind): string => `#/${KINDS[k].route}`;

export interface RecordListProps {
  kind: RecordKind;
  /** Embedded (dashboard): no title row, search sits in the table bar, tabs switch in place. */
  embedded?: boolean;
  preset?: ListPreset | null;
  onKindChange?: (k: RecordKind) => void;
  onPresetClear?: () => void;
  /** Bumped by the dashboard when a KPI card is clicked, to return to page 1. */
  resetToken?: number;
}

export function RecordList({ kind, embedded, preset, onKindChange, onPresetClear, resetToken }: RecordListProps) {
  const { gateway, isAdmin, session } = useApp();
  const role = session.role;
  const K = KINDS[kind];
  const [, bump] = useState(0);
  const st = stateFor(kind);
  const patch = (p: Partial<KindState>): void => { Object.assign(st, p); bump((n) => n + 1); };
  const setFilters = (p: Partial<ListFilters>): void => patch({ f: { ...st.f, ...p }, page: 1 });
  const [rows, setRows] = useState<TravelClaimRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesError, setEmployeesError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Partial<Record<RecordKind, number>>>({});
  const [q, setQ] = useState(st.f.q);
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let off = false;
    setRows(null); setError(null); setQ(stateFor(kind).f.q);
    gateway.listRecords({ kind }).then((p) => { if (!off) setRows(p.rows); }).catch((e: unknown) => { if (!off) setError(e instanceof ApiError ? e.message : `Could not load ${K.plural.toLowerCase()}.`); });
    (['claim', 'travel', 'advance'] as const).forEach((k) => gateway.listRecords({ kind: k, page: 1, pageSize: 1 }).then((p) => { if (!off) setCounts((c) => ({ ...c, [k]: p.total })); }).catch(() => undefined));
    if (isAdmin) gateway.lookupEmployees('').then((l) => { if (!off) { setEmployees(l); setEmployeesError(null); } }).catch((e: unknown) => { if (!off) setEmployeesError(e instanceof ApiError ? e.message : 'Could not load employees.'); });
    return () => { off = true; };
  }, [gateway, isAdmin, session.code, kind, K.plural]);

  useEffect(() => { if (resetToken !== undefined) patch({ page: 1 }); /* eslint-disable-next-line */ }, [resetToken]);
  useEffect(() => { const t = setTimeout(() => { if (q !== stateFor(kind).f.q) setFilters({ q }); }, 150); return () => clearTimeout(t); /* eslint-disable-next-line */ }, [q]);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => { if (anchor.current && !anchor.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', down, true); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true); };
  }, [open]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    let r = rows.filter((x) => matchesNonStatus(x, st.f, isAdmin));
    if (preset) r = r.filter(preset.test);
    if (st.f.status) r = r.filter((x) => x.status === st.f.status);
    return sortRows(r, st.sort);
  }, [rows, st.f, st.sort, preset, isAdmin]);
  const pg = paginate(filtered, st.page, st.pageSize);
  const activeFilters = [st.f.status, kind === 'claim' ? st.f.type : '', isAdmin ? st.f.employee : '', st.f.from, st.f.to].filter(Boolean).length;
  const title = isAdmin ? K.plural : 'My ' + K.plural;
  const clearFilters = (): void => patch({ f: { ...emptyFilters(), q: st.f.q }, page: 1 });

  const sortHeader = (label: string, key: string, cls?: string): ReactNode => {
    const active = st.sort.key === key;
    return (
      <th className={cls} aria-sort={active ? (st.sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" className={'tc-sort' + (active ? ' is-active' : '')} onClick={() => patch({ sort: active ? { key, dir: st.sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: defaultSortDir(key) } })}>
          {label}<Icon name={active ? (st.sort.dir === 'asc' ? 'chevron-up' : 'chevron-down') : 'sort'} />
        </button>
      </th>
    );
  };
  const rowProps = (r: TravelClaimRecord) => ({ tabIndex: 0, 'data-href': hrefOf(r), onClick: () => navigate(hrefOf(r)), onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') navigate(hrefOf(r)); } });
  const emp = (r: TravelClaimRecord): ReactNode => <>{r.employeeName} <span className="tc-text-secondary tc-mono tc-text-xs">{r.employeeCode}</span></>;
  const summary = (r: TravelClaimRecord): ReactNode => r.kind === 'travel'
    ? <>{dash(r.fromLocation)} → {dash(r.toLocation)} · {date(r.periodFrom)} – {date(r.periodTo)}</>
    : r.kind === 'advance' ? <>{date(r.periodFrom)} – {date(r.periodTo)}{r.travelRequest ? <> · <span className="tc-mono tc-text-xs">{r.travelRequest}</span></> : null}</> : null;

  const claimTable = (list: ExpenseClaim[]): ReactNode => (
    <table className="tc-table" data-testid="claims-table">
      <thead><tr>
        {sortHeader('Request Number', 'requestNumber')}{isAdmin ? sortHeader('Employee', 'employeeName') : null}{sortHeader('Expense Type', 'expenseType')}<th>Purpose</th>
        {sortHeader('Request Date', 'requestDate')}{sortHeader('Total', 'total', 'tc-num')}{sortHeader('Approved', 'approved', 'tc-num')}{sortHeader('Status', 'status')}
        {sortHeader('Submitted', 'submittedOn')}{sortHeader('Approved On', 'approvedOn')}<th>Approver</th>
      </tr></thead>
      <tbody>
        {list.map((r) => { const a = claimApproved(r); return (
          <tr key={r.id} {...rowProps(r)}>
            <td className="tc-mono">{r.requestNumber || 'Unsaved draft'}</td>{isAdmin ? <td>{emp(r)}</td> : null}<td><TypeTag typeKey={r.expenseType} /></td>
            <td className="tc-cell-trunc" title={r.purpose}>{dash(r.purpose)}</td><td>{date(r.requestDate)}</td><td className="tc-num">{money(claimTotal(r))}</td>
            <td className="tc-num">{a == null ? '—' : money(a)}</td><td><StatusCell record={r} role={role} /></td><td>{date(r.submittedOn)}</td><td>{date(r.approvedOn)}</td><td>{dash(r.approver)}</td>
          </tr>); })}
      </tbody>
    </table>
  );
  const requestTable = (list: TravelClaimRecord[]): ReactNode => (
    <table className="tc-table" data-testid={`${kind}-table`}>
      <thead><tr>
        {sortHeader('Request Number', 'requestNumber')}{isAdmin ? sortHeader('Employee', 'employeeName') : null}{sortHeader('Purpose', 'purpose')}
        <th>{kind === 'travel' ? 'Route · Period' : 'Period · Linked Travel'}</th>{sortHeader('Request Date', 'requestDate')}{sortHeader(kind === 'travel' ? 'Estimate' : 'Advance', 'total', 'tc-num')}
        {kind === 'travel' ? <th className="tc-num">Advance</th> : null}{sortHeader('Status', 'status')}{sortHeader('Submitted', 'submittedOn')}<th>Approver</th>
      </tr></thead>
      <tbody>
        {list.map((r) => (
          <tr key={r.id} {...rowProps(r)}>
            <td className="tc-mono">{r.requestNumber || 'Unsaved draft'}</td>{isAdmin ? <td>{emp(r)}</td> : null}<td>{dash(r.kind === 'claim' ? '' : r.purpose)}</td><td>{summary(r)}</td>
            <td>{date(r.requestDate)}</td><td className="tc-num">{money(recordAmount(r))}</td>{kind === 'travel' && r.kind === 'travel' ? <td className="tc-num">{money(r.advanceRequired)}</td> : null}
            <td><StatusCell record={r} role={role} /></td><td>{date(r.submittedOn)}</td><td>{dash(r.approver)}</td>
          </tr>))}
      </tbody>
    </table>
  );
  const cards = (list: TravelClaimRecord[]): ReactNode => (
    <div className="tc-list">
      {list.map((r) => (
        <a key={r.id} className="tc-list-card" href={hrefOf(r)}>
          <div className="tc-list-card__top"><span className="tc-list-card__title tc-mono">{r.requestNumber || 'Unsaved draft'}</span><StatusBadge status={r.status} role={role} /></div>
          {trailSummary(r) ? <div className="tc-text-secondary" style={{ fontSize: 12, marginTop: 2 }} data-testid="status-summary">{trailSummary(r)}</div> : null}
          {r.kind === 'claim'
            ? <><div className="tc-list-card__body">{dash(r.purpose)}</div>
                <div className="tc-list-card__meta"><TypeTag typeKey={r.expenseType} /><span>{date(r.requestDate)}</span>{isAdmin ? <span>{r.employeeName}</span> : null}<span className="tc-list-card__amount">{money(claimTotal(r))}</span></div></>
            : <><div className="tc-list-card__body">{dash(r.purpose)}{r.remarks ? <> <span className="tc-text-secondary">· {r.remarks}</span></> : null}</div>
                <div className="tc-list-card__meta"><span>{summary(r)}</span>{isAdmin ? <span>{r.employeeName}</span> : null}<span className="tc-list-card__amount">{money(recordAmount(r))}</span></div></>}
        </a>))}
    </div>
  );

  let body: ReactNode;
  if (error) body = <div style={{ padding: 16 }}><Alert tone="error" title={`Could not load ${K.plural.toLowerCase()}`}>{error}</Alert></div>;
  else if (!rows) body = <div style={{ padding: 24 }} aria-busy="true" data-testid="list-loading">Loading {K.plural.toLowerCase()}…</div>;
  else if (!pg.rows.length) {
    body = rows.length
      ? <EmptyState icon="search" title="No matches" body="Try a different search, status or filter." action={<Button size="sm" label="Clear search and filters" onClick={() => { setQ(''); patch({ f: emptyFilters(), page: 1 }); }} />} />
      : <EmptyState icon={K.icon} title={`No ${K.plural.toLowerCase()} yet`} body={isAdmin ? 'Submitted requests from employees will appear here.' : `Create your first ${K.label.toLowerCase()} to get started.`}
          action={isAdmin ? undefined : <Button size="sm" icon="plus" label={`New ${K.label}`} href={`${routeOf(kind)}/new`} />} />;
  } else {
    body = (
      <>
        <div className="tc-desktop-only"><div className="tc-table-wrap">{kind === 'claim' ? claimTable(pg.rows.filter((r): r is ExpenseClaim => r.kind === 'claim')) : requestTable(pg.rows)}</div></div>
        <div className="tc-mobile-only">{cards(pg.rows)}</div>
        <Pagination page={pg.page} pageSize={st.pageSize} total={pg.total} onPage={(p) => patch({ page: p })} onSize={(s) => patch({ pageSize: s, page: 1 })} />
      </>
    );
  }

  const search = (
    <Field type="search" value={q} onChange={(v) => setQ(String(v))} placeholder={isAdmin ? 'Search request no., employee, purpose…' : 'Search request no., purpose…'} ariaLabel={`Search ${K.plural}`} testId="list-search" />
  );
  const kindTabs = (
    <Tabs label="Request type" panelId="tc-kind-panel" active={kind}
      onSelect={(k) => { if (k === kind) return; if (embedded) onKindChange?.(k as RecordKind); else navigate(routeOf(k as RecordKind)); }}
      items={(['claim','advance'] as const).map((k) => ({ key: k, label: KINDS[k].plural, icon: KINDS[k].icon, ...(counts[k] !== undefined ? { count: counts[k] as number } : {}) }))} />
  );

  return (
    <>
      {embedded ? null : (
        <div className="tc-page-head">
          <div className="tc-page-head__text"><h1 className="tc-page-title">{title}</h1></div>
          <div className="tc-page-head__search">{search}</div>
        </div>
      )}
      {kind !== 'travel' ? <div className="tc-page-tabs">{kindTabs}</div> : null}
      <section className="tc-card tc-card--flush tc-tablecard" id="tc-kind-panel" role="tabpanel" aria-labelledby={`tc-tab-${kind}`}>
        <div className="tc-tablecard__bar">
          <h2 className="tc-tablecard__title">{title} <span className="tc-tablecard__count" data-testid="result-count">{rows ? (filtered.length === rows.length ? String(filtered.length) : `${filtered.length} of ${rows.length}`) : ''}</span></h2>
          {preset ? (
            <span className="tc-filtertag" data-testid="preset-tag"><Icon name="filter" /><span>{preset.label}</span>
              <button type="button" className="tc-filtertag__clear" aria-label={`Clear filter: ${preset.label}`} title="Clear" data-testid="preset-clear" onClick={() => { onPresetClear?.(); patch({ page: 1 }); }}><Icon name="close" /></button></span>
          ) : null}
          <span className="tc-chrome__fill" />
          {embedded ? <div className="tc-tablecard__search">{search}</div> : null}
          <span className="tc-iconbtn-wrap tc-filter-anchor" ref={anchor}>
            <button type="button" className={'tc-iconbtn tc-iconbtn--outlined' + (open ? ' is-active' : '')} aria-haspopup="dialog" aria-expanded={open} aria-label={'Filters' + (activeFilters ? `, ${activeFilters} active` : '')} title="Filters" data-testid="filters-toggle" onClick={() => setOpen(!open)}>
              <Icon name="sliders" />{activeFilters ? <span className="tc-chrome__badge" aria-hidden="true">{activeFilters}</span> : null}
            </button>
            {open ? (
              <div className="tc-filterpop" role="dialog" aria-label="Filters" data-testid="filters-pop">
                <div className="tc-filterpop__head">Filters{activeFilters ? <> <span className="tc-count">{activeFilters}</span></> : null}</div>
                <div className="tc-filterpop__body">
                  <Field label="Status" type="select" size="sm" value={st.f.status} placeholder="All" ariaLabel="Status filter" testId="filter-status"
                    options={(Object.keys(STATUSES) as RequestStatus[]).filter((k) => !(isAdmin && k === 'draft')).map((k) => ({ value: k, label: statusLabel(k, role) }))} onChange={(v) => setFilters({ status: String(v) as RequestStatus | '' })} />
                  {kind === 'claim' ? <Field label="Expense Type" type="select" size="sm" value={st.f.type} placeholder="All" testId="filter-type" options={EXPENSE_TYPES.map((t) => ({ value: t.key, label: t.label }))} onChange={(v) => setFilters({ type: String(v) })} /> : null}
                  {isAdmin ? <Field label="Employee" type="select" size="sm" value={st.f.employee} placeholder="All" testId="filter-employee" options={employees.map((e) => ({ value: e.code, label: `${e.name} · ${e.code}` }))} onChange={(v) => setFilters({ employee: String(v) })}
                    {...(employeesError ? { error: `Could not load employees: ${employeesError}` } : {})} /> : null}
                  <Field label="Request Date From" type="date" size="sm" value={st.f.from} testId="filter-from" onChange={(v) => setFilters({ from: String(v) })} />
                  <Field label="Request Date To" type="date" size="sm" value={st.f.to} testId="filter-to" onChange={(v) => setFilters({ to: String(v) })} />
                </div>
                <div className="tc-filterpop__foot">
                  <Button variant="ghost" className="tc-btn--neutral" size="sm" label="Clear filters" disabled={!activeFilters} onClick={clearFilters} />
                  <Button variant="secondary" size="sm" label="Done" onClick={() => setOpen(false)} />
                </div>
              </div>
            ) : null}
          </span>
          <Button variant="secondary" icon="plus" label={`New ${K.label}`} href={`${routeOf(kind)}/new`} data-testid="new-record" />
        </div>
        <div id="tc-list-results">{body}</div>
      </section>
    </>
  );
}
