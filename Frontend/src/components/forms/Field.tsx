import { useId } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../common/Icon';
import { FileChip } from '../common/ui';
import type { AttachmentMeta } from '../../types/domain';

export type FieldType = 'text' | 'password' | 'number' | 'date' | 'time' | 'datetime-local' | 'select' | 'textarea' | 'money' | 'search';
export type Opt = string | { value: string; label: string };

export interface FieldProps {
  label?: string;
  type?: FieldType;
  value: string | number | null | undefined;
  /** number/money fields emit '' or a number; everything else emits a string. */
  onChange?: (v: string | number) => void;
  onBlur?: () => void;
  options?: readonly Opt[];
  placeholder?: string | false;
  required?: boolean;
  optional?: boolean;
  readonly?: boolean;
  disabled?: boolean;
  full?: boolean;
  size?: 'sm';
  error?: string;
  helper?: string;
  helperTone?: 'warning';
  min?: number; max?: string | number; step?: number;
  list?: string;
  className?: string;
  suffix?: ReactNode;
  name?: string;
  ariaLabel?: string;
  inputMode?: 'numeric' | 'decimal';
  autoFocus?: boolean;
  tabIndex?: number;
  id?: string;
  testId?: string;
}

/** One form field in the RXD markup (tc-field / tc-label / tc-input ...). Controlled. */
export function Field(p: FieldProps) {
  const auto = useId();
  const id = p.id ?? 'f' + auto.replace(/:/g, '');
  const type = p.type ?? 'text';
  const msgId = id + '-msg';
  const val = p.value ?? '';
  const cls = ['tc-field'];
  if (p.error) cls.push('tc-field--error');
  if (p.full) cls.push('tc-span-all');
  if (p.className) cls.push(p.className);
  const common = {
    id, name: p.name, required: p.required || undefined, 'aria-required': p.required ? true : undefined,
    readOnly: p.readonly || undefined, disabled: p.disabled || undefined, 'aria-invalid': p.error ? true : undefined,
    'aria-describedby': p.error || p.helper ? msgId : undefined, 'aria-label': p.ariaLabel, tabIndex: p.tabIndex,
    'data-testid': p.testId, autoFocus: p.autoFocus, onBlur: p.onBlur,
  };
  const emit = (raw: string): void => {
    if (!p.onChange) return;
    if (type === 'number' || type === 'money') p.onChange(raw === '' ? '' : parseFloat(raw));
    else p.onChange(raw);
  };
  const sm = p.size === 'sm' ? ' tc-input--sm' : '';
  let control: ReactNode;
  if (type === 'select') {
    control = (
      <div className="tc-select-wrap">
        <select className={'tc-input tc-select' + sm} {...common} value={String(val)} onChange={(e) => emit(e.target.value)}>
          {p.placeholder === false ? null : <option value="">{p.placeholder || 'Select'}</option>}
          {(p.options ?? []).map((o) => {
            const v = typeof o === 'object' ? o.value : o;
            const l = typeof o === 'object' ? o.label : o;
            return <option key={v} value={v}>{l}</option>;
          })}
        </select>
        <Icon name="chevron-down" className="tc-select-chevron" />
      </div>
    );
  } else if (type === 'textarea') {
    control = <textarea className="tc-input tc-textarea" rows={3} {...common} placeholder={p.placeholder || undefined} value={String(val)} onChange={(e) => emit(e.target.value)} />;
  } else if (type === 'money') {
    control = (
      <div className="tc-input-group">
        <span className="tc-input-prefix" aria-hidden="true">₹</span>
        <input type="number" inputMode="decimal" step={0.01} min={0} className={'tc-input tc-input--num' + sm} {...common} value={String(val)} onChange={(e) => emit(e.target.value)} />
      </div>
    );
  } else if (type === 'search') {
    control = (
      <div className="tc-search"><Icon name="search" />
        <input type="search" className="tc-input" {...common} placeholder={p.placeholder || undefined} value={String(val)} onChange={(e) => emit(e.target.value)} />
      </div>
    );
  } else {
    control = (
      <input type={type} className={'tc-input' + (type === 'number' ? ' tc-input--num' : '') + sm} {...common}
        placeholder={p.placeholder || undefined} min={p.min} max={p.max} step={p.step} list={p.list} inputMode={p.inputMode}
        value={String(val)} onChange={(e) => emit(e.target.value)} />
    );
  }
  if (p.suffix) control = <div className="tc-input-row">{control}{p.suffix}</div>;

  return (
    <div className={cls.join(' ')}>
      {p.label ? (
        <label className="tc-label" htmlFor={id}>
          {p.label}
          {p.required ? <> <span className="tc-req" aria-hidden="true">*</span></> : null}
          {p.optional ? <> <span className="tc-optional">(optional)</span></> : null}
        </label>
      ) : null}
      {control}
      {p.error ? (
        <p className="tc-error" id={msgId}><Icon name="alert" /><span>{p.error}</span></p>
      ) : p.helper ? (
        <p className={'tc-helper' + (p.helperTone ? ' tc-helper--' + p.helperTone : '')} id={msgId}>{p.helper}</p>
      ) : null}
    </div>
  );
}

