import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../../app/AppContext';
import { navigate } from '../../app/router';
import { Icon } from '../../components/common/Icon';
import { Alert, Button, Count, EmptyState, StatusBadge, Tag } from '../../components/common/ui';
import { StatusCell } from '../shared/ApprovalTrail';
import { APPROVALS_OLDEST_WARN_DAYS, HISTORY_DAYS } from '../../config/policy';
import { recordAmount, recordApproved } from '../../domain/calc';
import { KINDS, typeByKey } from '../../domain/expenseSchema';
import { ApiError } from '../../services/apiClient';
import type { RecordKind, TravelClaimRecord } from '../../types/domain';
import { daysAgo, date, dash, money, money0, plural, waiting } from '../../utils/format';

type Segment = 'all' | RecordKind;
const href = (r: TravelClaimRecord): string => `#/${KINDS[r.kind].route}/${encodeURIComponent(r.id)}`;
const kindTag = (k: RecordKind): ReactNode => <Tag label={KINDS[k].label} />;
const emp = (r: TravelClaimRecord): ReactNode => <>{r.employeeName} <span className="tc-text-secondary tc-mono tc-text-xs">{r.employeeCode}</span></>;
const purposeOf = (r: TravelClaimRecord): string => (r.kind === 'claim' ? r.purpose : r.purpose);

function Stat(p: { label: string; value: string; sub: string; icon: string; tone: string }) {
  return (
    <div className="tc-stat">
      <span className={`tc-stat__icon tc-stat__icon--${p.tone}`}><Icon name={p.icon} /></span>
      <div className="tc-stat__label">{p.label}</div><div className="tc-stat__value">{p.value}</div><div className="tc-stat__sub">{p.sub}</div>
    </div>
  );
}

