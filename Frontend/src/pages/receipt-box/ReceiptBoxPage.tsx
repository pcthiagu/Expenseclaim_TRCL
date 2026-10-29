import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { useBillReader } from '../../app/OcrContext';
import { navigate } from '../../app/router';
import { Icon } from '../../components/common/Icon';
import { Tabs } from '../../components/common/Tabs';
import { useToast } from '../../components/common/Toast';
import { Alert, Badge, Button, EmptyState } from '../../components/common/ui';
import { Field } from '../../components/forms/Field';
import { useModal } from '../../components/modals/ModalHost';
import { DEFAULT_POLICY } from '../../config/policy';
import { applySuggestion, hasAnySuggestion } from '../../domain/receiptOcr';
import { ApiError, checkAttachment } from '../../services/apiClient';
import type { Receipt } from '../../types/domain';
import { dateTime, fileSize, money, num, plural, today } from '../../utils/format';
import { setPendingReceipts } from './pendingReceipts';

type Tab = 'unused' | 'used' | 'all';
type OcrState = { status: 'reading' } | { status: 'done'; filled: string[] } | { status: 'none' } | { status: 'failed'; message: string };
const FIELD_LABEL: Record<string, string> = { date: 'bill date', billerName: 'biller', billNumber: 'bill number', amount: 'amount' };

