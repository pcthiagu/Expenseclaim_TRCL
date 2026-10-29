import { useEffect, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { Icon } from '../../components/common/Icon';
import { Alert, Button, StatusBadge } from '../../components/common/ui';
import { ModalFrame, useModal } from '../../components/modals/ModalHost';
import { ApiError } from '../../services/apiClient';
import type { RequestStatus, Role, TrailEvent, TravelClaimRecord } from '../../types/domain';
import { date, dateTime, waiting } from '../../utils/format';

/** One short line for the Status column: where the request stands and who decided it. Null for drafts (nothing to say yet). */
export function trailSummary(r: Pick<TravelClaimRecord, 'status' | 'submittedOn' | 'approvedOn' | 'approver'>, now: Date = new Date()): string | null {
  if (r.status === 'submitted') { const w = waiting(r.submittedOn, now); return `Awaiting approval · ${w === 'Today' ? 'since today' : w}`; }
  if (r.status === 'approved' || r.status === 'rejected') return `${r.approver ? `by ${r.approver}` : 'decided'}${r.approvedOn ? ` · ${date(r.approvedOn)}` : ''}`;
  return null;
}

const VERB: Record<TrailEvent['action'], { label: string; icon: string; tone: 'neutral' | 'info' | 'success' | 'error' }> = {
  Created: { label: 'Created', icon: 'edit', tone: 'neutral' },
  Submitted: { label: 'Submitted for approval', icon: 'send', tone: 'info' },
  Approved: { label: 'Approved', icon: 'check-circle', tone: 'success' },
  Rejected: { label: 'Rejected', icon: 'x-circle', tone: 'error' },
  Copied: { label: 'Copied from a rejected claim', icon: 'copy', tone: 'neutral' },
};
const COLOUR: Record<string, string> = { neutral: 'var(--nb-text-secondary)', info: 'var(--nb-text-secondary)', success: 'var(--nb-success-500)', error: 'var(--nb-error-500)' };

/** The trail itself: loaded from the server when opened, plus a "waiting" step derived from the request while it is still with the approver. */
export function ApprovalTrailBody({ record, role }: { record: TravelClaimRecord; role: Role }) {
  const { gateway } = useApp();
  const [events, setEvents] = useState<TrailEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    setEvents(null); setError(null);
    gateway.getApprovalTrail(record.kind, record.id).then((e) => { if (!off) setEvents(e); }).catch((e: unknown) => { if (!off) setError(e instanceof ApiError ? e.message : 'Could not load the approval trail.'); });
    return () => { off = true; };
  }, [gateway, record.kind, record.id, record.status]);

  if (error) return <Alert tone="error" title="Could not load the approval trail">{error}</Alert>;
  if (!events) return <div aria-busy="true" className="tc-text-secondary">Loading…</div>;
  const pending = record.status === 'submitted';
  const label = record.kind === 'claim' ? (record.status === 'rejected' ? 'Rejection reason' : 'Approver comments') : 'Approver remarks';
  return (
    <div data-testid="trail">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <span className="tc-mono" data-testid="trail-number">{record.requestNumber}</span><StatusBadge status={record.status as RequestStatus} role={role} />
      </div>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {events.map((e, i) => {
          const v = VERB[e.action] ?? { label: e.action, icon: 'info', tone: 'neutral' as const };
          const last = i === events.length - 1 && !pending;
          return (
            <li key={`${e.action}-${i}`} data-testid={`trail-${e.action.toLowerCase()}`} style={{ display: 'flex', gap: 12, paddingBottom: last ? 0 : 16, position: 'relative' }}>
              <span aria-hidden="true" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', color: COLOUR[v.tone] }}>
                <Icon name={v.icon} />{!last ? <span style={{ flex: 1, width: 2, background: 'var(--nb-border)', marginTop: 4 }} /> : null}
              </span>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{v.label}</div>
                <div className="tc-text-secondary" style={{ fontSize: 13 }}>{e.actedByName ?? e.actedBy}{e.actedByName ? ` · ${e.actedBy}` : ''} · {dateTime(e.actedAt)}</div>
                {e.details ? <div style={{ marginTop: 4, fontSize: 13 }}><span className="tc-text-secondary">{label}: </span><span data-testid="trail-details">{e.details}</span></div> : null}
              </div>
            </li>
          );
        })}
        {pending ? (
          <li data-testid="trail-pending" style={{ display: 'flex', gap: 12 }}>
            <span aria-hidden="true" style={{ color: 'var(--nb-text-secondary)' }}><Icon name="hourglass" /></span>
            <div><div style={{ fontWeight: 600 }}>Waiting for an approver</div><div className="tc-text-secondary" style={{ fontSize: 13 }}>Submitted {date(record.submittedOn)} · {waiting(record.submittedOn) === 'Today' ? 'today' : `${waiting(record.submittedOn)} so far`}</div></div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

/** Opens the trail in a dialog. Safe to use inside table rows (the click does not open the row). */
export function useApprovalTrail(): (record: TravelClaimRecord) => void {
  const modal = useModal();
  const { session } = useApp();
  return (record) => modal.open(<ModalFrame title="Approval trail" size="sm" testId="trail-modal"><ApprovalTrailBody record={record} role={session.role} /></ModalFrame>);
}

/** The Status column: the badge, one line saying where the request stands, and a button that opens the full trail. */
export function StatusCell({ record, role }: { record: TravelClaimRecord; role: Role }) {
  const open = useApprovalTrail();
  const summary = trailSummary(record);
  return (
    <div data-testid="status-cell" style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <StatusBadge status={record.status} role={role} />
        {record.status !== 'draft' && record.requestNumber ? (
          <button type="button" aria-label={`Approval trail of ${record.requestNumber}`} title="Approval trail" data-testid="trail-open"
            style={{ background: 'none', border: 0, padding: 2, cursor: 'pointer', color: 'var(--nb-text-secondary)', lineHeight: 0 }}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); open(record); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.stopPropagation(); }}><Icon name="clock" /></button>
        ) : null}
      </span>
      {summary ? <span className="tc-text-secondary" style={{ fontSize: 12 }} data-testid="status-summary">{summary}</span> : null}
    </div>
  );
}

/** Header button for the forms (only once the request has a number, i.e. has been saved). */
export function TrailButton({ record }: { record: TravelClaimRecord | null }) {
  const open = useApprovalTrail();
  if (!record || !record.requestNumber) return null;
  return <Button variant="secondary" size="sm" icon="clock" label="Approval trail" onClick={() => open(record)} data-testid="trail-link" />;
}
