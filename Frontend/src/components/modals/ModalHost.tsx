import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../common/ui';

/**
 * Single-slot modal/drawer host rendering into #modal-root (the element and its CSS come from the prototype:
 * `.is-open` on the root drives the backdrop/panel transitions). `open(element)` shows any element that renders a
 * <ModalFrame>; the element keeps its own state, so live grids and forms work inside it.
 */
interface ModalApi {
  open: (content: ReactNode) => void;
  close: () => void;
  confirm: (o: { title: string; body: string; confirmLabel?: string; cancelLabel?: string; variant?: 'primary' | 'destructive' }) => Promise<boolean>;
  isOpen: boolean;
}
const Ctx = createContext<ModalApi | null>(null);
export const useModal = (): ModalApi => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useModal must be used inside <ModalHost>');
  return c;
};

export function ModalHost({ children }: { children?: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null);
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const root = typeof document !== 'undefined' ? document.getElementById('modal-root') : null;

  const open = useCallback((c: ReactNode) => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setContent(c); setMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
  }, []);
  const close = useCallback(() => {
    setShown(false);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { setMounted(false); setContent(null); timer.current = null; }, 300);
  }, []);
  const confirm = useCallback<ModalApi['confirm']>((o) => new Promise<boolean>((resolve) => {
    open(<ConfirmDialog {...o} onResult={(ok) => { resolve(ok); close(); }} />);
  }), [open, close]);

  useEffect(() => {
    if (!root) return;
    root.hidden = !mounted;
    root.classList.toggle('is-open', shown);
    document.body.classList.toggle('tc-no-scroll', mounted);
  }, [mounted, shown, root]);

  const api: ModalApi = { open, close, confirm, isOpen: mounted };
  return (
    <Ctx.Provider value={api}>
      {children}
      {root && mounted ? createPortal(<><div className="tc-backdrop" onClick={close} data-testid="modal-backdrop" />{content}</>, root) : null}
    </Ctx.Provider>
  );
}

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** The dialog panel: header, scrolling body, optional footer, focus trap, Escape to close, focus restore. */
export function ModalFrame(p: { title: string; size?: 'sm' | 'md' | 'lg' | 'drawer'; className?: string; footer?: ReactNode; children?: ReactNode; onClose?: () => void; autoFocus?: boolean; testId?: string }) {
  const { close } = useModal();
  const ref = useRef<HTMLDivElement | null>(null);
  const onClose = p.onClose ?? close;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const last = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = (): HTMLElement[] => (el ? Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => e.offsetParent !== null) : []);
    if (p.autoFocus !== false && el) {
      const body = el.querySelector<HTMLElement>('.tc-modal__body');
      const f = body ? Array.from(body.querySelectorAll<HTMLElement>(FOCUSABLE)) : [];
      (f[0] ?? el.querySelector<HTMLElement>('.tc-modal__title'))?.focus();
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); return; }
      if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0] as HTMLElement; const lastEl = f[f.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (last && document.body.contains(last)) last.focus(); };
  }, [p.autoFocus]);

  return (
    <div ref={ref} className={`tc-modal tc-modal--${p.size ?? 'md'}${p.size === 'drawer' ? ' tc-modal--drawer' : ''}${p.className ? ' ' + p.className : ''}`}
      role="dialog" aria-modal="true" aria-labelledby="tc-modal-title" data-testid={p.testId}>
      <div className="tc-modal__header">
        <h2 className="tc-modal__title" id="tc-modal-title" tabIndex={-1}>{p.title}</h2>
        <Button variant="ghost" className="tc-btn--neutral" iconOnly icon="close" label="Close" onClick={onClose} />
      </div>
      <div className="tc-modal__body">{p.children}</div>
      {p.footer ? <div className="tc-modal__footer">{p.footer}</div> : null}
    </div>
  );
}

function ConfirmDialog(p: { title: string; body: string; confirmLabel?: string; cancelLabel?: string; variant?: 'primary' | 'destructive'; onResult: (ok: boolean) => void }) {
  const ok = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { ok.current?.focus(); }, []);
  return (
    <ModalFrame title={p.title} size="sm" autoFocus={false} onClose={() => p.onResult(false)} testId="confirm-dialog"
      footer={<>
        <Button variant="secondary" label={p.cancelLabel ?? 'Cancel'} onClick={() => p.onResult(false)} />
        <button ref={ok} type="button" className={`tc-btn tc-btn--${p.variant ?? 'primary'}`} data-testid="confirm-ok" onClick={() => p.onResult(true)}><span>{p.confirmLabel ?? 'Confirm'}</span></button>
      </>}>
      <p className="tc-modal__text">{p.body}</p>
    </ModalFrame>
  );
}
