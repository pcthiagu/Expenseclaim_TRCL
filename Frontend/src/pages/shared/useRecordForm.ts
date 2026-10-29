import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { navigate } from '../../app/router';
import { useToast } from '../../components/common/Toast';
import { useModal } from '../../components/modals/ModalHost';
import { KINDS } from '../../domain/expenseSchema';
import type { PolicyConfig } from '../../config/policy';
import type { ValidationResult } from '../../domain/validation';
import { canApprove, canDelete, canEdit } from '../../domain/workflow';
import { ApiError } from '../../services/apiClient';
import type { SessionUser } from '../../services/ports';
import type { AdvanceRequest, Employee, TravelClaimRecord, TravelRequest } from '../../types/domain';
import { rememberDashboardKind } from '../dashboard/DashboardPage';

export const uid = (): string => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

type Req = TravelRequest | AdvanceRequest;
export interface Confirm { title: string; body: string; confirmLabel: string }
export interface RecordFormConfig<T extends Req> {
  kind: 'travel' | 'advance';
  id: string | null;
  noun: string; // "travel request" / "advance request"
  blank: (s: SessionUser, isAdmin: boolean) => T;
  validate: (form: T, forSubmit: boolean, ctx: { employeeExists: (c: string) => boolean; records: readonly TravelClaimRecord[]; policy?: PolicyConfig }) => ValidationResult;
  /** Tidy the form before it is saved (e.g. drop blank estimate rows). */
  normalize?: (form: T) => T;
  submitConfirm: (form: T) => Confirm;
  approveConfirm: (form: T, records: readonly TravelClaimRecord[]) => Confirm;
}

type Load = 'loading' | 'ready' | 'notfound' | 'error';

