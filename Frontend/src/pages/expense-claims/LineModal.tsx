import { useEffect, useMemo, useRef, useState } from 'react';
import { useBillReader } from '../../app/OcrContext';
import type { ReceiptSuggestion } from '../../domain/receiptOcr';
import type { ReactNode } from 'react';
import { Icon } from '../../components/common/Icon';
import { Alert, Button } from '../../components/common/ui';
import { Field, FileField } from '../../components/forms/Field';
import { ModalFrame, useModal } from '../../components/modals/ModalHost';
import { useToast } from '../../components/common/Toast';
import { applyFuel, effectiveLimit, fuelRate, lineLimitAmount, overLimit } from '../../domain/calc';
import { FIELD_DEFS, itemByKey, lookup, normalizeBillAvailability, typeByKey, withBillAvailabilityDefault } from '../../domain/expenseSchema';
import { attachmentFromReceipt, pickableForLine, prefillFromReceipts } from '../../domain/receipts';
import { parseEmployeeCodes } from '../../domain/colleagues';
import { hasAnySuggestion } from '../../domain/receiptOcr';
import { normalizeLine, validateLine } from '../../domain/validation';
import type { LocationPolicyLimit, TravelClaimGateway } from '../../services/ports';
import { useReceipts } from './useReceipts';
import { AlongWithPicker } from './AlongWithPicker';
import { useUploader } from '../shared/useUploader';
import type { ClaimLine, ExpenseClaim, FieldKey, LineFields, Receipt } from '../../types/domain';
import { date, money, num, plural, today } from '../../utils/format';


/** Half-width fields that would sit alone on a row take the full row (e.g. Amount after the fuel km pairs). */
function orphanFields(keys: readonly FieldKey[]): Set<FieldKey> {
  const wide = new Set<FieldKey>();
  let col = 0;
  const isFull = (k: FieldKey): boolean => k === 'attachment' || !!FIELD_DEFS[k]?.full;
  keys.forEach((k, i) => {
    if (isFull(k)) { col = 0; return; }
    if (col === 0) {
      const next = keys[i + 1];
      if (!next || isFull(next)) wide.add(k); else col = 1;
    } else col = 0;
  });
  return wide;
}

export interface LineModalProps {
  claim: ExpenseClaim;
  existing: ClaimLine | null;
  gateway: TravelClaimGateway;
  isAdmin: boolean;
  eligibleAmount: number | null;
  presetReceiptIds?: readonly string[];
  newId: () => string;
  onSave: (line: ClaimLine) => void;
}

