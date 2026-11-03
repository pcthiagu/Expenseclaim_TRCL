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
import { hasAnySuggestion } from '../../domain/receiptOcr';
import { normalizeLine, validateLine } from '../../domain/validation';
import type { LocationPolicyLimit, TravelClaimGateway } from '../../services/ports';
import { useReceipts } from './useReceipts';
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
  const [picker, setPicker] = useState(false);
  type OcrNote = { status: 'reading' } | { status: 'done'; filled: string[] } | { status: 'none' } | { status: 'failed'; message: string };
  const [ocrNote, setOcrNote] = useState<OcrNote | null>(null);
  const draftRef = useRef<ClaimLine | null>(null);
  const ocrAmount = useRef<number | null>(null);
  const ocrBill = useRef<string | null>(null);
  const seen = useRef<ReceiptSuggestion[]>([]); // every bill read on this line, re-applied if the expense item changes
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  draftRef.current = draft;
  const idef = itemByKey(claim.expenseType, draft.itemKey);
  const view: LineFields = idef?.compute === 'fuelKm' ? applyFuel(idef, draft.fields) : draft.fields;
  const stayLocation = idef?.fields.includes('stayLocation') ? String(view.stayLocation ?? '').trim() : '';
  const billAvailable = idef?.fields.includes('isBillAvailable')
    ? normalizeBillAvailability(view.isBillAvailable)
    : undefined;
  const locationPolicyKey = idef && (stayLocation || billAvailable)
    ? `${idef.key}:${stayLocation}:${billAvailable ?? ''}`
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
    const key = `${idef.key}:${stayLocation}:${billAvailable ?? ''}`;
    setLocationPolicy({ key, status: 'loading', result: null });
    void gateway.getLocationPolicyLimit(idef.key, stayLocation, billAvailable).then((result) => {
      if (!cancelled) setLocationPolicy({ key, status: 'loaded', result });
    }).catch(() => {
      if (!cancelled) setLocationPolicy({ key, status: 'error', result: null });
    });
    return () => { cancelled = true; };
  }, [gateway, idef?.key, stayLocation, billAvailable]);
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
  const set = (k: FieldKey, v: string | number): void => { setDraft((d) => ({ ...d, fields: { ...d.fields, [k]: v } })); };

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
    if (!reader.enabled) return;
    for (const f of files) {
      setOcrNote({ status: 'reading' });
      const { suggestion, error: err } = await reader.read(f);
      if (err) { setOcrNote({ status: 'failed', message: err }); continue; }
      if (!suggestion || !hasAnySuggestion(suggestion)) { setOcrNote({ status: 'none' }); continue; }
      seen.current.push(suggestion);
      const cur = draftRef.current;
      if (!cur || !cur.itemKey) continue;
      const r = applyOcr(cur.fields, cur.itemKey, suggestion);
      if (r.filled.length) { draftRef.current = { ...cur, fields: r.fields }; setDraft(draftRef.current); setOcrNote({ status: 'done', filled: r.filled }); } else setOcrNote({ status: 'none' });
    }
  };

  const focusAfterPick = useRef(false);
  // As in the prototype: after choosing an item, focus moves to its first editable field.
  useEffect(() => {
    if (!focusAfterPick.current) return;
    focusAfterPick.current = false;
    document.querySelector<HTMLElement>('[data-testid="line-modal"] .tc-form-grid input:not([readonly]):not([type=file]):not([type=checkbox]), [data-testid="line-modal"] .tc-form-grid select, [data-testid="line-modal"] .tc-form-grid textarea')?.focus();
  }, [draft.itemKey]);

  const pickItem = (key: string): void => {
    focusAfterPick.current = !!key;
    const nd = itemByKey(claim.expenseType, key);
    setDraft((d) => {
      let fields: LineFields = nd ? withBillAvailabilityDefault(nd, prefillFromReceipts(nd, {}, receiptsOn(d))) : {};
      ocrAmount.current = null; ocrBill.current = null;
      for (const sug of seen.current) fields = applyOcr(fields, key, sug).fields; // bills already read on this line fill the new item's blank fields
      return { ...d, itemKey: key, fields };
    });
    setErrors({}); setSummary([]);
  };

  const addFiles = async (files: File[]): Promise<void> => {
    const { metas, accepted } = await uploader.upload(files, { kind: 'claim', recordId: claim.id, lineId: draft.id });
    if (!metas.length) return;
    setDraft((d) => ({ ...d, attachments: [...d.attachments, ...metas] }));
    setErrors((e) => { const n = { ...e }; delete n.attachment; return n; });
    void readUploaded(accepted); // bills are read from the local files; the stored copies are what gets saved
  };

  const attachChecked = (): void => {
    const ids = Object.keys(checked).filter((k) => checked[k]);
    if (!ids.length) { toast('Select at least one bill', 'warning'); return; }
    const picked = ids.map((id) => byId.get(id)).filter((r): r is Receipt => !!r);
    setDraft((d) => {
      const attachments = [...d.attachments, ...picked.map(attachmentFromReceipt)];
      const fields = idef ? prefillFromReceipts(idef, d.fields, [...receiptsOn(d), ...picked]) : d.fields;
      return { ...d, attachments, fields };
    });
    setPicker(false); setChecked({});
    setErrors((e) => { const n = { ...e }; delete n.attachment; return n; });
    toast(`${plural(ids.length, 'bill')} attached from your receipt box`, 'info');
  };

  const save = (): void => {
    if (usesDynamicPolicy && currentLocationPolicy?.status !== 'loaded') {
      const message = currentLocationPolicy?.status === 'error'
        ? 'Could not verify eligibility. Try changing the location or bill availability and wait for the policy to load.'
        : 'Wait for the eligibility limit to load.';
      setErrors({ amount: message });
      setSummary([`Amount: ${message}`]);
      return;
    }
    const r = validateLine(draft, claim.expenseType, {
      eligibilityLimit: lineLimitAmount(limitDef, view),
      enforceEligibility: limitDef?.enforceEligibility,
    });
    if (!r.ok || !idef) { setErrors(r.errors); setSummary(r.summary); return; }
    onSave(normalizeLine({ ...draft, fields: r.fields }, idef));
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
        return <Field key={key} {...common} type="number" value={val} readonly required={false} helper="To KM minus From KM" tabIndex={-1} />;
      case 'attachment':
        return (
          <div key={key} className="tc-span-all">
            <FileField label="Bills" multiple files={draft.attachments} required={!idef.attachmentOptional && !billUnavailable} optional={!!idef.attachmentOptional || billUnavailable} disabled={billUnavailable}
              helper={billUnavailable ? 'Bill controls are disabled while Is Bill Available is No.' : 'Attach one or more bills for this line · PDF, JPG or PNG up to 5 MB each'} error={errors.attachment} full testId="line-file"
              placeholder={draft.attachments.length ? 'Add more bills' : 'Upload PDF, JPG or PNG'} onAdd={addFiles}
              onRemove={(i) => setDraft((d) => ({ ...d, attachments: d.attachments.filter((_, j) => j !== i) }))} />
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
      footer={<><Button label="Cancel" onClick={close} /><Button variant="primary" label={uploader.uploading ? 'Uploading…' : existing ? 'Save Changes' : 'Add Expense'} disabled={uploader.uploading} onClick={save} data-testid="line-save" /></>}>
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
