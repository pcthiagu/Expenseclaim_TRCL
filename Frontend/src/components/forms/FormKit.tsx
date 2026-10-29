import { useRef } from 'react';
import type { ReactNode } from 'react';
import { useActionBarHeight } from '../common/Toast';
import { Alert, Button, StatusBadge } from '../common/ui';
import { Field, ReadonlyField } from './Field';
import { date, dateTime } from '../../utils/format';
import type { RequestStatus, Role } from '../../types/domain';

/** Pieces shared by the travel and advance request forms (markup from the prototype's TC.formKit). */
export function PageHeader(p: { title: string; mono: boolean; status: RequestStatus; role: Role; subtitle: string; backLabel: string; onBack: () => void; actions?: ReactNode }) {
  return (
    <div className="tc-page-header">
      <div className="tc-page-header__text">
        <Button variant="ghost" className="tc-btn--neutral tc-page-header__back" iconOnly icon="arrow-left" label={p.backLabel} onClick={p.onBack} data-testid="back" />
        <div>
          <h1 className="tc-page-title"><span className={p.mono ? 'tc-mono' : ''} data-testid="page-title">{p.title}</span><StatusBadge status={p.status} role={p.role} /></h1>
          <p className="tc-page-subtitle">{p.subtitle}</p>
        </div>
      </div>
      {p.actions ? <div className="tc-page-actions">{p.actions}</div> : null}
    </div>
  );
}

export function EmployeeFields(p: { code: string; name: string; editable: boolean; isAdmin: boolean; error?: string; onCode: (v: string) => void; onBlur: () => void; onHelp: () => void }) {
  return (
    <>
      {p.editable && p.isAdmin
        ? <Field label="Employee Code" required value={p.code} placeholder="e.g. 800001" inputMode="numeric" error={p.error} testId="employee-code" onChange={(v) => p.onCode(String(v))} onBlur={p.onBlur}
            suffix={<Button icon="search" label="Help" onClick={p.onHelp} data-testid="emp-help" />} />
        : <ReadonlyField label="Employee Code" value={p.code} mono helper={p.editable ? 'Read-only for the employee role' : undefined} />}
      <ReadonlyField label="Employee Name" value={p.name} />
    </>
  );
}

export function RequestNumberField(p: { value: string; onChange: (v: string) => void; onGet: () => void }) {
  return (
    <div className="tc-field">
      <label className="tc-label" htmlFor="tc-reqno">Request Number</label>
      <div className="tc-input-row">
        <input className="tc-input tc-mono" id="tc-reqno" type="text" value={p.value} placeholder="Assigned on first save" autoComplete="off" spellCheck={false} data-testid="reqno"
          onChange={(e) => p.onChange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); p.onGet(); } }} />
        <Button label="Get" onClick={p.onGet} data-testid="get-request" />
      </div>
      <p className="tc-helper">Type a request number and choose Get to open it</p>
    </div>
  );
}

export function StatusField(p: { status: RequestStatus; role: Role; submittedOn: string | null; approvedOn: string | null; approver: string | null; updatedAt: string; isNew: boolean }) {
  const note = p.status === 'submitted' ? `Submitted ${date(p.submittedOn)}` : p.status === 'approved' ? `Approved ${date(p.approvedOn)} by ${p.approver}`
    : p.status === 'rejected' ? `Rejected ${date(p.approvedOn)} by ${p.approver}` : p.isNew ? 'Not saved yet' : `Saved ${dateTime(p.updatedAt)}`;
  return <div className="tc-field"><span className="tc-label">Status</span><div className="tc-readonly"><StatusBadge status={p.status} role={p.role} /><span className="tc-text-secondary tc-text-s">{note}</span></div></div>;
}

export function Banner(p: { summary: string[]; status: RequestStatus; isAdmin: boolean; approver: string | null; approvedOn: string | null; submittedOn: string | null; rejectionText: string; approvedBody: string; adminBody: string }) {
  if (p.summary.length) {
    return <Alert tone="error" id="tc-form-summary" title={p.summary.length === 1 ? 'Please fix this before continuing' : `Please fix these ${p.summary.length} items before continuing`}><ul>{p.summary.map((s) => <li key={s}>{s}</li>)}</ul></Alert>;
  }
  if (p.status === 'rejected') return <Alert tone="error" title={`Rejected by ${p.approver} on ${date(p.approvedOn)}`}>{p.rejectionText || 'No reason recorded.'}</Alert>;
  if (p.status === 'approved') return <Alert tone="success" title={`Approved by ${p.approver} on ${date(p.approvedOn)}`}>{p.approvedBody}</Alert>;
  if (p.status === 'submitted') return <Alert tone="info" title={p.isAdmin ? 'Awaiting your approval' : 'Awaiting approval'}>{p.isAdmin ? p.adminBody : `Submitted on ${date(p.submittedOn)}. The outcome will show here once the approver acts.`}</Alert>;
  return null;
}

export function ActionBar(p: { printable: boolean; editable: boolean; approving: boolean; canDelete: boolean; busy: boolean; meta: string; onSave: () => void; onSubmit: () => void; onApprove: () => void; onReject: () => void; onDelete: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useActionBarHeight(true, ref);
  return (
    <div className="tc-actionbar" ref={ref}>
      <div className="tc-actionbar__group">{p.printable ? <Button variant="ghost" className="tc-btn--neutral" icon="print" label="Download as PDF" hook="print" onClick={() => window.print()} /> : null}</div>
      <span className="tc-actionbar__meta" data-testid="meta">{p.meta}</span>
      <span className="tc-actionbar__spacer" />
      <div className="tc-actionbar__group">
        {p.editable ? <>
          {p.canDelete ? <Button variant="destructive-outline" icon="trash" label="Delete" hook="delete" disabled={p.busy} onClick={p.onDelete} data-testid="delete" /> : null}
          <Button icon="save" label="Save Draft" hook="save" disabled={p.busy} onClick={p.onSave} data-testid="save-draft" />
          <Button variant="primary" icon="send" label="Submit" hook="submit" disabled={p.busy} onClick={p.onSubmit} data-testid="submit" />
        </> : p.approving ? <>
          <Button variant="destructive" icon="x-circle" label="Reject" hook="reject" disabled={p.busy} onClick={p.onReject} data-testid="reject" />
          <Button variant="primary" icon="check-circle" label="Approve" hook="approve" disabled={p.busy} onClick={p.onApprove} data-testid="approve" />
        </> : null}
      </div>
    </div>
  );
}

export const Card = ({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) => (
  <section className="tc-card"><div className="tc-card__header"><div><h2 className="tc-card__title">{title}</h2>{subtitle ? <p className="tc-card__subtitle">{subtitle}</p> : null}</div></div>{children}</section>
);
