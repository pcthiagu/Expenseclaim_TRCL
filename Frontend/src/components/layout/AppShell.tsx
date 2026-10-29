import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../../app/AppContext';
import { initials } from '../../utils/format';
import { useToast } from '../common/Toast';
import { Alert, Button } from '../common/ui';
import { ModalFrame, useModal } from '../modals/ModalHost';
import { ChangePasswordForm } from '../../pages/auth/AuthPages';
import { Field } from '../forms/Field';

const VIEW_OPTIONS = [{ value: 'employee', label: 'Employee (apply claims)' }, { value: 'admin', label: 'Approver (review requests)' }];

/** Top bar (brand, View-as switch for approvers, account popover) + main content region. */
export function AppShell({ children }: { children?: ReactNode }) {
  const app = useApp();
  const toast = useToast();
  const modal = useModal();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  const u = app.session;

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent): void => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down, true); document.removeEventListener('keydown', key, true); };
  }, [open]);

  const roleLabel = u.role === 'admin' ? 'Admin · Approver' : 'Employee';
  return (
    <div className="tc-shell">
      <div className="tc-main">
        <header className="tc-topbar">
          <div className="tc-topbar__inner">
            <a className="tc-brand" href="#/claims" aria-label="The Ramco Cements Limited · Travel Claim home">
              <img className="tc-brand__logo" src={import.meta.env.BASE_URL + 'assets/trcl-logo.svg'} alt="" width={41} height={44} />
              <span className="tc-brand__divider" aria-hidden="true" />
              <span><span className="tc-brand__name">Travel Claim</span><br /><span className="tc-brand__sub">Employee Services</span></span>
            </a>
            <div className="tc-topbar__right">
              {app.viewSwitch ? (
                <div className="tc-role-switch">
                  <span className="tc-role-switch__label">View as</span>
                  <Field type="select" value={u.role} placeholder={false} options={VIEW_OPTIONS} ariaLabel="View as" testId="view-switch"
                    onChange={(v) => { const m = v as 'employee' | 'admin'; app.viewSwitch?.set(m); toast(`Now viewing as ${m === 'admin' ? 'Approver' : 'Employee'}`, 'info'); }} />
                </div>
              ) : null}
              <div style={{ position: 'relative' }} ref={wrap}>
                <button ref={btn} type="button" className="tc-avatar tc-avatar--sm tc-topbar__avatar" aria-haspopup="dialog" aria-expanded={open}
                  aria-label={`Account: ${u.name}, ${roleLabel}`} data-testid="account-button" onClick={() => setOpen(!open)}>{initials(u.name)}</button>
                {open ? (
                  <div className="tc-accountpop" role="dialog" aria-label="Account" data-testid="account-pop">
                    <div className="tc-accountpop__head">
                      <div className="tc-user">
                        <span className="tc-avatar" aria-hidden="true">{initials(u.name)}</span>
                        <div className="tc-user__text">
                          <div className="tc-user__name">{u.name}</div>
                          <div className="tc-user__meta">{roleLabel} · {u.code}</div>
                          <div className="tc-user__meta">{[u.designation, u.department].filter(Boolean).join(' · ')}</div>
                        </div>
                      </div>
                    </div>
                    {app.viewSwitch ? (
                      <div className="tc-accountpop__body">
                        <Field label="View as" type="select" size="sm" value={u.role} placeholder={false} options={VIEW_OPTIONS} ariaLabel="View as (account menu)"
                          helper="You are an approver: switch between applying as an employee and reviewing requests"
                          onChange={(v) => { setOpen(false); const m = v as 'employee' | 'admin'; app.viewSwitch?.set(m); toast(`Now viewing as ${m === 'admin' ? 'Approver' : 'Employee'}`, 'info'); }} />
                      </div>
                    ) : null}
                    <div className="tc-accountpop__body tc-stack tc-stack--8">
                      <Button variant="secondary" size="sm" icon="user" label="Change password" block data-testid="change-password"
                        onClick={() => { setOpen(false); modal.open(<ModalFrame title="Change password" size="sm" testId="change-password-modal"><ChangePasswordForm auth={app.auth} onDone={() => { modal.close(); app.onPasswordChanged(); }} onCancel={modal.close} /></ModalFrame>); }} />
                      <Button variant="secondary" size="sm" icon="logout" label="Sign out" block data-testid="sign-out" onClick={() => { setOpen(false); void app.signOut(); }} />
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </header>
        <main className="tc-content" id="main" tabIndex={-1}>
          {app.staleScripts.length ? (
            <div style={{ marginBottom: 16 }}>
              <Alert tone="warning" title="The database scripts are out of date">
                <span data-testid="stale-scripts">Re-run {app.staleScripts.join(', ')} (in that order) on the Travel Claim database. Some screens may fail or behave differently until you do.</span>
              </Alert>
            </div>
          ) : null}
          {children}
        </main>
      </div>
    </div>
  );
}