export function LineModal({ claim, existing, gateway, isAdmin, eligibleAmount, presetReceiptIds, newId, onSave }: LineModalProps) {
  const { close } = useModal();
  const { receipts, loading: receiptsLoading } = useReceipts(gateway, isAdmin);
  const reader = useBillReader();
  const uploader = useUploader();
  const toast = useToast();
  const def = typeByKey(claim.expenseType);
  const byId = useMemo(() => new Map(receipts.map((r) => [r.id, r] as const)), [receipts]);
  const receiptsOn = (l: ClaimLine): Receipt[] => l.attachments.map((a) => (a.receiptId ? byId.get(a.receiptId) : undefined)).filter((r): r is Receipt => !!r);

  const [draft, setDraft] = useState<ClaimLine>(() => {
    const base: ClaimLine = existing ? JSON.parse(JSON.stringify(existing)) as ClaimLine : { id: newId(), itemKey: '', fields: {}, attachments: [], approvedAmount: null, approverRemarks: '' };
    const item = itemByKey(claim.expenseType, base.itemKey);
    if (item) base.fields = withBillAvailabilityDefault(item, base.fields);
    return base;
  });
  // Receipt-box preset (Create claim from receipt box): attach those bills once the box has loaded.
  const [presetDone, setPresetDone] = useState(!presetReceiptIds?.length);
  useEffect(() => {
    if (presetDone || receiptsLoading) return;
    const picked = (presetReceiptIds ?? []).map((id) => byId.get(id)).filter((r): r is Receipt => !!r);
    if (picked.length) {
      setDraft((d) => {
        // If the item was already chosen before the receipt box finished loading, fill its blank fields from these bills now.
        const def = d.itemKey ? itemByKey(claim.expenseType, d.itemKey) : null;
        return { ...d, attachments: [...d.attachments, ...picked.map(attachmentFromReceipt)], fields: def ? prefillFromReceipts(def, d.fields, picked) : d.fields };
      });
    }
    setPresetDone(true);
  }, [presetDone, receiptsLoading, presetReceiptIds, byId, claim.expenseType]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string[]>([]);
  const validationAttempted = useRef(false);
  const [errorFocus, setErrorFocus] = useState<{ key: string; request: number } | null>(null);
  const errorFocusRequest = useRef(0);
  const [picker, setPicker] = useState(false);
  type OcrNote = { status: 'reading' } | { status: 'done'; filled: string[] } | { status: 'none' } | { status: 'failed'; message: string };
  const [ocrNote, setOcrNote] = useState<OcrNote | null>(null);
  const draftRef = useRef<ClaimLine | null>(null);
  const ocrAmount = useRef<number | null>(null);
  const ocrBill = useRef<string | null>(null);
  const ocrGeneration = useRef(0);
  const seen = useRef<ReceiptSuggestion[]>([]); // every bill read on this line, re-applied if the expense item changes
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  draftRef.current = draft;
  const idef = itemByKey(claim.expenseType, draft.itemKey);
  const view: LineFields = idef?.compute === 'fuelKm' ? applyFuel(idef, draft.fields) : draft.fields;
  const stayLocation = idef?.fields.includes('stayLocation') ? String(view.stayLocation ?? '').trim() : '';
  const billAvailable = idef?.fields.includes('isBillAvailable')
    ? normalizeBillAvailability(view.isBillAvailable)
    : undefined;
  const alongWithCodes = parseEmployeeCodes(String(view.alongWith ?? ''));
  const alongWithKey = JSON.stringify(alongWithCodes);
  const locationPolicyKey = idef && (stayLocation || billAvailable)
    ? `${idef.key}:${stayLocation}:${billAvailable ?? ''}:${alongWithKey}`
    : '';
  const [locationPolicy, setLocationPolicy] = useState<{
    key: string;
    status: 'loading' | 'loaded' | 'error';
    result: LocationPolicyLimit | null;
  } | null>(null);
  useEffect(() => {
    if (!idef || (!stayLocation && !billAvailable)) {
      setLocationPolicy(null);
      return;
    }
    let cancelled = false;
    const key = `${idef.key}:${stayLocation}:${billAvailable ?? ''}:${alongWithKey}`;
    setLocationPolicy({ key, status: 'loading', result: null });
    void gateway.getLocationPolicyLimit(idef.key, stayLocation, billAvailable, alongWithCodes).then((result) => {
      if (!cancelled) setLocationPolicy({ key, status: 'loaded', result });
    }).catch(() => {
      if (!cancelled) setLocationPolicy({ key, status: 'error', result: null });
    });
    return () => { cancelled = true; };
  }, [gateway, idef?.key, stayLocation, billAvailable, alongWithKey]);
  const currentLocationPolicy = locationPolicy?.key === locationPolicyKey ? locationPolicy : null;
  const usesDynamicPolicy = !!locationPolicyKey;
  const limitDef = usesDynamicPolicy
    ? currentLocationPolicy?.status === 'loaded'
      ? {
          ...idef!,
          limit: currentLocationPolicy.result?.limit ?? null,
          limitPer: currentLocationPolicy.result?.limitPer ?? idef!.limitPer,
          enforceEligibility: currentLocationPolicy.result?.enforceEligibility ?? idef!.enforceEligibility,
        }
      : null
    : idef;
  const wide = idef ? orphanFields(idef.fields) : new Set<FieldKey>();
  const billUnavailable = billAvailable === 'No';
  const validationFor = (line: ClaimLine): ReturnType<typeof validateLine> => {
    const item = itemByKey(claim.expenseType, line.itemKey);
    const fields = line.fields;
    const location = item?.fields.includes('stayLocation') ? String(fields.stayLocation ?? '').trim() : '';
    const availability = item?.fields.includes('isBillAvailable') ? normalizeBillAvailability(fields.isBillAvailable) : undefined;
    const codes = parseEmployeeCodes(String(fields.alongWith ?? ''));
    const key = item && (location || availability) ? `${item.key}:${location}:${availability ?? ''}:${JSON.stringify(codes)}` : '';
    const policy = key ? (locationPolicy?.key === key ? locationPolicy : null) : null;
    const resolvedItem = item && key && policy?.status === 'loaded'
      ? {
          ...item,
          limit: policy.result?.limit ?? null,
          limitPer: policy.result?.limitPer ?? item.limitPer,
          enforceEligibility: policy.result?.enforceEligibility ?? item.enforceEligibility,
        }
      : item;
    const result = validateLine(line, claim.expenseType, {
      eligibilityLimit: lineLimitAmount(resolvedItem, fields),
      enforceEligibility: resolvedItem?.enforceEligibility,
    });
    if (!key || policy?.status === 'loaded') return result;

    const message = policy?.status === 'error'
      ? 'Could not verify eligibility. Try changing the location or bill availability and wait for the policy to load.'
      : 'Wait for the eligibility limit to load.';
    const nextErrors: Record<string, string> = { ...result.errors, amount: message };
    const labels: Record<string, string> = { itemKey: 'Expense Item', attachment: 'Bills' };
    for (const fieldKey of Object.keys(nextErrors)) {
      labels[fieldKey] ??= FIELD_DEFS[fieldKey as FieldKey]?.label ?? fieldKey;
    }
    return {
      ...result,
      errors: nextErrors,
      summary: Object.keys(nextErrors).map((fieldKey) =>
        `${labels[fieldKey]}: ${fieldKey === 'itemKey' ? 'choose an item' : nextErrors[fieldKey]}`,
      ),
      ok: false,
    };
  };
  const applyValidation = (line: ClaimLine): void => {
    const result = validationFor(line);
    setErrors(result.errors);
    setSummary(result.summary);
  };
  const updateDraft = (update: (current: ClaimLine) => ClaimLine): void => {
    const next = update(draftRef.current ?? draft);
    draftRef.current = next;
    setDraft(next);
    if (validationAttempted.current) applyValidation(next);
  };
  const set = (k: FieldKey, v: string | number): void => {
    updateDraft((current) => ({ ...current, fields: { ...current.fields, [k]: v } }));
  };

  useEffect(() => {
    if (!errorFocus) return;
    const selector = errorFocus.key === 'attachment' ? '[data-testid="line-file"]' : `[data-testid="line-${errorFocus.key}"]`;
    const target = document.querySelector<HTMLElement>(`[data-testid="line-modal"] ${selector}`);
    const scrollTarget = errorFocus.key === 'attachment' ? target?.closest<HTMLElement>('.tc-field') : target;
    if (!target || !scrollTarget) return;
    scrollTarget.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const focusTarget = errorFocus.key === 'attachment'
      ? scrollTarget.querySelector<HTMLElement>('.tc-dropzone')
      : target;
    focusTarget?.focus({ preventScroll: true });
  }, [errorFocus?.key, errorFocus?.request]);
  useEffect(() => {
    if (validationAttempted.current) applyValidation(draftRef.current ?? draft);
  }, [locationPolicyKey, currentLocationPolicy?.status, currentLocationPolicy?.result]);

  const pickable = pickableForLine(receipts, claim.items, draft, claim.id);

  /** Fills BLANK fields from a bill the user uploaded. Several bills on one line add up (amount) and join (bill numbers) only while the field still holds the OCR value, so edits are never overwritten. */
  const applyOcr = (fields: LineFields, itemKey: string, sug: ReceiptSuggestion): { fields: LineFields; filled: string[] } => {
    const d = itemByKey(claim.expenseType, itemKey);
    const out: LineFields = { ...fields };
    const filled: string[] = [];
    if (!d) return { fields: out, filled };
    const has = (k: FieldKey): boolean => d.fields.includes(k);
    const blank = (k: FieldKey): boolean => out[k] === undefined || out[k] === null || out[k] === '';
    if (has('date') && sug.date && blank('date')) { out.date = sug.date.value; filled.push('date'); }
    if (has('billerName') && sug.billerName && blank('billerName')) { out.billerName = sug.billerName.value; filled.push('biller'); }
    if (has('billNumber') && sug.billNumber) {
      if (blank('billNumber')) { out.billNumber = sug.billNumber.value; ocrBill.current = sug.billNumber.value; filled.push('bill number'); }
      else if (out.billNumber === ocrBill.current && !String(out.billNumber).split(', ').includes(sug.billNumber.value)) { ocrBill.current = `${String(out.billNumber)}, ${sug.billNumber.value}`; out.billNumber = ocrBill.current; filled.push('bill number'); }
    }
    if (has('amount') && d.compute !== 'fuelKm' && sug.amount) {
      if (blank('amount')) { out.amount = sug.amount.value; ocrAmount.current = sug.amount.value; filled.push('amount'); }
      else if (num(out.amount) === ocrAmount.current && ocrAmount.current !== null) { ocrAmount.current = Math.round((ocrAmount.current + sug.amount.value) * 100) / 100; out.amount = ocrAmount.current; filled.push('amount'); }
    }
    return { fields: out, filled };
  };
  const readUploaded = async (files: File[]): Promise<void> => {
    const generation = ocrGeneration.current;
    if (!reader.enabled) return;
    for (const f of files) {
      setOcrNote({ status: 'reading' });
      const { suggestion, error: err } = await reader.read(f);
      if (generation !== ocrGeneration.current) return;
      if (err) { setOcrNote({ status: 'failed', message: err }); continue; }
      if (!suggestion || !hasAnySuggestion(suggestion)) { setOcrNote({ status: 'none' }); continue; }
      seen.current.push(suggestion);
      const cur = draftRef.current;
      if (!cur || !cur.itemKey) continue;
      const r = applyOcr(cur.fields, cur.itemKey, suggestion);
      if (r.filled.length) { updateDraft((current) => ({ ...current, fields: r.fields })); setOcrNote({ status: 'done', filled: r.filled }); } else setOcrNote({ status: 'none' });
    }
  };

  const focusAfterPick = useRef(false);
  const focusNextItem = useRef(false);
  // As in the prototype: after choosing an item, focus moves to its first editable field.
  useEffect(() => {
    if (!focusAfterPick.current) return;
    focusAfterPick.current = false;
    document.querySelector<HTMLElement>('[data-testid="line-modal"] .tc-form-grid input:not([readonly]):not([type=file]):not([type=checkbox]), [data-testid="line-modal"] .tc-form-grid select, [data-testid="line-modal"] .tc-form-grid textarea')?.focus();
  }, [draft.itemKey]);

  useEffect(() => {
    if (!focusNextItem.current) return;
    focusNextItem.current = false;
    document.querySelector<HTMLElement>('[data-testid="line-item"]')?.focus();
  }, [draft.id]);

  const pickItem = (key: string): void => {
    focusAfterPick.current = !!key;
    const nd = itemByKey(claim.expenseType, key);
    updateDraft((d) => {
      let fields: LineFields = nd ? withBillAvailabilityDefault(nd, prefillFromReceipts(nd, {}, receiptsOn(d))) : {};
      ocrAmount.current = null; ocrBill.current = null;
      for (const sug of seen.current) fields = applyOcr(fields, key, sug).fields; // bills already read on this line fill the new item's blank fields
      return { ...d, itemKey: key, fields };
    });
    if (!validationAttempted.current) { setErrors({}); setSummary([]); }
  };

  const addFiles = async (files: File[]): Promise<void> => {
    const { metas, accepted } = await uploader.upload(files, { kind: 'claim', recordId: claim.id, lineId: draft.id });
    if (!metas.length) return;
    updateDraft((d) => ({ ...d, attachments: [...d.attachments, ...metas] }));
    void readUploaded(accepted); // bills are read from the local files; the stored copies are what gets saved
  };

  const attachChecked = (): void => {
    const ids = Object.keys(checked).filter((k) => checked[k]);
    if (!ids.length) { toast('Select at least one bill', 'warning'); return; }
    const picked = ids.map((id) => byId.get(id)).filter((r): r is Receipt => !!r);
    updateDraft((d) => {
      const attachments = [...d.attachments, ...picked.map(attachmentFromReceipt)];
      const fields = idef ? prefillFromReceipts(idef, d.fields, [...receiptsOn(d), ...picked]) : d.fields;
      return { ...d, attachments, fields };
    });
    setPicker(false); setChecked({});
    toast(`${plural(ids.length, 'bill')} attached from your receipt box`, 'info');
  };

  const save = (addNext = false): void => {
    validationAttempted.current = true;
    const r = validationFor(draft);
    setErrors(r.errors);
    setSummary(r.summary);
    if (!r.ok || !idef) {
      const firstError = Object.keys(r.errors)[0];
      if (firstError) setErrorFocus({ key: firstError, request: ++errorFocusRequest.current });
      return;
    }
    const saved = normalizeLine({ ...draft, fields: r.fields }, idef);
    onSave(saved);
    if (addNext && !existing) {
      const next: ClaimLine = { id: newId(), itemKey: '', fields: {}, attachments: [], approvedAmount: null, approverRemarks: '' };
      draftRef.current = next;
      setDraft(next);
      setErrors({});
      setSummary([]);
      validationAttempted.current = false;
      setErrorFocus(null);
      setPicker(false);
      setChecked({});
      setOcrNote(null);
      ocrGeneration.current++;
      seen.current = [];
      ocrAmount.current = null;
      ocrBill.current = null;
      focusNextItem.current = true;
      toast(`${idef.label} added · ${money(r.fields.amount)}. Add the next expense.`, 'success');
      return;
    }
    close();
    toast(existing ? 'Expense line updated' : `${idef.label} added · ${money(r.fields.amount)}`);
  };

  const fieldEl = (key: FieldKey): ReactNode => {
    if (!idef) return null;
    if (billUnavailable && (key === 'billerName' || key === 'billNumber' || key === 'attachment')) return null;
    const fd = FIELD_DEFS[key];
    const span = !!fd.full || wide.has(key);
    const common = { label: fd.label, required: !!fd.required, error: errors[key], full: span };
    const val = view[key] ?? '';
    switch (key) {
      case 'limit': {
        return null;
      }
      case 'amount': {
        const over = overLimit(limitDef, view);
        const limit = (usesDynamicPolicy || idef.fields.includes('limit')) && limitDef ? effectiveLimit(limitDef, view) : null;
        const props = { ...common, type: 'money' as const, value: val, onChange: (v: string | number) => set(key, v), testId: 'line-amount' } as const;
        const policyContext = stayLocation ? ` for ${stayLocation}` : billAvailable ? ` (${billAvailable.toLowerCase()} bill)` : '';
        const policyHelper = usesDynamicPolicy
          ? currentLocationPolicy?.status === 'loading' || !currentLocationPolicy ? `Loading policy limit${policyContext}…`
            : currentLocationPolicy.status === 'error' ? `Could not load policy limit${policyContext}.`
              : limit ? `Policy limit${policyContext}: ${limit.text}.` : `No policy limit configured${policyContext}.`
          : limit ? `Policy limit: ${limit.text}.` : '';
        const eligibleHelper = eligibleAmount == null ? '' : `Eligible amount: ${money(eligibleAmount)}.`;
        if (idef.compute === 'fuelKm') {
          const helper = [`Auto-computed: claimable km × ₹${fuelRate(idef)} per km.`, policyHelper, eligibleHelper].filter(Boolean).join(' ');
          return <Field key={key} {...props} readonly required={false} helper={helper} tabIndex={-1} />;
        }
        const eligibilityLimit = lineLimitAmount(limitDef, view);
        const eligibilityOver = eligibilityLimit != null && num(view.amount) > eligibilityLimit;
        const limitOver = over && idef.limitQty == null;
        const policyWarning = !errors.amount && limitOver
          ? limitDef?.enforceEligibility === 'Y'
            ? `Exceeds eligibility by ${money(over)}. Reduce the amount to add this expense.`
            : limitDef?.enforceEligibility === 'N'
              ? `Exceeds eligibility by ${money(over)}.`
              : `Exceeds the policy limit by ${money(over)}. The approver may cap this line.`
          : '';
        const helper = [policyHelper, eligibleHelper, policyWarning].filter(Boolean).join(' ');
        if (helper) return <Field key={key} {...props} helper={helper} {...(policyWarning || (eligibilityOver && limitDef?.enforceEligibility === 'N') ? { helperTone: 'warning' as const } : {})} />;
        return <Field key={key} {...props} />;
      }
      case 'qty': {
        const overQ = overLimit(idef, view);
        return <Field key={key} {...common} type="number" step={fd.step} min={fd.min} value={val} testId="line-qty" onChange={(v) => set(key, v)}
          {...(!errors.qty && overQ ? { helper: `Exceeds the ${idef.limitQty} litre cap by ${overQ} litres.`, helperTone: 'warning' as const } : {})} />;
      }
      case 'totalKm':
        return <Field key={key} {...common} type="number" value={val} readonly required={false} helper="Trip KM minus non-accountable KM" tabIndex={-1} />;
      case 'alongWith':
        return <AlongWithPicker key={key} value={String(val)} gateway={gateway} onChange={(value) => set(key, value)}
          label={fd.label} placeholder={fd.placeholder} helper={fd.helper} error={errors[key]} full={span} testId={`line-${key}`} />;
      case 'attachment':
        return (
          <div key={key} className="tc-span-all">
            <FileField label="Bills" multiple files={draft.attachments} required={!idef.attachmentOptional && !billUnavailable} optional={!!idef.attachmentOptional || billUnavailable} disabled={billUnavailable}
              helper={billUnavailable ? 'Bill controls are disabled while Is Bill Available is No.' : 'Attach one or more bills for this line · PDF, JPG or PNG up to 5 MB each'} error={errors.attachment} full testId="line-file"
              placeholder={draft.attachments.length ? 'Add more bills' : 'Upload PDF, JPG or PNG'} onAdd={addFiles}
              onRemove={(i) => updateDraft((d) => ({ ...d, attachments: d.attachments.filter((_, j) => j !== i) }))} />
            {ocrNote ? (
              <p className={'tc-helper' + (ocrNote.status === 'failed' ? ' tc-helper--warning' : '')} role="status" data-testid="line-ocr">
                {ocrNote.status === 'reading' ? 'Reading the bill…' : ocrNote.status === 'done' ? `Read from your bill: ${ocrNote.filled.join(', ')}. Please check ${ocrNote.filled.length === 1 && !ocrNote.filled[0]?.includes('(') ? 'it' : 'them'}.` : ocrNote.status === 'none' ? 'Could not find details on this bill. Please fill them in.' : `${ocrNote.message} Please fill the details in.`}
              </p>
            ) : null}
            {!billUnavailable ? receiptPicker() : null}
          </div>
        );
      default: {
        const type = fd.type === 'select' ? 'select' : fd.type === 'textarea' ? 'textarea' : fd.type === 'number' ? 'number' : fd.type === 'date' ? 'date' : fd.type === 'time' ? 'time' : 'text';
        return (
          <Field key={key} {...common} type={type} value={val} placeholder={fd.placeholder} helper={fd.helper} step={fd.step} min={fd.min}
            disabled={billUnavailable && (key === 'billerName' || key === 'billNumber')}
            max={key === 'date' ? today() : undefined} {...(fd.type === 'select' && key === 'isBillAvailable' ? { options: lookup('BILL_AVAILABILITY') } : fd.type === 'select' && fd.options ? { options: lookup(fd.options) } : {})}
            testId={`line-${key}`} onChange={(v) => set(key, v)} />
        );
      }
    }
  };

  const receiptPicker = (): ReactNode => {
    if (isAdmin) return null; // approvers have no receipt box
    if (receiptsLoading) return <div className="tc-receiptpick tc-span-all"><Button variant="ghost" size="sm" icon="inbox" label="Loading receipt box…" disabled /></div>;
    if (!picker) {
      return (
        <div className="tc-receiptpick tc-span-all">
          <Button variant="ghost" size="sm" icon="inbox" label={pickable.length ? `Choose from receipt box (${pickable.length})` : 'Receipt box has no unused bills'} disabled={!pickable.length} onClick={() => setPicker(true)} data-testid="picker-open" />
        </div>
      );
    }
    return (
      <fieldset className="tc-receiptpick tc-receiptpick--open tc-span-all" data-testid="picker">
        <legend>Choose bills from your receipt box</legend>
        <div className="tc-receiptpick__list">
          {pickable.map((r) => (
            <label key={r.id} className="tc-receiptpick__row">
              <input type="checkbox" checked={!!checked[r.id]} data-testid={`pick-${r.id}`} onChange={(e) => setChecked((c) => ({ ...c, [r.id]: e.target.checked }))} />
              <span className="tc-receiptpick__name"><Icon name={r.file.type.indexOf('image') === 0 ? 'eye' : 'file'} />{r.file.name}</span>
              <span className="tc-receiptpick__meta">{[r.billerName, r.date ? date(r.date) : ''].filter(Boolean).join(' · ') || 'No details yet'}</span>
              <span className="tc-receiptpick__amt tc-mono">{r.amount ? money(r.amount) : '—'}</span>
            </label>
          ))}
        </div>
        <div className="tc-receiptpick__foot">
          <Button variant="ghost" className="tc-btn--neutral" size="sm" label="Cancel" onClick={() => setPicker(false)} />
          <Button size="sm" icon="paperclip" label="Attach selected" onClick={attachChecked} data-testid="picker-attach" />
        </div>
      </fieldset>
    );
  };

  if (!def) return null;
  return (
    <ModalFrame title={existing ? 'Edit Expense' : 'Add Expense'} size="drawer" testId="line-modal"
      footer={<><Button label="Cancel" onClick={close} /><Button variant="primary" label={uploader.uploading ? 'Uploading…' : existing ? 'Save Changes' : 'Add Expense'} disabled={uploader.uploading} onClick={() => save()} data-testid="line-save" />
        {!existing ? <Button variant="primary" label="Add & Next" disabled={uploader.uploading} onClick={() => save(true)} data-testid="line-add-next" /> : null}
      </>}>
      <div className="tc-stack tc-stack--16">
        {summary.length ? <Alert tone="error" title="Please complete the highlighted fields"><ul>{summary.map((s) => <li key={s}>{s}</li>)}</ul></Alert> : null}
        <Field label="Expense Item" type="select" required value={draft.itemKey} placeholder="Select an expense item" testId="line-item"
          options={def.items.map((i) => ({ value: i.key, label: i.label }))} error={errors.itemKey} onChange={(v) => pickItem(String(v))}
          helper={idef?.helper ?? (idef ? '' : `${def.label} · ${def.items.length} items available`)} />
        {idef ? <div className="tc-form-grid">{idef.fields.map(fieldEl)}</div> : null}
      </div>
    </ModalFrame>
  );
}