export function ApprovalsPage() {
  const { gateway, session } = useApp();
  const role = session.role;
  const [pending, setPending] = useState<TravelClaimRecord[] | null>(null);
  const [history, setHistory] = useState<TravelClaimRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [segment, setSegment] = useState<Segment>('all');

  useEffect(() => {
    let off = false;
    Promise.all([gateway.listPendingApprovals(), gateway.listApprovalHistory(HISTORY_DAYS)])
      .then(([p, h]) => { if (!off) { setPending(p); setHistory(h); } })
      .catch((e: unknown) => { if (!off) setError(e instanceof ApiError ? e.message : 'Could not load the approvals queue.'); });
    return () => { off = true; };
  }, [gateway, session.code]);

  const view = useMemo(() => {
    const list = pending ?? [];
    const byKind: Record<RecordKind, TravelClaimRecord[]> = { claim: [], travel: [], advance: [] };
    for (const r of list) byKind[r.kind].push(r);
    const sum = (rows: TravelClaimRecord[]): number => rows.reduce((s, r) => s + recordAmount(r), 0);
    const oldest = list[0];
    return { list, byKind, sum, oldestDays: oldest ? daysAgo(oldest.submittedOn) : 0, oldestNo: oldest?.requestNumber };
  }, [pending]);

  if (error) return <div className="tc-card"><Alert tone="error" title="Could not load approvals">{error}</Alert></div>;
  if (!pending) return <div aria-busy="true" data-testid="approvals-loading">Loading…</div>;

  const shown = segment === 'all' ? view.list : view.byKind[segment];
  const count = (k: RecordKind): number => view.byKind[k].length;
  const row = (r: TravelClaimRecord) => ({ tabIndex: 0, 'data-href': href(r), onClick: () => navigate(href(r)), onKeyDown: (e: { key: string }) => { if (e.key === 'Enter') navigate(href(r)); } });

  const queue = !shown.length
    ? <EmptyState icon="check-circle" title="Queue is clear" body={segment === 'all' ? 'Nothing is waiting for your approval right now.' : `No ${KINDS[segment].plural.toLowerCase()} are waiting.`} />
    : <>
        <div className="tc-desktop-only"><div className="tc-table-wrap"><table className="tc-table" data-testid="queue-table">
          <thead><tr><th>Type</th><th>Request Number</th><th>Employee</th><th>Purpose</th><th>Submitted · Waiting</th><th className="tc-num">Amount</th><th><span className="tc-visually-hidden">Actions</span></th></tr></thead>
          <tbody>{shown.map((r) => (
            <tr key={r.id} {...row(r)}>
              <td>{kindTag(r.kind)}</td><td className="tc-mono">{r.requestNumber}</td><td>{emp(r)}</td>
              <td className="tc-cell-trunc" title={purposeOf(r)}>{dash(purposeOf(r))}{r.kind === 'claim' ? <> <span className="tc-text-secondary">· {typeByKey(r.expenseType)?.short}</span></> : null}</td>
              <td>{date(r.submittedOn)} <span className="tc-text-secondary">· {waiting(r.submittedOn)}</span></td><td className="tc-num">{money(recordAmount(r))}</td>
              <td className="tc-cell-actions"><Button variant="ghost" size="sm" label="Review" iconRight="arrow-right" href={href(r)} /></td>
            </tr>))}</tbody></table></div></div>
        <div className="tc-mobile-only"><div className="tc-list">{shown.map((r) => (
          <a key={r.id} className="tc-list-card" href={href(r)}>
            <div className="tc-list-card__top"><span className="tc-list-card__title tc-mono">{r.requestNumber}</span>{kindTag(r.kind)}</div>
            <div className="tc-list-card__body">{r.employeeName} · {dash(purposeOf(r))}</div>
            <div className="tc-list-card__meta"><span><Icon name="clock" /> Waiting {waiting(r.submittedOn)}</span><span className="tc-list-card__amount">{money(recordAmount(r))}</span></div>
          </a>))}</div></div>
      </>;

  const hist = !history.length
    ? <EmptyState icon="clock" title="No recent decisions" body="Approved and rejected requests will be listed here." />
    : <>
        <div className="tc-desktop-only"><div className="tc-table-wrap"><table className="tc-table" data-testid="history-table">
          <thead><tr><th>Type</th><th>Request Number</th><th>Employee</th><th className="tc-num">Requested</th><th className="tc-num">Approved</th><th>Outcome</th><th>Actioned On</th></tr></thead>
          <tbody>{history.map((r) => { const a = recordApproved(r); return (
            <tr key={r.id} {...row(r)}><td>{kindTag(r.kind)}</td><td className="tc-mono">{r.requestNumber}</td><td>{emp(r)}</td><td className="tc-num">{money(recordAmount(r))}</td>
              <td className="tc-num">{a == null ? '—' : money(a)}</td><td><StatusCell record={r} role={role} /></td><td>{date(r.approvedOn)}</td></tr>); })}</tbody></table></div></div>
        <div className="tc-mobile-only"><div className="tc-list">{history.map((r) => (
          <a key={r.id} className="tc-list-card" href={href(r)}>
            <div className="tc-list-card__top"><span className="tc-list-card__title tc-mono">{r.requestNumber}</span><StatusBadge status={r.status} role={role} /></div>
            <div className="tc-list-card__body">{r.employeeName} · {dash(purposeOf(r))}</div>
            <div className="tc-list-card__meta">{kindTag(r.kind)}<span>{date(r.approvedOn)}</span><span className="tc-list-card__amount">{money(recordAmount(r))}</span></div>
          </a>))}</div></div>
      </>;

  const seg = (key: Segment, label: string, icon: string | undefined, n: number) => (
    <button key={key} type="button" role="tab" className={'tc-segmented__btn' + (segment === key ? ' is-active' : '')} aria-selected={segment === key} data-testid={`segment-${key}`} onClick={() => setSegment(key)}>
      {icon ? <Icon name={icon} /> : null}<span>{label}</span><Count n={n} tone={segment === key ? 'brand' : 'neutral'} />
    </button>
  );

  return (
    <>
      <div className="tc-page-header"><div><h1 className="tc-page-title">Approvals</h1>
        <p className="tc-page-subtitle" data-testid="approvals-subtitle">{view.list.length ? `${plural(view.list.length, 'request')} waiting · ${money0(view.sum(view.list))} requested` : 'Nothing is waiting for you'}</p></div></div>
      <div className="tc-stack">
        <div className="tc-stats">
          <Stat label="Expense claims" value={String(count('claim'))} sub={`${money0(view.sum(view.byKind.claim))} claimed`} icon="receipt" tone={count('claim') ? 'info' : 'neutral'} />
          <Stat label="Travel requests" value={String(count('travel'))} sub={`${money0(view.sum(view.byKind.travel))} estimated`} icon="plane" tone={count('travel') ? 'info' : 'neutral'} />
          <Stat label="Advance requests" value={String(count('advance'))} sub={`${money0(view.sum(view.byKind.advance))} requested`} icon="banknote" tone={count('advance') ? 'info' : 'neutral'} />
          <Stat label="Oldest waiting" value={view.list.length ? plural(view.oldestDays, 'day') : '—'} sub={view.list.length ? (view.oldestNo ?? '') : 'Queue is clear'} icon="clock" tone={view.oldestDays > APPROVALS_OLDEST_WARN_DAYS ? 'warning' : 'neutral'} />
        </div>
        <section className="tc-card tc-card--flush">
          <div className="tc-card__header"><div><h2 className="tc-card__title">Queue</h2><p className="tc-card__subtitle">Oldest first. Open a request to review and act.</p></div>
            <div className="tc-segmented" role="tablist">{seg('all', 'All', undefined, view.list.length)}{seg('claim', 'Expense claims', 'receipt', count('claim'))}{seg('travel', 'Travel', 'plane', count('travel'))}{seg('advance', 'Advance', 'banknote', count('advance'))}</div></div>
          {queue}
        </section>
        <section className="tc-card tc-card--flush">
          <div className="tc-card__header"><div><h2 className="tc-card__title">Recently actioned</h2><p className="tc-card__subtitle">Approved or rejected in the last {HISTORY_DAYS} days</p></div></div>
          {hist}
        </section>
      </div>
    </>
  );
}
