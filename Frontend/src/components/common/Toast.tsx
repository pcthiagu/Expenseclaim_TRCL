import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';
interface Item { id: number; msg: string; tone: ToastTone; in: boolean }
type ToastFn = (msg: string, tone?: ToastTone, ms?: number) => void;
const Ctx = createContext<ToastFn | null>(null);
export const useToast = (): ToastFn => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useToast must be used inside <ToastProvider>');
  return c;
};

let seq = 0;
export function ToastProvider({ children }: { children?: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const root = typeof document !== 'undefined' ? document.getElementById('toast-root') : null;
  const toast = useCallback<ToastFn>((msg, tone = 'success', ms = 3500) => {
    const id = ++seq;
    setItems((l) => [...l, { id, msg, tone, in: false }]);
    requestAnimationFrame(() => requestAnimationFrame(() => setItems((l) => l.map((t) => (t.id === id ? { ...t, in: true } : t)))));
    setTimeout(() => setItems((l) => l.map((t) => (t.id === id ? { ...t, in: false } : t))), ms);
    setTimeout(() => setItems((l) => l.filter((t) => t.id !== id)), ms + 300);
  }, []);
  return (
    <Ctx.Provider value={toast}>
      {children}
      {root ? createPortal(items.map((t) => (
        <div key={t.id} className={`tc-toast tc-toast--${t.tone}${t.in ? ' is-in' : ''}`} role={t.tone === 'error' ? 'alert' : 'status'}>
          <Icon name={t.tone === 'error' ? 'x-circle' : t.tone === 'warning' ? 'alert' : t.tone === 'info' ? 'info' : 'check-circle'} />
          <span>{t.msg}</span>
        </div>
      )), root) : null}
    </Ctx.Provider>
  );
}

/** Keeps the fixed action bar's height in --tc-actionbar-h so page padding and toasts clear it. */
export function useActionBarHeight(active: boolean, ref: { current: HTMLElement | null }): void {
  useEffect(() => {
    const root = document.documentElement;
    const el = ref.current;
    if (!active || !el) { root.style.removeProperty('--tc-actionbar-h'); return; }
    const set = (): void => root.style.setProperty('--tc-actionbar-h', el.offsetHeight + 'px');
    set();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.style.removeProperty('--tc-actionbar-h'); };
  });
}
