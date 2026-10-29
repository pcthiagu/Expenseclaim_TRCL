import { Alert, Button, EmptyState, Meter } from '../../components/common/ui';
import { ActionBar, Banner, Card, EmployeeFields, PageHeader, RequestNumberField, StatusField } from '../../components/forms/FormKit';
import { CheckField, Field, FileField, ReadonlyField } from '../../components/forms/Field';
import { lookup } from '../../domain/expenseSchema';
import { advanceUsage, travelEstimate } from '../../domain/calc';
import { validateTravel } from '../../domain/validation';
import type { TravelEstimateLine, TravelRequest } from '../../types/domain';
import { date, dateTime, money, money0, num, plural, today } from '../../utils/format';
import { EmployeePicker } from '../expense-claims/EmployeePicker';
import { TrailButton } from '../shared/ApprovalTrail';
import { uid, useRecordForm } from '../shared/useRecordForm';
import { useUploader } from '../shared/useUploader';

const blankLine = (): TravelEstimateLine => ({ id: uid(), item: '', amount: '', remarks: '' });

export function TravelFormPage({ id }: { id: string | null }) {
  const f = useRecordForm<TravelRequest>({
    kind: 'travel', id, noun: 'travel request',
    blank: (s, admin) => ({
      id: uid(), kind: 'travel', requestNumber: '', employeeCode: admin ? '' : s.code, employeeName: admin ? '' : s.name, costCentre: admin ? '' : s.costCentre ?? '', requestDate: today(),
      status: 'draft', submittedOn: null, approvedOn: null, approver: null, createdBy: s.code, createdAt: '', updatedAt: '', purpose: '', remarks: '', fromLocation: 'Chennai', toLocation: '',
      periodFrom: '', periodTo: '', items: [{ id: uid(), item: 'Ticket Fare', amount: '', remarks: '' }], advanceRequired: '', overallRemarks: '', approverRemarks: '', alongWith: '', attachments: [], createLeave: false,
    }),
    validate: (form, forSubmit, ctx) => validateTravel(form, forSubmit, ctx),
    normalize: (form) => {
      const items = form.items.filter((it) => it.item || num(it.amount) > 0).map((it) => ({ ...it, amount: it.amount === '' ? '' as const : num(it.amount) }));
      return { ...form, items: items.length ? items : [blankLine()], advanceRequired: form.advanceRequired === '' ? '' : num(form.advanceRequired) };
    },
    submitConfirm: (t) => ({ title: 'Submit travel request?', confirmLabel: 'Submit request', body: `${t.fromLocation} → ${t.toLocation}, ${date(t.periodFrom)} – ${date(t.periodTo)}. Estimated ${money(travelEstimate(t))}${num(t.advanceRequired) ? ' with ' + money(t.advanceRequired) + ' advance' : ''}.` }),
    approveConfirm: (t) => ({ title: 'Approve travel request?', confirmLabel: 'Approve request', body: `${t.employeeName} travels ${t.fromLocation} → ${t.toLocation}. Estimate ${money(travelEstimate(t))}${num(t.advanceRequired) ? '; advance of ' + money(t.advanceRequired) + ' is requested separately.' : '.'}${t.createLeave ? ' A leave application will be raised for the period.' : ''}` }),
  });
  const uploader = useUploader();
  const { form, editable, approving, errors } = f;
  if (f.load === 'loading') return <div aria-busy="true" data-testid="form-loading">Loading…</div>;
  if (f.load === 'error') return <div className="tc-card"><Alert tone="error" title="Could not load the travel request">{f.loadError}</Alert></div>;
  if (f.load === 'notfound' || !form) return <div className="tc-card" data-testid="not-found"><EmptyState icon="search" title="Travel request not found" body="It may have been deleted, or it belongs to another employee and is not visible to you." action={<Button variant="primary" icon="arrow-left" label="Back to travel requests" href="#/travel" />} /></div>;

  const est = travelEstimate(form);
  const au = form.employeeCode && f.records ? advanceUsage(f.records, form.employeeCode, null, f.policy) : null;
  const setItem = (i: number, patch: Partial<TravelEstimateLine>): void => f.update({ items: form.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) });
  const addFiles = async (files: File[]): Promise<void> => {
    const { metas } = await uploader.upload(files, { kind: 'travel', recordId: form.id });
    if (metas.length) f.update({ attachments: [...form.attachments, ...metas] });
  };

  const meter = au ? (
    <div className="tc-field"><span className="tc-label">Advance Balance</span>
      <Meter label="Travel advance" used={au.used} limit={au.limit} valueText={`${money0(au.balance)} available`} sub={`${money0(au.outstanding)} outstanding · ${money0(au.pending)} pending · limit ${money0(au.limit)}`} /></div>
  ) : null;

  return (
    <>
      <PageHeader title={form.requestNumber || 'New Travel Request'} mono={!!form.requestNumber} status={form.status} role={f.actor.role} backLabel="Back to dashboard" onBack={f.leave}
        subtitle={form.employeeName ? `${form.employeeName} · ${form.employeeCode}${form.toLocation ? ` · ${form.fromLocation} → ${form.toLocation}` : ''}` : 'Plan the trip and estimate its cost'} actions={<TrailButton record={form.requestNumber ? form : null} />} />
      <div className="tc-stack">
        <Banner summary={f.summary} status={form.status} isAdmin={f.isAdmin} approver={form.approver} approvedOn={form.approvedOn} submittedOn={form.submittedOn} rejectionText={form.approverRemarks}
          approvedBody={`${money(est)} estimated${num(form.advanceRequired) ? ` · ${money(form.advanceRequired)} advance requested` : ''}.`} adminBody="Check the plan and estimate, then approve or reject with remarks." />

        <Card title="Request details" subtitle={editable ? 'Who is travelling and why.' : 'Requester and purpose.'}>
          <div className="tc-form-grid tc-form-grid--3">
            <EmployeeFields code={form.employeeCode} name={form.employeeName} editable={editable} isAdmin={f.isAdmin} error={errors.employeeCode} onCode={(v) => f.update({ employeeCode: v, employeeName: '' })} onBlur={() => void f.resolveCode()}
              onHelp={() => f.modal.open(<EmployeePicker gateway={f.gateway} onPick={f.pickEmployee} />)} />
            {editable ? <Field label="Request Date" type="date" required value={form.requestDate} max={today()} error={errors.requestDate} testId="request-date" onChange={(v) => f.update({ requestDate: String(v) })} /> : <ReadonlyField label="Request Date" value={date(form.requestDate)} />}
            {editable ? <Field label="Travel Purpose" type="select" required value={form.purpose} options={lookup('TRAVEL_PURPOSE')} placeholder="Select purpose" error={errors.purpose} testId="purpose" onChange={(v) => f.update({ purpose: String(v) })} /> : <ReadonlyField label="Travel Purpose" value={form.purpose} />}
            <RequestNumberField value={f.reqNo} onChange={f.setReqNo} onGet={() => void f.getRequest()} />
            <StatusField status={form.status} role={f.actor.role} submittedOn={form.submittedOn} approvedOn={form.approvedOn} approver={form.approver} updatedAt={form.updatedAt} isNew={f.isNew} />
            {meter}
          </div>
        </Card>

        <Card title="Travel plan" subtitle="Route and period.">
          <div className="tc-form-grid">
            {editable ? <>
              <datalist id="tc-cities">{lookup('CITIES').map((c) => <option key={c} value={c} />)}</datalist>
              <Field label="Travel Location From" required value={form.fromLocation} list="tc-cities" placeholder="City" error={errors.fromLocation} testId="from-location" onChange={(v) => f.update({ fromLocation: String(v) })} />
              <Field label="Travel Location To" required value={form.toLocation} list="tc-cities" placeholder="City" error={errors.toLocation} testId="to-location" onChange={(v) => f.update({ toLocation: String(v) })} />
              <Field label="Travel Period From" type="datetime-local" required value={form.periodFrom} error={errors.periodFrom} testId="period-from" onChange={(v) => f.update({ periodFrom: String(v) })} />
              <Field label="Travel Period To" type="datetime-local" required value={form.periodTo} error={errors.periodTo} testId="period-to" onChange={(v) => f.update({ periodTo: String(v) })} />
              <Field label="Travel Remarks" type="textarea" optional full value={form.remarks} placeholder="What the trip is for, who you are meeting" testId="remarks" onChange={(v) => f.update({ remarks: String(v) })} />
              <Field label="Along With" optional full value={form.alongWith} placeholder="Colleagues travelling with you, if any" testId="along-with" onChange={(v) => f.update({ alongWith: String(v) })} />
              <CheckField full label="Create Leave Application" helper="Raise a leave application for the travel period when this request is approved" checked={form.createLeave} onChange={(v) => f.update({ createLeave: v })} />
            </> : <>
              <ReadonlyField label="Route" value={`${form.fromLocation || '—'} → ${form.toLocation || '—'}`} />
              <ReadonlyField label="Travel Period" value={`${dateTime(form.periodFrom)} – ${dateTime(form.periodTo)}`} />
              <ReadonlyField label="Travel Remarks" value={form.remarks} full /><ReadonlyField label="Along With" value={form.alongWith} />
              <ReadonlyField label="Leave Application" value={form.createLeave ? 'Requested for the travel period' : 'Not requested'} />
            </>}
          </div>
        </Card>

        <Card title="Cost estimate" subtitle={editable ? 'Rough figures are fine; actuals come with the expense claim.' : `${plural(form.items.length, 'item')} · ${money(est)} estimated`}>
          {editable ? <>
            <div className="tc-est-head"><span>Expense Item</span><span>Amount</span><span className="tc-est-remarks">Remarks</span><span /></div>
            {form.items.map((it, i) => (
              <div className="tc-est-row" key={it.id} data-testid="est-row">
                <Field type="select" value={it.item} options={lookup('ESTIMATE_ITEM')} placeholder="Item" ariaLabel={`Expense item ${i + 1}`} error={errors[`items.${i}.item`]} testId={`est-item-${i}`} onChange={(v) => setItem(i, { item: String(v) })} />
                <Field type="money" value={it.amount} ariaLabel={`Amount ${i + 1}`} error={errors[`items.${i}.amount`]} testId={`est-amount-${i}`} onChange={(v) => setItem(i, { amount: v === '' ? '' : Number(v) })} />
                <Field value={it.remarks} placeholder="Remarks" ariaLabel={`Remarks ${i + 1}`} className="tc-est-remarks" testId={`est-remarks-${i}`} onChange={(v) => setItem(i, { remarks: String(v) })} />
                <Button variant="ghost" className="tc-btn--neutral" iconOnly icon="trash" label={`Remove item ${i + 1}`} disabled={form.items.length <= 1} onClick={() => f.update({ items: form.items.filter((_, j) => j !== i) })} data-testid={`est-remove-${i}`} />
              </div>))}
            <div className="tc-row tc-mt-12"><Button variant="ghost" icon="plus" label="Add item" onClick={() => f.update({ items: [...form.items, blankLine()] })} data-testid="est-add" /></div>
          </> : (
            <div className="tc-table-wrap"><table className="tc-table"><thead><tr><th>Expense Item</th><th className="tc-num">Amount</th><th>Remarks</th></tr></thead>
              <tbody>{form.items.map((it) => <tr key={it.id}><td>{it.item}</td><td className="tc-num">{money(it.amount)}</td><td className="tc-cell-wrap">{it.remarks || '—'}</td></tr>)}</tbody></table></div>
          )}
          <div className="tc-est-total"><span className="tc-medium">Total Estimation Amount</span><span className="tc-est-total__value" data-testid="est-total">{money(est)}</span></div>
          <div className="tc-form-grid tc-mt-16">
            {editable
              ? <Field label="Advance Amount Required" type="money" optional value={form.advanceRequired} error={errors.advanceRequired} testId="advance-required" onChange={(v) => f.update({ advanceRequired: v === '' ? '' : Number(v) })}
                  helper={au ? `Available advance balance ${money0(au.balance)}. Leave blank if no advance is needed.` : 'Leave blank if no advance is needed.'} />
              : <ReadonlyField label="Advance Amount Required" value={num(form.advanceRequired) ? money(form.advanceRequired) : 'None'} />}
          </div>
        </Card>

        <Card title="Documents and comments">
          <div className="tc-form-grid">
            <FileField label="Attach Document" multiple files={form.attachments} readonly={!editable} optional={editable} full helper={editable ? 'PDF, JPG or PNG up to 5 MB each' : undefined} placeholder="Upload supporting documents" testId="attachments" onAdd={addFiles} onRemove={(i) => f.update({ attachments: form.attachments.filter((_, j) => j !== i) })} />
            {editable ? <Field label="Overall Remarks" type="textarea" optional value={form.overallRemarks} placeholder="Anything else the approver should know" testId="overall-remarks" onChange={(v) => f.update({ overallRemarks: String(v) })} /> : <ReadonlyField label="Overall Remarks" value={form.overallRemarks} />}
            {approving ? <Field label="Approver Remarks" type="textarea" value={form.approverRemarks} placeholder="Shown to the employee. Required when rejecting." error={errors.approverRemarks} testId="approver-remarks" onChange={(v) => f.update({ approverRemarks: String(v) })} />
              : form.approverRemarks || form.status === 'approved' || form.status === 'rejected' ? <ReadonlyField label="Approver Remarks" value={form.approverRemarks} /> : null}
          </div>
        </Card>
      </div>
      <ActionBar printable={!!form.requestNumber} editable={editable} approving={approving} canDelete={f.canDelete} busy={f.busy} onSave={() => void f.saveDraft()} onSubmit={() => void f.submit()} onApprove={() => void f.approve()} onReject={() => void f.reject()} onDelete={() => void f.remove()}
        meta={editable ? (f.dirty ? 'Unsaved changes' : f.isNew ? 'Not saved yet' : `Saved ${dateTime(form.updatedAt)}`) : `${money(est)} estimated`} />
    </>
  );
}
