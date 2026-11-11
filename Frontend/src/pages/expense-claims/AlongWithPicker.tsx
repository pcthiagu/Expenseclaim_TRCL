import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/common/ui';
import { Field } from '../../components/forms/Field';
import { parseEmployeeCodes, serializeEmployeeCodes } from '../../domain/colleagues';
import type { TravelClaimGateway } from '../../services/ports';
import type { Employee } from '../../types/domain';

export function AlongWithPicker(p: {
  value: string;
  gateway: TravelClaimGateway;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  helper?: string;
  error?: string;
  full?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const codes = parseEmployeeCodes(p.value);
  return (
    <>
      <Field
        label={p.label}
        value={codes.join(', ')}
        readonly
        placeholder={p.placeholder ?? 'Colleagues who travelled with you, if any'}
        helper={p.helper}
        error={p.error}
        full={p.full}
        testId={p.testId}
        suffix={<Button size="sm" label={codes.length ? `Edit (${codes.length})` : 'Select'} onClick={() => setOpen(true)} data-testid="along-with-open" />}
      />
      {open ? (
        <ColleagueDialog
          gateway={p.gateway}
          selectedCodes={codes}
          onClose={() => setOpen(false)}
          onSave={(selected) => { p.onChange(serializeEmployeeCodes(selected)); setOpen(false); }}
        />
      ) : null}
    </>
  );
}

function ColleagueDialog(p: {
  gateway: TravelClaimGateway;
  selectedCodes: readonly string[];
  onClose: () => void;
  onSave: (codes: string[]) => void;
}) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<Employee[] | null>(null);
  const [selected, setSelected] = useState<string[]>([...p.selectedCodes]);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      p.gateway.lookupEmployees(query).then((result) => {
        if (!cancelled) { setRows(result); setError(null); }
      }).catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Employee lookup failed.');
      });
    }, query ? 250 : 0);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [p.gateway, query]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      p.onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = Array.from(dialog.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };

  const toggle = (code: string): void => {
    setSelected((current) => current.includes(code) ? current.filter((value) => value !== code) : [...current, code]);
  };

  return createPortal(
    <div className="tc-colleague-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) p.onClose(); }}>
      <div ref={dialog} className="tc-colleague-dialog" role="dialog" aria-modal="true" aria-labelledby="tc-colleague-title" onKeyDown={onKeyDown}>
        <div className="tc-colleague-dialog__header">
          <h2 id="tc-colleague-title">Select colleagues</h2>
          <Button variant="ghost" className="tc-btn--neutral" iconOnly icon="close" label="Close" onClick={p.onClose} />
        </div>
        <div className="tc-colleague-dialog__body">
          <Field type="search" value={query} onChange={(value) => setQuery(String(value))} placeholder="Search by code, name or department" ariaLabel="Search employees" autoFocus testId="along-with-query" />
          {selected.length ? (
            <div className="tc-colleague-selected" aria-label={`${selected.length} selected employee codes`}>
              <span>{selected.length} selected:</span>
              {selected.map((code) => (
                <button key={code} type="button" className="tc-colleague-chip" onClick={() => toggle(code)} aria-label={`Remove ${code}`}>
                  {code}<span aria-hidden="true"> ×</span>
                </button>
              ))}
            </div>
          ) : <p className="tc-text-secondary tc-colleague-count">Select one or more employees.</p>}
          {error ? <p className="tc-error" role="alert">{error}</p>
            : rows === null ? <p className="tc-text-secondary tc-colleague-status" role="status">Searching employees…</p>
              : rows.length === 0 ? <p className="tc-text-secondary tc-colleague-status">No employees match.</p>
                : <div className="tc-colleague-list" aria-label="Employees">
                    {rows.map((employee) => (
                      <label key={employee.code} className="tc-colleague-row" data-testid={`along-with-employee-${employee.code}`}>
                        <input type="checkbox" checked={selected.includes(employee.code)} onChange={() => toggle(employee.code)} />
                        <span className="tc-pick__text">
                          <span className="tc-pick__name">{employee.name}</span>
                          <span className="tc-pick__meta">{employee.code} · {employee.department} · {employee.costCentre}</span>
                        </span>
                      </label>
                    ))}
                  </div>}
        </div>
        <div className="tc-colleague-dialog__footer">
          <Button variant="secondary" label="Cancel" onClick={p.onClose} />
          <Button variant="primary" label={`Done${selected.length ? ` (${selected.length})` : ''}`} onClick={() => p.onSave(selected)} data-testid="along-with-done" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
