import { useRef } from 'react';
import { Icon } from './Icon';

export interface TabItem { key: string; label: string; icon?: string; count?: number }

/** Underlined tab strip with a roving tabindex and arrow/Home/End keys (as in the prototype). */
export function Tabs({ items, active, onSelect, label, panelId }: { items: readonly TabItem[]; active: string; onSelect: (key: string) => void; label?: string; panelId?: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (i: number): void => { const it = items[i]; if (it) { onSelect(it.key); refs.current[i]?.focus(); } };
  return (
    <div className="tc-tabs" role="tablist" aria-label={label}>
      {items.map((it, i) => {
        const on = it.key === active;
        return (
          <button key={it.key} type="button" role="tab" id={`tc-tab-${it.key}`} className={'tc-tab' + (on ? ' is-active' : '')} aria-selected={on} tabIndex={on ? 0 : -1}
            aria-controls={panelId} data-testid={`tab-${it.key}`} ref={(el: HTMLButtonElement | null) => { refs.current[i] = el; }} onClick={() => onSelect(it.key)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); move((i + 1) % items.length); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); move((i - 1 + items.length) % items.length); }
              else if (e.key === 'Home') { e.preventDefault(); move(0); }
              else if (e.key === 'End') { e.preventDefault(); move(items.length - 1); }
            }}>
            {it.icon ? <Icon name={it.icon} /> : null}<span>{it.label}</span>
            {it.count !== undefined ? <span className="tc-tab__count">{it.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
