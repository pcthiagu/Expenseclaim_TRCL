import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { navigate } from '../../app/router';
import { Alert, Button, Count, EmptyState, Meter, StatusBadge } from '../../components/common/ui';
import { TrailButton } from '../shared/ApprovalTrail';
import { useActionBarHeight, useToast } from '../../components/common/Toast';
import { Field, ReadonlyField } from '../../components/forms/Field';
import { useModal } from '../../components/modals/ModalHost';
import { approvedTotal, autofillApproved, claimTotal, lineLimitAmount, medicalUsage, overLimit, withDefaultApprovedAmounts } from '../../domain/calc';
import { EXPENSE_TYPES, fixedItems, GST_FIELD_KEYS, itemByKey, lookup, typeByKey } from '../../domain/expenseSchema';
import { validateApproval, validateClaimHeader, validateRejectionReason } from '../../domain/validation';
import { canApprove, canCopy, canDelete, canEdit } from '../../domain/workflow';
import { ApiError } from '../../services/apiClient';
import type { ClaimLine, Employee, ExpenseClaim, GstFieldKey, GstFields, Receipt, TravelClaimRecord } from '../../types/domain';
import { date, dateTime, money, money0, plural, today } from '../../utils/format';
import { ClaimItems } from './ClaimItems';
import { DateWiseDrawer } from './DateWiseDrawer';
import { EmployeePicker } from './EmployeePicker';
import { LineModal } from './LineModal';
import { rememberDashboardKind } from '../../pages/dashboard/DashboardPage';
import { clearPendingReceipts, peekPendingReceipts } from '../../pages/receipt-box/pendingReceipts';
import { pendingReceipts as pendingList } from '../../domain/receipts';
import { Icon } from '../../components/common/Icon';
import { FileChip } from '../../components/common/ui';

import { authStore } from '../../auth/authStore';
import { readAppConfig } from '../../config/appConfig';

const uid = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const gstFieldsFor = (claim: ExpenseClaim, line: ClaimLine): GstFields | undefined => {
  const item = itemByKey(claim.expenseType, line.itemKey);
  const fields: GstFields = {};
  for (const key of GST_FIELD_KEYS) {
    if (item?.fields.includes(key)) fields[key] = String(line.fields[key] ?? '');
  }
  return Object.keys(fields).length ? fields : undefined;
};

type Load = 'loading' | 'ready' | 'notfound' | 'error';

