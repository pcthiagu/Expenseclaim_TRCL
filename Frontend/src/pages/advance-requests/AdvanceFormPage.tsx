import { useApp } from '../../app/AppContext';
import { Alert, Button, EmptyState, Meter } from '../../components/common/ui';
import { ActionBar, Banner, Card, EmployeeFields, PageHeader, RequestNumberField, StatusField } from '../../components/forms/FormKit';
import { CheckField, Field, FileField, ReadonlyField } from '../../components/forms/Field';
import { lookup } from '../../domain/expenseSchema';
import { advanceUsage } from '../../domain/calc';
import { validateAdvance } from '../../domain/validation';
import type { AdvanceRequest, TravelRequest } from '../../types/domain';
import { date, dateTime, money, money0, num, today } from '../../utils/format';
import { EmployeePicker } from '../expense-claims/EmployeePicker';
import { TrailButton } from '../shared/ApprovalTrail';
import { uid, useRecordForm } from '../shared/useRecordForm';
import { useUploader } from '../shared/useUploader';

export function AdvanceFormPage({ id }: { id: string | null }) {
  const { policy } = useApp();
  const f = useRecordForm<AdvanceRequest>({
    kind: 'advance', id, noun: 'advance request',
    blank: (s, admin) => ({
      id: uid(), kind: 'advance', requestNumber: '', employeeCode: admin ? '' : s.code, employeeName: admin ? '' : s.name, costCentre: admin ? '' : s.costCentre ?? '', requestDate: today(),
      status: 'draft', submittedOn: null, approvedOn: null, approver: null, createdBy: s.code, createdAt: '', updatedAt: '', periodFrom: '', periodTo: '', amount: '', purpose: '', remarks: '',
      alongWith: '', attachments: [], createLeave: false, travelRequest: '', settled: false, approverRemarks: '',
    }),
    validate: (form, forSubmit, ctx) => validateAdvance(form, forSubmit, ctx),
    normalize: (form) => ({ ...form, amount: form.amount === '' ? '' : num(form.amount) }),
    submitConfirm: (a) => ({ title: 'Submit advance request?', confirmLabel: 'Submit request', body: `${money(a.amount)} for ${a.purpose}, ${date(a.periodFrom)} – ${date(a.periodTo)}.` }),
    approveConfirm: (a, records) => {
      const au = advanceUsage(records, a.employeeCode, a.id, policy);
      return { title: 'Approve advance request?', confirmLabel: `Approve ${money0(a.amount)}`, body: `${money(a.amount)} will be released to ${a.employeeName}. Their available balance after this is ${money0(Math.max(0, au.balance - num(a.amount)))}.` };
    },
  });
  const uploader = useUploader();
  const { form, editable, approving, errors } = f;
  if (f.load === 'loading') return <div aria-busy="true" data-testid="form-loading">Loading…</div>;
  if (f.load === 'error') return <div className="tc-card"><Alert tone="error" title="Could not load the advance request">{f.loadError}</Alert></div>;
  if (f.load === 'notfound' || !form) return <div className="tc-card" data-testid="not-found"><EmptyState icon="search" title="Advance request not found" body="It may have been deleted, or it belongs to another employee and is not visible to you." action={<Button variant="primary" icon="arrow-left" label="Back to advance requests" href="#/advance" />} /></div>;

  const au = form.employeeCode && f.records ? advanceUsage(f.records, form.employeeCode, form.id, f.policy) : null;
  const travels = (f.records ?? []).filter((r): r is TravelRequest => r.kind === 'travel' && r.employeeCode === form.employeeCode && (r.status === 'approved' || r.status === 'submitted'));
  const linkedOptions = travels.map((r) => ({ value: r.requestNumber, label: `${r.requestNumber} · ${r.toLocation} · ${date(r.periodFrom)} – ${date(r.periodTo)}` }));
  /** Picking a travel request fills purpose, period, remarks and amount (only where blank), as the prototype does. */
  const linkTravel = (no: string): void => {
    const tr = travels.find((r) => r.requestNumber === no);
    if (!tr) { f.update({ travelRequest: no }); return; }
    f.update({
      travelRequest: no, purpose: tr.purpose, periodFrom: String(tr.periodFrom).slice(0, 10), periodTo: String(tr.periodTo).slice(0, 10),
      remarks: form.remarks || tr.remarks || '', amount: !num(form.amount) && num(tr.advanceRequired) ? num(tr.advanceRequired) : form.amount,
    });
  };
  const addFiles = async (files: File[]): Promise<void> => {
    const { metas } = await uploader.upload(files, { kind: 'advance', recordId: form.id });
    if (metas.length) f.update({ attachments: [...form.attachments, ...metas] });
  };


  return (
    <>
      <PageHeader title={form.requestNumber || 'New Advance Request'} mono={!!form.requestNumber} status={form.status} role={f.actor.role} backLabel="Back to dashboard" onBack={f.leave}
        subtitle={form.employeeName ? `${form.employeeName} · ${form.employeeCode}${num(form.amount) ? ' · ' + money(form.amount) : ''}` : 'Request an advance against upcoming travel'} actions={<TrailButton record={form.requestNumber ? form : null} />} />
      <div className="tc-stack">
        <Banner summary={f.summary} status={form.status} isAdmin={f.isAdmin} approver={form.approver} approvedOn={form.approvedOn} submittedOn={form.submittedOn} rejectionText={form.approverRemarks}
          approvedBody={`${money(form.amount)} released${form.settled ? ' and settled.' : '; outstanding until the expense claim is settled.'}`} adminBody="Check the amount against the balance and linked travel request, then approve or reject." />

        <Card title="Request details">
          <div className="tc-form-grid tc-form-grid--3">
            <EmployeeFields code={form.employeeCode} name={form.employeeName} editable={editable} isAdmin={f.isAdmin} error={errors.employeeCode} onCode={(v) => f.update({ employeeCode: v, employeeName: '' })} onBlur={() => void f.resolveCode()}
              onHelp={() => f.modal.open(<EmployeePicker gateway={f.gateway} onPick={f.pickEmployee} />)} />
            {editable ? <Field label="Request Date" type="date" required value={form.requestDate} max={today()} error={errors.requestDate} testId="request-date" onChange={(v) => f.update({ requestDate: String(v) })} /> : <ReadonlyField label="Request Date" value={date(form.requestDate)} />}
            <RequestNumberField value={f.reqNo} onChange={f.setReqNo} onGet={() => void f.getRequest()} />
            <StatusField status={form.status} role={f.actor.role} submittedOn={form.submittedOn} approvedOn={form.approvedOn} approver={form.approver} updatedAt={form.updatedAt} isNew={f.isNew} />
            {au ? <div className="tc-field"><span className="tc-label">Balance</span>
              <Meter label="Travel advance" used={au.used} limit={au.limit} valueText={`${money0(au.balance)} available`} sub={`${money0(au.outstanding)} outstanding · ${money0(au.pending)} pending · limit ${money0(au.limit)}`} /></div> : null}
          </div>
        </Card>

        <Card title="Advance details" subtitle={editable ? 'The advance is adjusted against the expense claim you file after the trip.' : 'Adjusted against the expense claim filed after the trip.'}>
          <div className="tc-form-grid">
            {editable ? <>
              <Field label="Linked Travel Request" type="select" optional full value={form.travelRequest} options={linkedOptions} disabled={!linkedOptions.length} testId="linked-travel"
                placeholder={linkedOptions.length ? 'Select a travel request' : 'No travel requests for this employee'} helper="Picking one fills the purpose and period for you" onChange={(v) => linkTravel(String(v))} />
              <Field label="Travel Purpose" type="select" required value={form.purpose} options={lookup('TRAVEL_PURPOSE')} placeholder="Select purpose" error={errors.purpose} testId="purpose" onChange={(v) => f.update({ purpose: String(v) })} />
              <Field label="Amount" type="money" required value={form.amount} error={errors.amount} testId="amount" helper={au ? `Available advance balance ${money0(au.balance)}` : undefined} onChange={(v) => f.update({ amount: v === '' ? '' : Number(v) })} />
              <Field label="Travel Period From" type="date" required value={form.periodFrom} error={errors.periodFrom} testId="period-from" onChange={(v) => f.update({ periodFrom: String(v) })} />
              <Field label="Travel Period To" type="date" required value={form.periodTo} error={errors.periodTo} testId="period-to" onChange={(v) => f.update({ periodTo: String(v) })} />
              <Field label="Remarks" type="textarea" optional full value={form.remarks} placeholder="What the advance will cover" testId="remarks" onChange={(v) => f.update({ remarks: String(v) })} />
              <Field label="Along With" optional full value={form.alongWith} placeholder="Colleagues travelling with you, if any" testId="along-with" onChange={(v) => f.update({ alongWith: String(v) })} />
              <CheckField full label="Create Leave Application" helper="Raise a leave application for the travel period when this request is approved" checked={form.createLeave} onChange={(v) => f.update({ createLeave: v })} />
            </> : <>
              <ReadonlyField label="Linked Travel Request" value={form.travelRequest} mono /><ReadonlyField label="Travel Purpose" value={form.purpose} /><ReadonlyField label="Amount" value={money(form.amount)} mono />
              <ReadonlyField label="Travel Period" value={`${date(form.periodFrom)} – ${date(form.periodTo)}`} /><ReadonlyField label="Remarks" value={form.remarks} full /><ReadonlyField label="Along With" value={form.alongWith} />
              <ReadonlyField label="Leave Application" value={form.createLeave ? 'Requested for the travel period' : 'Not requested'} />
            </>}
          </div>
        </Card>

        <Card title="Documents and comments">
          <div className="tc-form-grid">
            <FileField label="Attach Document" multiple files={form.attachments} readonly={!editable} optional={editable} full helper={editable ? 'PDF, JPG or PNG up to 5 MB each' : undefined} placeholder="Upload supporting documents" testId="attachments" onAdd={addFiles} onRemove={(i) => f.update({ attachments: form.attachments.filter((_, j) => j !== i) })} />
            {approving ? <Field label="Approver Remarks" type="textarea" value={form.approverRemarks} placeholder="Shown to the employee. Required when rejecting." error={errors.approverRemarks} testId="approver-remarks" onChange={(v) => f.update({ approverRemarks: String(v) })} />
              : form.approverRemarks || form.status === 'approved' || form.status === 'rejected' ? <ReadonlyField label="Approver Remarks" value={form.approverRemarks} /> : null}
          </div>
        </Card>
      </div>
      <ActionBar printable={!!form.requestNumber} editable={editable} approving={approving} canDelete={f.canDelete} busy={f.busy} onSave={() => void f.saveDraft()} onSubmit={() => void f.submit()} onApprove={() => void f.approve()} onReject={() => void f.reject()} onDelete={() => void f.remove()}
        meta={editable ? (f.dirty ? 'Unsaved changes' : f.isNew ? 'Not saved yet' : `Saved ${dateTime(form.updatedAt)}`) : `${money(form.amount)} advance`} />
    </>
  );
}