/** Read-only value shown like a disabled surface. */
export function ReadonlyField({ label, value, mono, full, helper, children }: { label?: string; value?: string | number | null; mono?: boolean; full?: boolean; helper?: string; children?: ReactNode }) {
  return (
    <div className={'tc-field' + (full ? ' tc-span-all' : '')}>
      {label ? <span className="tc-label">{label}</span> : null}
      <div className={'tc-readonly' + (mono ? ' tc-mono' : '')}>{children ?? (value === undefined || value === null || value === '' ? '—' : String(value))}</div>
      {helper ? <p className="tc-helper">{helper}</p> : null}
    </div>
  );
}

export function CheckField({ label, helper, checked, onChange, full }: { label: string; helper?: string; checked: boolean; onChange: (v: boolean) => void; full?: boolean }) {
  const id = 'c' + useId().replace(/:/g, '');
  return (
    <div className={'tc-field' + (full ? ' tc-span-all' : '')}>
      <label className="tc-check" htmlFor={id}>
        <input type="checkbox" id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="tc-check__box"><Icon name="check" /></span>
        <span className="tc-check__label">{label}{helper ? <span className="tc-helper">{helper}</span> : null}</span>
      </label>
    </div>
  );
}

/** Drop zone + chips for bills. File CONTENT upload is not wired (backend route unknown): metadata only, as in the prototype. */
export function FileField(p: {
  label?: string; files: AttachmentMeta[]; multiple?: boolean; readonly?: boolean; disabled?: boolean; required?: boolean; optional?: boolean;
  helper?: string; error?: string; placeholder?: string; full?: boolean; onAdd: (files: File[]) => void; onRemove: (i: number) => void; testId?: string;
}) {
  const id = 'u' + useId().replace(/:/g, '');
  const msgId = id + '-msg';
  const showZone = !p.readonly && !p.disabled && (p.multiple || !p.files.length);
  return (
    <div className={'tc-field' + (p.error ? ' tc-field--error' : '') + (p.full ? ' tc-span-all' : '')}>
      {p.label ? (
        <span className="tc-label" id={id + '-label'}>{p.label}
          {p.required ? <> <span className="tc-req" aria-hidden="true">*</span></> : null}
          {p.optional ? <> <span className="tc-optional">(optional)</span></> : null}
        </span>
      ) : null}
      <div className={'tc-file' + (p.files.length ? ' has-files' : '')}>
        {p.files.length ? (
          <div className="tc-file__chips">{p.files.map((a, i) => <FileChip key={a.name + i} att={a} onRemove={p.readonly || p.disabled ? undefined : () => p.onRemove(i)} />)}</div>
        ) : null}
        {showZone ? (
          <label className="tc-dropzone" htmlFor={id} tabIndex={p.error ? 0 : undefined} aria-invalid={p.error ? true : undefined}
            aria-describedby={p.error ? msgId : undefined}>
            <Icon name="upload" /><span>{p.placeholder ?? 'Upload PDF, JPG or PNG'}</span>
            <input type="file" className="tc-visually-hidden" id={id} data-testid={p.testId} multiple={p.multiple} aria-invalid={p.error ? true : undefined}
              aria-describedby={p.error ? msgId : undefined}
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              onChange={(e) => { const fl = Array.from<File>(e.target.files ?? []); e.target.value = ''; if (fl.length) p.onAdd(fl); }} />
          </label>
        ) : null}
        {p.readonly && !p.files.length ? <span className="tc-text-secondary">No document attached</span> : null}
      </div>
      {p.error ? <p className="tc-error" id={msgId}><Icon name="alert" /><span>{p.error}</span></p> : p.helper ? <p className="tc-helper">{p.helper}</p> : null}
    </div>
  );
}