export function ClaimFormPage({ id }: { id: string | null }) {
  const { gateway, session, actor, isAdmin, policy } = useApp();
  const toast = useToast();

  // for pdf preview
const previewPdf = async (): Promise<void> => {
  const requestNumber = form?.requestNumber?.trim();
  if (!requestNumber) {
    toast('Request number is not available.', 'warning');
    return;
  }
  const token = authStore.getAccessToken();
  if (!token) {
    toast('Authentication failed. Please sign in again.', 'error');
    return;
  }
  // Open synchronously during the click to avoid popup blockers.
  const pdfWindow = window.open(
    '',
    '_blank',
    'width=950,height=800,resizable=yes,scrollbars=yes',
  );
  if (!pdfWindow) {
    toast('Please allow pop-ups to preview the PDF.', 'warning');
    return;
  }
  try {
    const { apiBaseUrl } = readAppConfig(import.meta.env);
    const response = await fetch(
      `${apiBaseUrl}/api/approval-pdf/view?requestNumber=${encodeURIComponent(requestNumber)}`,
      {
        method: 'GET',
        headers: {
          Accept: 'application/pdf',
          Authorization: `Bearer ${token}`,
        },
      },
    );
    if (!response.ok) {
      throw new Error(
        response.status === 401
          ? 'Authentication failed. Please sign in again.'
          : response.status === 404
            ? 'PDF not found for this request.'
            : `Unable to preview PDF (HTTP ${response.status}).`,
      );
    }
    const blob = await response.blob();
    const pdfUrl = URL.createObjectURL(blob);
    pdfWindow.location.href = pdfUrl;
    pdfWindow.focus();
    window.setTimeout(() => URL.revokeObjectURL(pdfUrl), 5 * 60 * 1000);
  } catch (error) {
    pdfWindow.close();
    toast(
      error instanceof Error ? error.message : 'Unable to preview PDF.',
      'error',
    );
  }
};

  const modal = useModal();
  const [load, setLoad] = useState<Load>('loading');
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<ExpenseClaim | null>(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string[]>([]);
  const [records, setRecords] = useState<TravelClaimRecord[] | null>(null);
  const [eligibilityByLine, setEligibilityByLine] = useState<ReadonlyMap<string, { limit: number | null; enforceEligibility?: 'Y' | 'N'; locationBased: boolean; dynamicLimit: boolean }>>(() => new Map());
  const [eligibilityWarningError, setEligibilityWarningError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const [reqNo, setReqNo] = useState('');
  // Bills picked in the receipt box for a NEW claim (read once; cleared when this form goes away).
  // Kept across the first save (the form re-mounts on the saved draft's URL) so bills not yet added stay on offer.
  const [pendingIds, setPendingIds] = useState<string[]>(() => peekPendingReceipts());
  const [boxReceipts, setBoxReceipts] = useState<Receipt[]>([]);
  useEffect(() => () => clearPendingReceipts(), []);
  useEffect(() => {
    if (!pendingIds.length || isAdmin) return;
    let off = false;
    gateway.listReceipts().then((r) => { if (!off) setBoxReceipts(r); }).catch(() => undefined);
    return () => { off = true; };
  }, [gateway, isAdmin, pendingIds]);

  const newClaim = useCallback((): ExpenseClaim => ({
    id: uid(), kind: 'claim', requestNumber: '', employeeCode: isAdmin ? '' : session.code, employeeName: isAdmin ? '' : session.name,
    costCentre: isAdmin ? '' : session.costCentre ?? '', requestDate: today(), status: 'draft', submittedOn: null, approvedOn: null, approver: null,
    createdBy: session.code, createdAt: '', updatedAt: '', expenseType: EXPENSE_TYPES[0]?.key ?? 'fuel', purpose: '', travelFrom: '', travelTo: '', items: [],
    employeeComments: '', approverComments: '', rejectionReason: '',
  }), [isAdmin, session]);

  const refreshAux = useCallback(async () => {
    try { const p = await gateway.listRecords({ kind: 'claim' }); setRecords(p.rows); } catch { /* balance meter is advisory; the server enforces */ }
  }, [gateway]);

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        if (id) {
          const r = await gateway.getRecord('claim', id);
          if (off) return;
          if (r.kind !== 'claim') { setLoad('notfound'); return; }
          setForm(clone(r)); setReqNo(r.requestNumber);
        } else setForm(newClaim());
        setLoad('ready');
        void refreshAux();
      } catch (e) {
        if (off) return;
        if (e instanceof ApiError && (e.code === 'not_found' || e.code === 'forbidden')) setLoad('notfound');
        else { setLoadError(e instanceof Error ? e.message : 'Could not load the claim.'); setLoad('error'); }
      }
    })();
    return () => { off = true; };
  }, [id, gateway, newClaim, refreshAux]);

  useEffect(() => {
    if (!form) {
      setEligibilityByLine(new Map());
      setEligibilityWarningError('');
      return;
    }
    let cancelled = false;
    setEligibilityByLine(new Map());
    setEligibilityWarningError('');
    void Promise.all(form.items.map(async (line) => {
      const item = itemByKey(form.expenseType, line.itemKey);
      if (!item) return { id: line.id, limit: null, enforceEligibility: undefined, locationBased: false, dynamicLimit: false, error: null };
      let eligibleItem = item;
      const locationBased = item.fields.includes('stayLocation');
      const billAvailable = item.fields.includes('isBillAvailable')
        && (line.fields.isBillAvailable === 'Yes' || line.fields.isBillAvailable === 'No')
        ? line.fields.isBillAvailable
        : undefined;
      const dynamicLimit = (locationBased && !!String(line.fields.stayLocation ?? '').trim()) || !!billAvailable;
      if (locationBased) {
        const stayLocation = String(line.fields.stayLocation ?? '').trim();
        if (!stayLocation && !billAvailable) return { id: line.id, limit: null, enforceEligibility: item.enforceEligibility, locationBased, dynamicLimit: false, error: null };
        try {
          const locationLimit = await gateway.getLocationPolicyLimit(item.key, stayLocation, billAvailable);
          eligibleItem = {
            ...item,
            limit: locationLimit?.limit ?? null,
            limitPer: locationLimit?.limitPer ?? item.limitPer,
            enforceEligibility: locationLimit?.enforceEligibility ?? item.enforceEligibility,
          };
        } catch (e) {
          return { id: line.id, limit: null, enforceEligibility: undefined, locationBased, dynamicLimit, error: e instanceof Error ? e.message : 'Could not load an eligibility limit.' };
        }
      } else if (billAvailable) {
        try {
          const billLimit = await gateway.getLocationPolicyLimit(item.key, '', billAvailable);
          eligibleItem = {
            ...item,
            limit: billLimit?.limit ?? null,
            limitPer: billLimit?.limitPer ?? item.limitPer,
            enforceEligibility: billLimit?.enforceEligibility ?? item.enforceEligibility,
          };
        } catch (e) {
          return { id: line.id, limit: null, enforceEligibility: undefined, locationBased, dynamicLimit, error: e instanceof Error ? e.message : 'Could not load a bill eligibility limit.' };
        }
      }
      return {
        id: line.id,
        limit: lineLimitAmount(eligibleItem, line.fields),
        enforceEligibility: eligibleItem.enforceEligibility,
        locationBased,
        dynamicLimit,
        error: null,
      };
    })).then((results) => {
      if (cancelled) return;
      setEligibilityByLine(new Map(results.map(({ id, limit, enforceEligibility, locationBased, dynamicLimit }) => [id, { limit, enforceEligibility, locationBased, dynamicLimit }])));
      const errors = results.flatMap((r) => r.error ? [r.error] : []);
      if (errors.length) setEligibilityWarningError(`Could not check eligibility: ${errors[0]}`);
    });
    return () => { cancelled = true; };
  }, [gateway, form?.expenseType, form?.items]);

  const editable = !!form && canEdit(form, actor);
  const approving = !!form && canApprove(form, actor, { allowSelfApproval: policy.allowSelfApproval });
  const showActionBar = load === 'ready';
  useActionBarHeight(showActionBar, barRef);

  const update = useCallback((patch: Partial<ExpenseClaim>): void => { setForm((f) => (f ? { ...f, ...patch } : f)); setDirty(true); }, []);

  const ctx = useMemo(() => ({ employeeExists: () => !!form?.employeeName, records: records ?? [], policy }), [form?.employeeName, records, policy]);

  /** Shows a server error: field-level summary when the backend sent one, else its message. */
  const showServerError = (e: unknown): void => {
    if (e instanceof ApiError) {
      const d = e.details as { summary?: string[]; errors?: Record<string, string> } | null;
      if (d && Array.isArray(d.summary) && d.summary.length) setSummary(d.summary);
      else setSummary([e.message]);
      if (d?.errors && typeof d.errors === 'object') setLineErrors((x) => ({ ...x }));
      toast(e.message, 'error');
    } else { setSummary(['Something went wrong. Try again.']); toast('Something went wrong. Try again.', 'error'); }
    document.getElementById('tc-form-summary')?.scrollIntoView({ block: 'center' });
  };

  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    if (lock.current) return; // prevents duplicate submissions from double clicks
    lock.current = true; setBusy(true);
    try { await fn(); } catch (e) { showServerError(e); } finally { lock.current = false; setBusy(false); }
  };

  if (load === 'loading') return <div aria-busy="true" data-testid="form-loading">Loading…</div>;
  if (load === 'error') return <div className="tc-card"><Alert tone="error" title="Could not load the claim">{loadError}</Alert></div>;
  if (load === 'notfound' || !form) {
    return (
      <div className="tc-card" data-testid="not-found">
        <EmptyState icon="search" title="Expense claim not found" body="It may have been deleted, or it belongs to another employee and is not visible to you."
          action={<Button variant="primary" icon="arrow-left" label="Back to claims" href="#/claims" />} />
      </div>
    );
  }

  const def = typeByKey(form.expenseType) ?? EXPENSE_TYPES[0]!;
  const total = claimTotal(form);
  const approvalItems = approving && form.status === 'submitted' ? withDefaultApprovedAmounts(form.items) : form.items;
  const apprTotal = approvedTotal({ items: approvalItems });
  const over = form.items.filter((it) => overLimit(itemByKey(form.expenseType, it.itemKey), it.fields) > 0).length;
  const showApproval = approving || form.status === 'approved' || form.status === 'rejected';
  const isNew = !id;
  const gridBtn = editable && fixedItems(def).length > 0;
  // Balance is shown only once the employee's records have loaded (never a misleading full balance).
  const su = def.showBalance && form.employeeCode && records ? medicalUsage(records, form.employeeCode, form.id, policy) : null;

  /* ---- actions ---- */
  const leave = (): void => {
    const go = (): void => { rememberDashboardKind(session.role, 'claim'); navigate('#/dashboard'); };
    if (dirty && editable) void modal.confirm({ title: 'Leave without saving?', body: 'Your unsaved changes will be lost.', confirmLabel: 'Leave', variant: 'destructive' }).then((ok) => { if (ok) go(); });
    else go();
  };

  const validate = (forSubmit: boolean): boolean => {
    if (forSubmit && def.showBalance && !records) { toast('Still loading your medical balance. Try again in a moment.', 'warning'); return false; }
    const r = validateClaimHeader(form, forSubmit, ctx);
    setErrors(r.errors); setLineErrors({}); setSummary(r.summary);
    if (!r.ok) setTimeout(() => document.getElementById('tc-form-summary')?.scrollIntoView({ block: 'center' }), 0);
    return r.ok;
  };

  const persist = async (): Promise<ExpenseClaim> => {
    const saved = await gateway.saveDraft(form);
    if (saved.kind !== 'claim') throw new Error('Unexpected response from the server.');
    setForm(clone(saved)); setReqNo(saved.requestNumber); setDirty(false); setErrors({}); setSummary([]);
    void refreshAux();
    return saved;
  };

  const saveDraft = (): Promise<void> => guarded(async () => {
    if (!validate(false)) return;
    const saved = await persist();
    toast(`Draft ${saved.requestNumber} saved`);
    if (isNew) navigate('#/claims/' + encodeURIComponent(saved.id), { replace: true });
  });

  const submit = (): Promise<void> => guarded(async () => {
    if (!validate(true)) return;
    const ok = await modal.confirm({ title: 'Submit claim for approval?', body: `${money(total)} across ${plural(form.items.length, 'line')}. You will not be able to edit the claim after submitting.`, confirmLabel: 'Submit claim' });
    if (!ok) return;
    const saved = await persist();
    const done = await gateway.submit('claim', saved.id);
    if (done.kind === 'claim') setForm(clone(done));
    toast(`Claim ${done.requestNumber} submitted for approval`);
    void refreshAux();
    if (isNew) navigate('#/claims/' + encodeURIComponent(saved.id), { replace: true });
  });

  const approve = (): Promise<void> => guarded(async () => {
    setSummary([]); setErrors({});
    const c = validateApproval(approvalItems);
    setLineErrors(c.lineErrors);
    if (!c.ok) { setSummary(c.summary); return; }
    const ok = await modal.confirm({ title: 'Approve this claim?', body: `${money(apprTotal)} of ${money(total)} claimed will be approved for ${form.employeeName}.`, confirmLabel: `Approve ${money0(apprTotal)}` });
    if (!ok) return;
    const r = await gateway.approve('claim', form.id, {
      lines: approvalItems.map((it) => {
        const gstFields = gstFieldsFor(form, it);
        return {
          id: it.id, approvedAmount: it.approvedAmount, approverRemarks: it.approverRemarks,
          ...(gstFields ? { gstFields } : {}),
        };
      }), approverComments: form.approverComments,
    });
    if (r.kind === 'claim') setForm(clone(r));
    setDirty(false);
    toast(`Claim ${r.requestNumber} approved`);
  });

  const reject = (): Promise<void> => guarded(async () => {
    setLineErrors({});
    const bad = validateRejectionReason(form.rejectionReason);
    if (bad) { setErrors({ rejectionReason: bad }); setSummary(['Rejection Reason: required when rejecting']); return; }
    setErrors({}); setSummary([]);
    const ok = await modal.confirm({ title: 'Reject this claim?', body: 'The employee will see your reason and can copy the claim into a new draft.', confirmLabel: 'Reject claim', variant: 'destructive' });
    if (!ok) return;
    const r = await gateway.reject('claim', form.id, {
      lines: form.items.map((it) => {
        const gstFields = gstFieldsFor(form, it);
        return {
          id: it.id, approvedAmount: it.approvedAmount, approverRemarks: it.approverRemarks,
          ...(gstFields ? { gstFields } : {}),
        };
      }),
      approverComments: form.approverComments, rejectionReason: form.rejectionReason,
    });
    if (r.kind === 'claim') setForm(clone(r));
    setDirty(false);
    toast(`Claim ${r.requestNumber} rejected`, 'info');
  });

  const remove = (): Promise<void> => guarded(async () => {
    const ok = await modal.confirm({ title: `Delete draft ${form.requestNumber}?`, body: `The draft and its ${plural(form.items.length, 'line')} will be permanently removed.`, confirmLabel: 'Delete draft', variant: 'destructive' });
    if (!ok) return;
    await gateway.deleteDraft('claim', form.id);
    toast('Draft deleted', 'info');
    navigate('#/claims');
  });

  const copy = (): Promise<void> => guarded(async () => {
    const c = await gateway.copyRejectedClaim(form.id);
    toast(`Copied to new draft ${c.requestNumber}`);
    navigate('#/claims/' + encodeURIComponent(c.id));
  });

  const autofill = (): void => {
    update({ items: autofillApproved(form.items, (k) => itemByKey(form.expenseType, k)) });
    toast('Approved amounts filled within policy limits', 'info');
  };

  const changeType = (key: string): void => {
    if (key === form.expenseType) return;
    const apply = (): void => update({ expenseType: key as ExpenseClaim['expenseType'], items: [] });
    if (form.items.length) {
      void modal.confirm({ title: 'Change expense type?', body: `Each expense type has its own items, so changing it removes the ${plural(form.items.length, 'line')} already added.`, confirmLabel: 'Change and remove lines', variant: 'destructive' })
        .then((ok) => { if (ok) apply(); });
    } else apply();
  };

  const removeLine = (lineId: string): void => {
    const it = form.items.find((x) => x.id === lineId);
    if (!it) return;
    const d = itemByKey(form.expenseType, it.itemKey);
    void modal.confirm({ title: 'Remove this line?', body: `${d ? d.label : 'This line'} for ${money(it.fields.amount)} will be removed from the claim.`, confirmLabel: 'Remove line', variant: 'destructive' })
      .then((ok) => { if (ok) { update({ items: form.items.filter((x) => x.id !== lineId) }); toast('Line removed', 'info'); } });
  };

  const saveLine = (line: ClaimLine): void => {
    const idx = form.items.findIndex((x) => x.id === line.id);
    update({ items: idx >= 0 ? form.items.map((x, i) => (i === idx ? line : x)) : [...form.items, line] });
  };
  const openLine = (existing: ClaimLine | null, presetReceiptIds?: string[]): void => {
    const otherMedicalAmount = form.items.reduce((sum, line) => line.id === existing?.id ? sum : sum + Number(line.fields.amount || 0), 0);
    const eligibleAmount = su ? Math.max(0, su.balance - otherMedicalAmount) : null;
    modal.open(<LineModal claim={form} existing={existing} gateway={gateway} isAdmin={isAdmin} newId={uid} eligibleAmount={eligibleAmount} onSave={saveLine} {...(presetReceiptIds ? { presetReceiptIds } : {})} />);
  };
  const openGrid = (): void => modal.open(<DateWiseDrawer claim={form} gateway={gateway} isAdmin={isAdmin} newId={uid} onApply={(items) => update({ items })} />);

  const pickEmployee = (e: Employee): void => { update({ employeeCode: e.code, employeeName: e.name, costCentre: e.costCentre }); setErrors((x) => ({ ...x, employeeCode: '' })); };
  const resolveCode = async (): Promise<void> => {
    if (!isAdmin || !form.employeeCode) return;
    try { const hit = (await gateway.lookupEmployees(form.employeeCode)).find((e) => e.code === form.employeeCode.trim()); setForm((f) => (f ? { ...f, employeeName: hit?.name ?? '', costCentre: hit ? hit.costCentre : f.costCentre } : f)); } catch { /* shown on save */ }
  };

  const getRequest = async (): Promise<void> => {
    const n = reqNo.trim();
    if (!n) { toast('Enter a request number first', 'warning'); return; }
    try {
      const hit = (await gateway.listRecords({ search: n })).rows.find((r) => r.requestNumber.toUpperCase() === n.toUpperCase());
      if (!hit) { toast(`No request found for ${n}`, 'error'); return; }
      if (hit.id === form.id) { toast('This request is already open', 'info'); return; }
      const target = '#/' + (hit.kind === 'claim' ? 'claims' : hit.kind) + '/' + encodeURIComponent(hit.id);
      if (dirty && editable) { if (await modal.confirm({ title: 'Leave without saving?', body: 'Your unsaved changes on this form will be lost.', confirmLabel: 'Leave', variant: 'destructive' })) navigate(target); } else navigate(target);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not look that request up.', 'error'); }
  };

  /* ---- render ---- */
  const statusNote = form.status === 'submitted' ? `Submitted ${date(form.submittedOn)}`
    : form.status === 'approved' ? `Approved ${date(form.approvedOn)} by ${form.approver}`
    : form.status === 'rejected' ? `Rejected ${date(form.approvedOn)} by ${form.approver}`
    : isNew ? 'Not saved yet' : `Saved ${dateTime(form.updatedAt)}`;

  const banner = summary.length ? (
    <Alert tone="error" id="tc-form-summary" title={summary.length === 1 ? 'Please fix this before continuing' : `Please fix these ${summary.length} items before continuing`}>
      <ul>{summary.map((s) => <li key={s}>{s}</li>)}</ul>
    </Alert>
  ) : form.status === 'rejected' ? (
    <Alert tone="error" title={`Rejected by ${form.approver} on ${date(form.approvedOn)}`} action={canCopy(form, actor) ? <Button size="sm" icon="copy" label="Copy to new draft" hook="copy" onClick={() => void copy()} data-testid="copy-draft" /> : undefined}>{form.rejectionReason || 'No reason recorded.'}</Alert>
  ) : form.status === 'approved' ? (
    <Alert tone="success" title={`Approved by ${form.approver} on ${date(form.approvedOn)}`}>{`${money(apprTotal)} approved of ${money(total)} claimed.`}</Alert>
  ) : form.status === 'submitted' ? (
    <Alert tone="info" title={isAdmin ? 'Awaiting your approval' : 'Awaiting approval'}>{isAdmin ? 'Enter the approved amount for every line, add comments, then approve or reject.' : `Submitted on ${date(form.submittedOn)}. The outcome will show here once the approver acts.`}</Alert>
  ) : null;

  return (
    <>
      <div className="tc-page-header">
        <div className="tc-page-header__text">
          <Button variant="ghost" className="tc-btn--neutral tc-page-header__back" iconOnly icon="arrow-left" label="Back to claims" onClick={leave} data-testid="back" />
          <div>
            <h1 className="tc-page-title">
              <span className={form.requestNumber ? 'tc-mono' : ''} data-testid="page-title">{form.requestNumber || 'New Expense Claim'}</span>
              <StatusBadge status={form.status} role={actor.role} />
              <span className="tc-page-title__meta">{def.label}</span>
            </h1>
            <p className="tc-page-subtitle">{form.employeeName ? `${form.employeeName} · ${form.employeeCode}${form.costCentre ? ' · ' + form.costCentre : ''}` : 'Fill in the claim details below'}</p>
          </div>
        </div>
        <div className="tc-page-actions"><TrailButton record={form.requestNumber ? form : null} /></div>
      </div>

      <div className="tc-stack">
        {banner}
        {su && editable && total > su.balance ? <Alert tone="warning" title="Claim exceeds the available balance">{`${money(total)} claimed against ${money(su.balance)} remaining. Reduce the lines before submitting.`}</Alert> : null}

        <section className="tc-card">
          <div className="tc-card__header"><div><h2 className="tc-card__title">Claim details</h2><p className="tc-card__subtitle">{editable ? 'Enter the employee and request information.' : 'Employee and request information.'}</p></div></div>
          <div className="tc-form-grid tc-form-grid--3">
            {editable && isAdmin
              ? <Field label="Employee Code" required value={form.employeeCode} error={errors.employeeCode} placeholder="e.g. 800001" inputMode="numeric" testId="employee-code"
                  onChange={(v) => update({ employeeCode: String(v), employeeName: '' })} onBlur={() => void resolveCode()}
                  suffix={<Button icon="search" label="Help" onClick={() => modal.open(<EmployeePicker gateway={gateway} onPick={pickEmployee} />)} data-testid="emp-help" />} />
              : <ReadonlyField label="Employee Code" value={form.employeeCode} mono helper={editable ? 'Read-only for the employee role' : undefined} />}
            <ReadonlyField label="Employee Name" value={form.employeeName} />
            {editable
              ? <Field label="Cost Centre" type="select" value={form.costCentre} options={lookup('COST_CENTRE')} placeholder="Select cost centre" error={errors.costCentre} testId="cost-centre" onChange={(v) => update({ costCentre: String(v) })} />
              : <ReadonlyField label="Cost Centre" value={form.costCentre} />}
            {editable
              ? <Field label="Expense Type" type="select" required value={form.expenseType} placeholder={false} options={EXPENSE_TYPES.map((t) => ({ value: t.key, label: t.label }))} helper={def.description} testId="expense-type" onChange={(v) => changeType(String(v))} />
              : <ReadonlyField label="Expense Type" value={def.label} />}
            {editable
              ? <Field label="Purpose" required value={form.purpose} placeholder="Why was this expense incurred?" error={errors.purpose} testId="purpose" onChange={(v) => update({ purpose: String(v) })} />
              : <ReadonlyField label="Purpose" value={form.purpose} />}
            {editable
              ? <Field label="Request Date" type="date" required value={form.requestDate} max={today()} error={errors.requestDate} testId="request-date" onChange={(v) => update({ requestDate: String(v) })} />
              : <ReadonlyField label="Request Date" value={date(form.requestDate)} />}
            <div className="tc-field">
              <label className="tc-label" htmlFor="tc-reqno">Request Number</label>
              <div className="tc-input-row">
                <input className="tc-input tc-mono" id="tc-reqno" type="text" value={reqNo} placeholder="Assigned on first save" autoComplete="off" spellCheck={false} data-testid="reqno"
                  onChange={(e) => setReqNo(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void getRequest(); } }} />
                <Button label="Get" onClick={() => void getRequest()} data-testid="get-request" />
              </div>
              <p className="tc-helper">Type a request number and choose Get to open it</p>
            </div>
            <div className="tc-field"><span className="tc-label">Status</span><div className="tc-readonly"><StatusBadge status={form.status} role={actor.role} /><span className="tc-text-secondary tc-text-s">{statusNote}</span></div></div>
            {su ? <div className="tc-field"><span className="tc-label">Balance</span>
              <Meter label={`Medical ${today().slice(0, 4)}`} used={su.used} limit={su.limit} valueText={`${money0(su.balance)} left`} sub={`${money0(su.approved)} approved · ${money0(su.pending)} pending · limit ${money0(su.limit)}`} /></div> : null}
            {def.travelPeriod ? (editable ? <>
              <Field label="Travel From" type="date" required value={form.travelFrom ?? ''} error={errors.travelFrom} testId="travel-from" onChange={(v) => update({ travelFrom: String(v) })} />
              <Field label="Travel To" type="date" required value={form.travelTo ?? ''} error={errors.travelTo} testId="travel-to" onChange={(v) => update({ travelTo: String(v) })} />
            </> : <>
              <ReadonlyField label="Travel From" value={date(form.travelFrom)} /><ReadonlyField label="Travel To" value={date(form.travelTo)} />
            </>) : null}
          </div>
        </section>

        <section className="tc-card tc-card--flush" id="tc-items">
          <div className="tc-card__header">
            <div>
              <h2 className="tc-card__title">Expense items <Count n={form.items.length} tone="neutral" /></h2>
              <p className="tc-card__subtitle">{editable ? 'One line per bill or trip leg. Fields change with the expense item.' + (gridBtn ? ' Use Date-wise entry to fill fixed daily items for many dates at once.' : '')
                : `${plural(form.items.length, 'line')} · ${money(total)} claimed${over ? ` · ${plural(over, 'line exceeds', 'lines exceed')} a policy limit` : ''}`}</p>
            </div>
            {editable ? <div className="tc-row">{gridBtn ? <Button icon="calendar" label="Date-wise entry" onClick={openGrid} data-testid="date-grid" /> : null}<Button icon="plus" label="Add Expense" onClick={() => openLine(null)} data-testid="add-expense" /></div>
              : approving && form.items.length ? <Button variant="ghost" size="sm" icon="check" label="Fill within policy limits" onClick={autofill} data-testid="autofill" /> : null}
          </div>
          {editable && pendingIds.length ? (() => {
            const list = pendingList(pendingIds, boxReceipts, form.items, form.id);
            return list.length ? (
              <div className="tc-pending-bills" data-testid="pending-bills">
                <div className="tc-pending-bills__head"><Icon name="inbox" /><span><strong>Bills from your receipt box</strong> · {plural(list.length, 'bill')} to add. Pick the expense type above, then add each bill as a line.</span>
                  <Button variant="ghost" className="tc-btn--neutral" size="sm" label="Dismiss" onClick={() => { setPendingIds([]); clearPendingReceipts(); }} data-testid="pending-dismiss" /></div>
                <div className="tc-pending-bills__list">
                  {list.map((r) => (
                    <div key={r.id} className="tc-pending-bill">
                      <FileChip att={r.file} />
                      <span className="tc-pending-bill__meta">{[r.billerName, date(r.date), r.amount ? money(r.amount) : ''].filter(Boolean).join(' · ')}</span>
                      <Button variant="secondary" size="sm" icon="plus" label="Add as expense" onClick={() => openLine(null, [r.id])} data-testid={`pending-add-${r.id}`} />
                    </div>
                  ))}
                </div>
              </div>
            ) : null;
          })() : null}
          {eligibilityWarningError ? <Alert tone="warning" title="Eligibility could not be checked">{eligibilityWarningError}</Alert> : null}
          {form.items.length
            ? <ClaimItems items={approvalItems} expenseType={form.expenseType} editable={editable} approving={approving} showApproval={showApproval} lineErrors={lineErrors} total={total} approvedTotal={apprTotal}
                eligibilityByLine={eligibilityByLine}
                onEdit={(lid) => { const it = form.items.find((x) => x.id === lid); if (it) openLine(it); }} onRemove={removeLine}
                onApproval={(lid, patch) => update({ items: form.items.map((x) => (x.id === lid ? { ...x, ...patch } : x)) })}
                onGstChange={(lid, key: GstFieldKey, value) => update({ items: form.items.map((x) =>
                  x.id === lid ? { ...x, fields: { ...x.fields, [key]: value } } : x,
                ) })} />
            : <EmptyState icon="receipt" title={editable ? 'Add your first expense line' : 'No expense lines'} body={editable ? 'Each line is one bill or trip leg. You can edit or remove lines until you submit.' : 'This claim has no lines.'}
                action={editable ? <div className="tc-row tc-row--center">{gridBtn ? <Button icon="calendar" label="Date-wise entry" onClick={openGrid} /> : null}<Button icon="plus" label="Add Expense" onClick={() => openLine(null)} /></div> : undefined} />}
        </section>

        <div className="tc-grid-main tc-grid--stretch">
          <section className="tc-card">
            <div className="tc-card__header"><h2 className="tc-card__title">Comments</h2></div>
            <div className="tc-stack tc-stack--16">
              {editable ? <Field label="Employee Comments" type="textarea" optional value={form.employeeComments} placeholder="Context for the approver" testId="employee-comments" onChange={(v) => update({ employeeComments: String(v) })} />
                : <ReadonlyField label="Employee Comments" value={form.employeeComments} />}
              {approving ? <>
                <Field label="Approver Comments" type="textarea" optional value={form.approverComments} placeholder="Shown to the employee after approval" testId="approver-comments" onChange={(v) => update({ approverComments: String(v) })} />
                <Field label="Rejection Reason" type="textarea" value={form.rejectionReason} placeholder="Tell the employee what to fix" error={errors.rejectionReason} helper="Required only when rejecting" testId="rejection-reason" onChange={(v) => update({ rejectionReason: String(v) })} />
              </> : <>
                {form.approverComments || form.status === 'approved' ? <ReadonlyField label="Approver Comments" value={form.approverComments} /> : null}
                {form.status === 'rejected' ? <ReadonlyField label="Rejection Reason" value={form.rejectionReason} /> : null}
              </>}
            </div>
          </section>
          <section className="tc-card">
            <div className="tc-card__header"><h2 className="tc-card__title">Summary</h2></div>
            <dl className="tc-summary">
              <div className="tc-summary__row"><dt>Lines</dt><dd>{form.items.length}</dd></div>
              <div className={'tc-summary__row' + (over ? ' tc-summary__row--warn' : '')}><dt>Over policy limit</dt><dd>{over}</dd></div>
              <div className="tc-summary__row tc-summary__row--total"><dt>Total Amount</dt><dd data-testid="total-amount">{money(total)}</dd></div>
              {form.status === 'approved' || approving ? <div className="tc-summary__row tc-summary__row--accent"><dt>Approved Amount</dt><dd data-approved-total data-testid="approved-amount">{money(apprTotal)}</dd></div> : null}
            </dl>
          </section>
        </div>
      </div>

      <div className="tc-actionbar" ref={barRef}>
        <div className="tc-actionbar__group">
          {/* {form.requestNumber ? <Button variant="ghost" className="tc-btn--neutral" icon="print" label="Download as PDF" hook="print" onClick={() => window.print()} /> : null} */}

          {form.requestNumber ? (
          <Button
            variant="ghost"
            // className="tc-btn--neutral"
            icon="file-text"
            label="Download as PDF"
            onClick={() => void previewPdf()}
            disabled={busy}
          />
        ) : null}
        
        </div>
        <span className="tc-actionbar__meta" data-testid="meta">{editable ? (dirty ? 'Unsaved changes' : isNew ? 'Not saved yet' : `Saved ${dateTime(form.updatedAt)}`) : `${plural(form.items.length, 'line')} · ${money(total)}`}</span>
        <span className="tc-actionbar__spacer" />
        <div className="tc-actionbar__group">
          {editable ? <>
            {canDelete(form, actor) ? <Button variant="destructive-outline" icon="trash" label="Delete" hook="delete" disabled={busy} onClick={() => void remove()} data-testid="delete" /> : null}
            <Button icon="save" label="Save Draft" hook="save" disabled={busy} onClick={() => void saveDraft()} data-testid="save-draft" />
            <Button variant="primary" icon="send" label="Submit" hook="submit" disabled={busy || !form.items.length} onClick={() => void submit()} data-testid="submit" />
          </> : approving ? <>
            <Button variant="destructive" icon="x-circle" label="Reject" hook="reject" disabled={busy} onClick={() => void reject()} data-testid="reject" />
            <Button variant="primary" icon="check-circle" label="Approve" hook="approve" disabled={busy} onClick={() => void approve()} data-testid="approve" />
          </> : canCopy(form, actor) ? <Button icon="copy" label="Copy to new draft" hook="copy" disabled={busy} onClick={() => void copy()} /> : null}
        </div>
      </div>
    </>
  );
}