export function ReceiptBoxPage() {
  const { gateway } = useApp();
  const toast = useToast();
  const modal = useModal();
  const reader = useBillReader();
  const [list, setList] = useState<Receipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('unused');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [ocr, setOcr] = useState<Record<string, OcrState>>({});
  const [over, setOver] = useState(false);
  // `live` is the source of truth (updated synchronously) so queued saves always see the latest receipts; `list` just renders it.
  const live = useRef<Receipt[]>([]);
  const setAll = useCallback((next: Receipt[]): void => { live.current = next; setList(next); }, []);
  const queues = useRef<Record<string, Promise<void>>>({});
  // Text typed into a card but not yet committed (committed on blur, as the prototype's `change` event did).
  const [drafts, setDrafts] = useState<Record<string, Partial<Receipt>>>({});
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;

  useEffect(() => {
    let off = false;
    gateway.listReceipts().then((r) => { if (!off) setAll(r); }).catch((e: unknown) => { if (!off) setError(e instanceof ApiError ? e.message : 'Could not load your receipt box.'); });
    return () => { off = true; };
  }, [gateway, setAll]);

  const replace = useCallback((r: Receipt): void => setAll(live.current.map((x) => (x.id === r.id ? r : x))), [setAll]);

  /**
   * ALL saves of one receipt (the user's and OCR's) run one after another. Each builds its payload from the latest state when it
   * runs, so a slow save can never overwrite a newer edit locally or on the server. `build` returns null for "nothing to save".
   */
  const save = useCallback((id: string, build: (latest: Receipt) => Receipt | null): Promise<void> => {
    const run = async (): Promise<void> => {
      const base = live.current.find((x) => x.id === id);
      if (!base) return;
      const next = build(base);
      if (!next) return;
      replace(next);
      try { replace(await gateway.updateReceipt(next)); }
      catch (e) { replace(base); toast(e instanceof ApiError ? e.message : 'Could not save that change.', 'error'); }
    };
    const done = (queues.current[id] ?? Promise.resolve()).then(run, run);
    queues.current[id] = done;
    return done;
  }, [gateway, replace, toast]);

  /** Reads one bill and fills ONLY fields that are still blank when the result is applied (never overwrites what the user typed). */
  const readOne = useCallback(async (receipt: Receipt, file: File): Promise<void> => {
    setOcr((o) => ({ ...o, [receipt.id]: { status: 'reading' } }));
    const { suggestion, error: err } = await reader.read(file);
    if (err) { setOcr((o) => ({ ...o, [receipt.id]: { status: 'failed', message: err } })); return; }
    if (!suggestion || !hasAnySuggestion(suggestion)) { setOcr((o) => ({ ...o, [receipt.id]: { status: 'none' } })); return; }
    let filledLabels: string[] = [];
    await save(receipt.id, (latest) => {
      // What the user sees right now: saved values plus anything typed but not yet committed.
      const cur = { ...latest, ...(draftsRef.current[receipt.id] ?? {}) };
      const { fields, filled } = applySuggestion({ date: cur.date, billerName: cur.billerName, billNumber: cur.billNumber, amount: cur.amount }, suggestion);
      filledLabels = filled.map((f) => FIELD_LABEL[f] ?? f);
      return filled.length ? { ...latest, ...fields } : null;
    });
    setOcr((o) => ({ ...o, [receipt.id]: filledLabels.length ? { status: 'done', filled: filledLabels } : { status: 'none' } }));
  }, [reader, save]);

  const addFiles = async (files: File[]): Promise<void> => {
    const ok: File[] = [];
    for (const f of files) { const e = checkAttachment(f, DEFAULT_POLICY); if (e) toast(e, 'error'); else ok.push(f); }
    if (!ok.length) return;
    try {
      const created = await gateway.uploadReceipts(ok);
      setAll([...created, ...live.current]);
      setTab('unused');
      toast(`${plural(created.length, 'bill')} added to your receipt box.` + (reader.enabled ? ' Reading the details…' : ' Add the date and amount when you can.'));
      if (reader.enabled) for (let i = 0; i < created.length; i++) { const r = created[i], f = ok[i]; if (r && f) await readOne(r, f); } // one at a time: OCR is memory-hungry
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Upload failed. Your other bills are unchanged.', 'error'); }
  };

  if (error) return <div className="tc-card"><Alert tone="error" title="Could not load your receipt box">{error}</Alert></div>;
  if (!list) return <div aria-busy="true" data-testid="receipts-loading">Loading…</div>;

  const unused = list.filter((r) => !r.usedIn);
  const usedL = list.filter((r) => r.usedIn);
  const shown = tab === 'unused' ? unused : tab === 'used' ? usedL : list;
  const sel = unused.filter((r) => selected[r.id]);
  const selTotal = sel.reduce((s, r) => s + num(r.amount), 0);
  const emptyMsg = tab === 'used'
    ? { icon: 'receipt', title: 'No bills on claims yet', body: 'Bills you add to an expense claim show up here with the claim they belong to.' }
    : { icon: 'inbox', title: list.length ? 'Every bill is on a claim' : 'Your receipt box is empty', body: 'Upload bills as you get them. When you are ready, select them and create an expense claim.' };

  /** Saves a committed edit (queued behind any save already running for this receipt). */
  const edit = (id: string, patch: Partial<Receipt>): Promise<void> => save(id, (latest) => ({ ...latest, ...patch }));
  const draft = (id: string, patch: Partial<Receipt>): void => setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? {}), ...patch } }));
  const commit = (id: string): void => {
    const d = draftsRef.current[id];
    if (!d || !Object.keys(d).length) return;
    setDrafts((all) => { const n = { ...all }; delete n[id]; return n; });
    void edit(id, d);
  };
  const remove = async (r: Receipt): Promise<void> => {
    if (!(await modal.confirm({ title: 'Delete this bill?', body: `${r.file.name} will be removed from your receipt box.`, confirmLabel: 'Delete bill', variant: 'destructive' }))) return;
    try { await gateway.deleteReceipt(r.id); setAll(live.current.filter((x) => x.id !== r.id)); setSelected((s) => { const n = { ...s }; delete n[r.id]; return n; }); toast('Bill deleted', 'info'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the bill.', 'error'); }
  };

  const card = (r: Receipt) => {
    const used = !!r.usedIn;
    const checked = !!selected[r.id] && !used;
    const st = ocr[r.id];
    return (
      <article key={r.id} className={'tc-receipt' + (checked ? ' is-selected' : '') + (used ? ' is-used' : '')} data-receipt={r.id} data-testid={`receipt-${r.id}`}>
        <div className="tc-receipt__top">
          {used ? <span className="tc-receipt__check" aria-hidden="true" /> : (
            <label className="tc-check tc-receipt__select" title="Select for a claim">
              <input type="checkbox" checked={checked} data-testid={`select-${r.id}`} aria-label={`Select ${r.file.name}`} onChange={(e) => setSelected((s) => ({ ...s, [r.id]: e.target.checked }))} />
              <span className="tc-check__box"><Icon name="check" /></span>
            </label>
          )}
          <span className="tc-receipt__thumb"><Icon name={r.file.type.indexOf('image') === 0 ? 'eye' : 'file'} size={20} /></span>
          <span className="tc-receipt__file">
            <span className="tc-receipt__name" title={r.file.name}>{r.file.name}</span>
            <span className="tc-receipt__meta">{fileSize(r.file.size)} · uploaded {dateTime(r.uploadedAt)}</span>
          </span>
          {used ? <a className="tc-badge tc-badge--info" href={`#/claims/${encodeURIComponent(r.usedIn?.claimId ?? '')}`}>On claim {r.usedIn?.requestNumber || 'draft'}</a> : <Badge label="Unused" />}
        </div>
        {st?.status === 'reading' ? <p className="tc-helper" data-testid={`ocr-${r.id}`} role="status"><Icon name="refresh" /> Reading the bill…</p> : null}
        {st?.status === 'done' ? <p className="tc-helper" data-testid={`ocr-${r.id}`} role="status"><Icon name="sparkles" /> Read from the bill: {st.filled.join(', ')}. Please check {st.filled.length === 1 ? 'it' : 'them'}.</p> : null}
        {st?.status === 'none' ? <p className="tc-helper" data-testid={`ocr-${r.id}`} role="status">Could not find details on this bill. Please fill them in.</p> : null}
        {st?.status === 'failed' ? <p className="tc-helper tc-helper--warning" data-testid={`ocr-${r.id}`} role="status">{st.message} Please fill the details in.</p> : null}
        <div className="tc-receipt__grid">
          <Field label="Bill Date" type="date" size="sm" value={(drafts[r.id]?.date ?? r.date) as string | number} max={today()} readonly={used} testId={`rdate-${r.id}`} onChange={(v) => draft(r.id, { date: String(v) })} onBlur={() => commit(r.id)} />
          <Field label="Amount" type="money" size="sm" value={(drafts[r.id]?.amount ?? r.amount) as string | number} readonly={used} testId={`ramount-${r.id}`} onChange={(v) => draft(r.id, { amount: v === '' ? '' : Number(v) })} onBlur={() => commit(r.id)} />
          <Field label="Biller Name" size="sm" value={(drafts[r.id]?.billerName ?? r.billerName) as string | number} placeholder="Vendor or establishment" readonly={used} testId={`rbiller-${r.id}`} onChange={(v) => draft(r.id, { billerName: String(v) })} onBlur={() => commit(r.id)} />
          <Field label="Bill Number" size="sm" value={(drafts[r.id]?.billNumber ?? r.billNumber) as string | number} placeholder="As printed on the bill" readonly={used} testId={`rbill-${r.id}`} onChange={(v) => draft(r.id, { billNumber: String(v) })} onBlur={() => commit(r.id)} />
          <Field label="Notes" size="sm" value={(drafts[r.id]?.notes ?? r.notes) as string | number} placeholder="What was it for?" readonly={used} full testId={`rnotes-${r.id}`} onChange={(v) => draft(r.id, { notes: String(v) })} onBlur={() => commit(r.id)} />
        </div>
        {used ? null : <div className="tc-receipt__foot"><Button variant="ghost" className="tc-btn--neutral" size="sm" icon="trash" label="Delete" onClick={() => void remove(r)} data-testid={`delete-${r.id}`} /></div>}
      </article>
    );
  };

  return (
    <>
      <div className="tc-page-header">
        <div className="tc-page-header__text">
          <Button variant="ghost" className="tc-btn--neutral tc-page-header__back" iconOnly icon="arrow-left" label="Back to dashboard" onClick={() => navigate('#/dashboard')} data-testid="back" />
          <div><h1 className="tc-page-title">Receipt box</h1><p className="tc-page-subtitle">Keep your bills here as you get them, then claim them together.</p></div>
        </div>
        <div className="tc-page-actions">
          <Button variant="primary" icon="receipt" label={sel.length ? `Create expense claim (${sel.length})` : 'Create expense claim'} disabled={!sel.length} data-testid="create-claim"
            onClick={() => { setPendingReceipts(sel.map((r) => r.id)); setSelected({}); navigate('#/claims/new'); }} />
        </div>
      </div>
      <div className="tc-stack tc-stack--16">
        <label className={'tc-bigdrop' + (over ? ' is-over' : '')} data-testid="dropzone"
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragEnter={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setOver(false); }}
          onDrop={(e) => { e.preventDefault(); setOver(false); const fl = Array.from<File>(e.dataTransfer?.files ?? []); if (fl.length) void addFiles(fl); }}>
          <Icon name="upload" size={24} />
          <span className="tc-bigdrop__title">Drop bills here or <span className="tc-bigdrop__link">browse</span></span>
          <span className="tc-bigdrop__sub">PDF, JPG or PNG up to 5 MB each. Add as many as you like.{reader.enabled ? ' Details are read from each bill for you to check.' : ''}</span>
          <input type="file" className="tc-visually-hidden" multiple accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" data-testid="upload"
            onChange={(e) => { const fl = Array.from<File>(e.target.files ?? []); e.target.value = ''; if (fl.length) void addFiles(fl); }} />
        </label>
        <div className="tc-page-tabs">
          <Tabs label="Bills" panelId="tc-receipt-panel" active={tab} onSelect={(k) => setTab(k as Tab)}
            items={[{ key: 'unused', label: 'Unused', icon: 'inbox', count: unused.length }, { key: 'used', label: 'On a claim', icon: 'receipt', count: usedL.length }, { key: 'all', label: 'All bills', icon: 'grid', count: list.length }]} />
        </div>
        <section id="tc-receipt-panel" role="tabpanel" aria-labelledby={`tc-tab-${tab}`}>
          {tab !== 'used' && unused.length ? (
            <div className="tc-receipts__bar">
              <label className="tc-check">
                <input type="checkbox" checked={sel.length > 0 && sel.length === unused.length} data-testid="select-all" onChange={(e) => setSelected(Object.fromEntries(unused.map((r) => [r.id, e.target.checked])))} />
                <span className="tc-check__box"><Icon name="check" /></span><span className="tc-check__label">Select all unused</span>
              </label>
              <span className="tc-text-secondary tc-text-s" data-testid="selection-summary">{sel.length ? `${plural(sel.length, 'bill')} selected · ${money(selTotal)}` : 'Select bills to claim them together'}</span>
            </div>
          ) : null}
          {shown.length ? <div className="tc-receipts">{shown.map(card)}</div> : <div className="tc-card"><EmptyState {...emptyMsg} /></div>}
        </section>
      </div>
    </>
  );
}