/** State and actions shared by the travel and advance request forms. All persistence goes through the gateway. */
export function useRecordForm<T extends Req>(cfg: RecordFormConfig<T>) {
  const { gateway, session, actor, isAdmin, policy } = useApp();
  const toast = useToast();
  const modal = useModal();
  const [load, setLoad] = useState<Load>('loading');
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState<T | null>(null);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string[]>([]);
  const [records, setRecords] = useState<TravelClaimRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [reqNo, setReqNo] = useState('');
  const lock = useRef(false);
  const cfgRef = useRef(cfg); cfgRef.current = cfg;
  const K = KINDS[cfg.kind];
  const listHash = `#/${K.route}`;

  const refresh = useCallback(async () => { try { setRecords((await gateway.listRecords({})).rows); } catch { /* advisory data; the server enforces limits */ } }, [gateway]);

  useEffect(() => {
    let off = false;
    (async () => {
      try {
        if (cfg.id) {
          const r = await gateway.getRecord(cfg.kind, cfg.id);
          if (off) return;
          if (r.kind !== cfg.kind) { setLoad('notfound'); return; }
          setForm(clone(r) as T); setReqNo(r.requestNumber);
        } else setForm(cfgRef.current.blank(session, isAdmin));
        setLoad('ready'); void refresh();
      } catch (e) {
        if (off) return;
        if (e instanceof ApiError && (e.code === 'not_found' || e.code === 'forbidden')) setLoad('notfound');
        else { setLoadError(e instanceof Error ? e.message : 'Could not load the request.'); setLoad('error'); }
      }
    })();
    return () => { off = true; };
  }, [cfg.id, cfg.kind, gateway, session, isAdmin, refresh]);

  const editable = !!form && canEdit(form, actor);
  const approving = !!form && canApprove(form, actor, { allowSelfApproval: policy.allowSelfApproval });
  const isNew = !cfg.id;
  const ctx = useMemo(() => ({ employeeExists: () => !!form?.employeeName, records: records ?? [] }), [form?.employeeName, records]);

  const update = useCallback((patch: Partial<T>): void => { setForm((f) => (f ? { ...f, ...patch } : f)); setDirty(true); }, []);

  const showServerError = (e: unknown): void => {
    if (e instanceof ApiError) {
      const d = e.details as { summary?: string[] } | null;
      setSummary(d && Array.isArray(d.summary) && d.summary.length ? d.summary : [e.message]);
      toast(e.message, 'error');
    } else { setSummary(['Something went wrong. Try again.']); toast('Something went wrong. Try again.', 'error'); }
  };
  const guarded = async (fn: () => Promise<void>): Promise<void> => {
    if (lock.current) return; // duplicate-submission guard
    lock.current = true; setBusy(true);
    try { await fn(); } catch (e) { showServerError(e); } finally { lock.current = false; setBusy(false); }
  };
  const scrollToSummary = (): void => { setTimeout(() => document.getElementById('tc-form-summary')?.scrollIntoView({ block: 'center' }), 0); };

  /** The user's records for balance checks: the loaded copy, or a fresh fetch if the page was acted on before it arrived. */
  const freshRecords = async (): Promise<TravelClaimRecord[]> => {
    if (records) return records;
    const rows = (await gateway.listRecords({})).rows; setRecords(rows); return rows;
  };
  const validate = (forSubmit: boolean, recs: readonly TravelClaimRecord[]): boolean => {
    if (!form) return false;
    const r = cfg.validate(form, forSubmit, { employeeExists: ctx.employeeExists, records: recs, policy });
    setErrors(r.errors); setSummary(r.summary);
    if (!r.ok) scrollToSummary();
    return r.ok;
  };

  const persist = async (): Promise<T> => {
    const toSave = cfg.normalize ? cfg.normalize(form as T) : (form as T);
    const saved = await gateway.saveDraft(toSave);
    if (saved.kind !== cfg.kind) throw new Error('Unexpected response from the server.');
    setForm(clone(saved) as T); setReqNo(saved.requestNumber); setDirty(false); setErrors({}); setSummary([]); void refresh();
    return saved as T;
  };
  const goTo = (rec: { id: string }): void => navigate(`${listHash}/${encodeURIComponent(rec.id)}`, { replace: true });

  const leave = (): void => {
    const go = (): void => { rememberDashboardKind(session.role, cfg.kind); navigate('#/dashboard'); };
    if (dirty && editable) void modal.confirm({ title: 'Leave without saving?', body: 'Your unsaved changes will be lost.', confirmLabel: 'Leave', variant: 'destructive' }).then((ok) => { if (ok) go(); });
    else go();
  };

  const saveDraft = (): Promise<void> => guarded(async () => {
    if (!validate(false, await freshRecords())) return;
    const saved = await persist();
    toast(`Draft ${saved.requestNumber} saved`);
    if (isNew) goTo(saved);
  });
  const submit = (): Promise<void> => guarded(async () => {
    if (!validate(true, await freshRecords())) return;
    const c = cfg.submitConfirm(form as T);
    if (!(await modal.confirm(c))) return;
    const saved = await persist();
    const done = await gateway.submit(cfg.kind, saved.id);
    if (done.kind === cfg.kind) setForm(clone(done) as T);
    toast(`${K.label} ${done.requestNumber} submitted`);
    void refresh();
    if (isNew) goTo(saved);
  });
  const approve = (): Promise<void> => guarded(async () => {
    setErrors({}); setSummary([]);
    const recs = await freshRecords(); // the confirmation quotes balances, so it must use real data
    if (!(await modal.confirm(cfg.approveConfirm(form as T, recs)))) return;
    const r = await gateway.approve(cfg.kind, (form as T).id, { approverRemarks: (form as T).approverRemarks });
    if (r.kind === cfg.kind) setForm(clone(r) as T);
    setDirty(false); toast(`${K.label} ${r.requestNumber} approved`);
  });
  const reject = (): Promise<void> => guarded(async () => {
    if (!String((form as T).approverRemarks ?? '').trim()) { setErrors({ approverRemarks: 'Give the employee a reason' }); setSummary(['Approver Remarks: required when rejecting']); scrollToSummary(); return; }
    setErrors({}); setSummary([]);
    if (!(await modal.confirm({ title: `Reject ${cfg.noun}?`, body: 'The employee will see your remarks.', confirmLabel: 'Reject request', variant: 'destructive' }))) return;
    const r = await gateway.reject(cfg.kind, (form as T).id, { approverRemarks: (form as T).approverRemarks });
    if (r.kind === cfg.kind) setForm(clone(r) as T);
    setDirty(false); toast(`${K.label} ${r.requestNumber} rejected`, 'info');
  });
  const remove = (): Promise<void> => guarded(async () => {
    if (!(await modal.confirm({ title: `Delete draft ${(form as T).requestNumber}?`, body: 'This cannot be undone.', confirmLabel: 'Delete draft', variant: 'destructive' }))) return;
    await gateway.deleteDraft(cfg.kind, (form as T).id);
    toast('Draft deleted', 'info'); navigate(listHash);
  });

  const pickEmployee = (e: Employee): void => { update({ employeeCode: e.code, employeeName: e.name, costCentre: e.costCentre } as unknown as Partial<T>); };
  const resolveCode = async (): Promise<void> => {
    if (!isAdmin || !form?.employeeCode) return;
    try { const hit = (await gateway.lookupEmployees(form.employeeCode)).find((e) => e.code === form.employeeCode.trim()); setForm((f) => (f ? { ...f, employeeName: hit?.name ?? '', costCentre: hit ? hit.costCentre : f.costCentre } : f)); } catch { /* shown on save */ }
  };
  const getRequest = async (): Promise<void> => {
    const n = reqNo.trim();
    if (!n) { toast('Enter a request number first', 'warning'); return; }
    try {
      const hit = (await gateway.listRecords({ search: n })).rows.find((r) => r.requestNumber.toUpperCase() === n.toUpperCase());
      if (!hit) { toast(`No request found for ${n}`, 'error'); return; }
      if (hit.id === form?.id) { toast('This request is already open', 'info'); return; }
      const target = `#/${KINDS[hit.kind].route}/${encodeURIComponent(hit.id)}`;
      if (dirty && editable) { if (await modal.confirm({ title: 'Leave without saving?', body: 'Your unsaved changes on this form will be lost.', confirmLabel: 'Leave', variant: 'destructive' })) navigate(target); } else navigate(target);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not look that request up.', 'error'); }
  };

  return {
    policy, load, loadError, form, update, dirty, setDirty, errors, summary, records, busy, reqNo, setReqNo, editable, approving, isNew,
    canDelete: !!form && canDelete(form, actor), actor, isAdmin, session, gateway, modal, toast, listHash,
    saveDraft, submit, approve, reject, remove, leave, pickEmployee, resolveCode, getRequest,
  };
}
export type RecordForm<T extends Req> = ReturnType<typeof useRecordForm<T>>;
