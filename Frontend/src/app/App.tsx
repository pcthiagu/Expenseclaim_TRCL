import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_POLICY } from '../config/policy';
import { createGateway } from '../services';
import type { TravelClaimGateway, SessionUser } from '../services//ports';
import { ApiError } from '../services/apiClient';
import { KINDS } from '../domain/expenseSchema';
import type { Role } from '../types/domain';
import { setReferenceData } from '../domain//expenseSchema';
import { staleScripts } from '../config/schemaRev';
import type { PolicyConfig } from '../config/policy';
import { ForgotPasswordPage, LoginPage, MustChangePasswordPage, ResetPasswordPage } from '../pages/auth/AuthPages';
import { ToastProvider } from '../components/common/Toast';
import { ModalHost } from '../components/modals/ModalHost';
import { AppShell } from '../components/layout/AppShell';
import { Alert } from '../components/common/ui';
import { ClaimsListPage } from '../pages/expense-claims/ClaimsListPage';
import { ClaimFormPage } from '../pages/expense-claims/ClaimFormPage';
import { DashboardPage } from '../pages/dashboard/DashboardPage';
import { ReceiptBoxPage } from '../pages/receipt-box/ReceiptBoxPage';
import { TravelListPage } from '../pages/travel-requests/TravelListPage';
import { AdvanceListPage } from '../pages/advance-requests/AdvanceListPage';
import { AdvanceFormPage } from '../pages/advance-requests/AdvanceFormPage';
import { ApprovalsPage } from '../pages/approvals/ApprovalsPage';
import { TravelFormPage } from '../pages/travel-requests/TravelFormPage';
import { AppContext, useApp, type AppState } from './AppContext';
import { OcrProvider, createOcrEngine } from './OcrContext';
import type { OcrEngine } from '../services//ocr';
import { getApiDeps } from './apiDeps';
import { navigate, useRoute } from './router';

type Boot =
  | { state: 'loading' } | { state: 'error'; message: string }
  | { state: 'login'; notice?: string } | { state: 'forgot' } | { state: 'reset'; token: string } | { state: 'mustChange' }
  | { state: 'ready'; gateway: TravelClaimGateway; session: SessionUser; ocr: OcrEngine | null; view: Role; policy: PolicyConfig };

const VIEW_KEY = 'tc.view';
/** An approver starts in the view they last used (default: approver); everyone else is an employee. */
function initialView(session: SessionUser): Role {
  if (session.role !== 'admin') return 'employee';
  try { return sessionStorage.getItem(VIEW_KEY) === 'employee' ? 'employee' : 'admin'; } catch { return 'admin'; }
}

const errText = (e: unknown, fallback: string): string => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : fallback);

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: 'loading' });
  const deps = useMemo(() => getApiDeps(), []);
  const signingOut = useRef(false);
  const openOnStart = useRef<string | null>(null);

  /** Builds the gateway and loads the signed-in user's session from the backend. */
  const start = useCallback(async (): Promise<void> => {
    try {
      const gateway = createGateway(deps);
      const session = await gateway.getSession();
      const ocr = createOcrEngine(import.meta.env); // throws on misconfiguration -> shown as a start-up error
      if (deps.store.getCurrentUser()?.mustChangePassword) { setBoot({ state: 'mustChange' }); return; }
      // Everyone can act as an employee; a person who is also an approver may switch (their last choice is remembered for this browser tab).
      // Everything the screens know about expense types, items, fields and option lists comes from the database; the app cannot run without it.
      setReferenceData(await gateway.getReferenceData());
      // Policy (rates, limits, self-approval); if it cannot be read, the documented fallback values stay in force.
      const snap = await gateway.getPolicy().catch(() => null);
      const policy: PolicyConfig = snap?.policy ?? DEFAULT_POLICY;
      const view = initialView(session);
      gateway.setViewMode?.(session.role === 'admin' ? view : 'admin');   // only an approver has a view to narrow; a plain employee sends no hint
      const tx = openOnStart.current; openOnStart.current = null;
      if (tx) { // magic link: open the request it points to
        const hit = (await gateway.listRecords({ search: tx }).catch(() => ({ rows: [] }))).rows.find((r) => r.requestNumber === tx);
        if (hit) navigate(`#/${KINDS[hit.kind].route}/${encodeURIComponent(hit.id)}`, { replace: true });
      }
      setBoot({ state: 'ready', gateway, session, ocr, view, policy });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'unauthorized') setBoot({ state: 'login', notice: 'Please sign in to continue.' });
      else setBoot({ state: 'error', message: errText(e, 'Could not start the app.') });
    }
  }, [deps]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      {
        const q = new URLSearchParams(location.search);
        if (location.pathname.endsWith('/reset-password') && q.get('token')) { setBoot({ state: 'reset', token: q.get('token') as string }); return; }
        const guid = q.get('guid');
        if (guid) {
          try {
            const r = await deps.auth.magicLogin(guid);
            history.replaceState(null, '', location.pathname + location.hash); // the one-time link must not stay in the address bar
            openOnStart.current = r.transactionNo ?? null;
            if (!cancelled) await start();
          } catch (e) { if (!cancelled) setBoot({ state: 'login', notice: errText(e, 'This login link is invalid, used, or expired.') }); }
          return;
        }
        if (!(await deps.restore())) { if (!cancelled) setBoot({ state: 'login' }); return; } // no valid refresh cookie
      }
      if (!cancelled) await start();
    })();
    return () => { cancelled = true; };
  }, [deps, start]);

  // If the session ends while the app is open (refresh failed / token revoked), go back to sign-in.
  useEffect(() => deps.store.subscribe(() => {
    if (!deps.store.getAccessToken() && !signingOut.current) setBoot((b) => (b.state === 'ready' || b.state === 'mustChange' ? { state: 'login', notice: 'Your session has ended. Please sign in again.' } : b));
  }), [deps]);

  const signOut = useCallback(async (): Promise<void> => {
    signingOut.current = true;
    try { await deps.auth.logout(); } finally { signingOut.current = false; }
    navigate('#/dashboard', { replace: true });
    setBoot({ state: 'login', notice: 'You have been signed out.' });
  }, [deps]);
  const passwordChanged = useCallback((): void => { navigate('#/dashboard', { replace: true }); setBoot({ state: 'login', notice: 'Password changed. Please sign in again.' }); }, []);

  const switchView = useCallback((mode: Role): void => {
    if (boot.state !== 'ready' || mode === boot.view) return;
    boot.gateway.setViewMode?.(mode);
    try { sessionStorage.setItem(VIEW_KEY, mode); } catch { /* a preference only */ }
    navigate('#/dashboard', { replace: true });
    setBoot({ ...boot, view: mode });
  }, [boot]);

  if (boot.state === 'loading') return <div className="tc-content" aria-busy="true">Loading…</div>;
  if (boot.state === 'error') return <div className="tc-content"><Alert tone="error" title="The app could not start">{boot.message}</Alert></div>;
  const auth = deps.auth;
  if (boot.state === 'login') return <LoginPage auth={auth} {...(boot.notice ? { notice: boot.notice } : {})} onSignedIn={() => { setBoot({ state: 'loading' }); void start(); }} onForgot={() => setBoot({ state: 'forgot' })} />;
  if (boot.state === 'forgot') return <ForgotPasswordPage auth={auth} onBack={() => setBoot({ state: 'login' })} />;
  if (boot.state === 'reset') return <ResetPasswordPage auth={auth} token={boot.token} onDone={() => { history.replaceState(null, '', location.pathname.replace(/\/reset-password\/?$/, '/') + location.hash); setBoot({ state: 'login' }); }} />;
  if (boot.state === 'mustChange') return <MustChangePasswordPage auth={auth} onDone={passwordChanged} />;
  if (boot.state !== 'ready') return null;
  const { gateway, ocr } = boot;
  const session: SessionUser = { ...boot.session, role: boot.view };   // the role the screens use is the VIEW the person chose
  const canSwitchView = boot.session.role === 'admin';
  const app: AppState = {
    gateway, session, isAdmin: session.role === 'admin', policy: boot.policy,
    staleScripts: staleScripts(boot.session.schema),
    actor: { role: session.role, code: session.code, name: session.name },
    auth, signOut, onPasswordChanged: passwordChanged,
    ...(canSwitchView ? { viewSwitch: { mode: boot.view, set: switchView } } : {}),
  };
  return (
    <AppContext.Provider value={app}>
      <OcrProvider engine={ocr} debug={import.meta.env.VITE_OCR_DEBUG === 'true'}>
        <ToastProvider>
          <ModalHost>
            <AppShell><Routes /></AppShell>
          </ModalHost>
        </ToastProvider>
      </OcrProvider>
    </AppContext.Provider>
  );
}

function Routes() {
  const route = useRoute();
  const { isAdmin } = useApp();
  const denied = !!route && ((route.def.admin && !isAdmin) || (route.def.employee && isAdmin));
  useEffect(() => {
    if (!route || denied) navigate('#/dashboard', { replace: true });
    else document.title = route.def.title + ' · Travel Claim';
  }, [route, denied]);
  if (!route || denied) return null;
  switch (route.def.name) {
    case 'claims': return <ClaimsListPage />;
    case 'claimForm': return <ClaimFormPage key={route.params.id ?? 'new'} id={route.params.id ?? null} />;
    case 'dashboard': return <DashboardPage />;
    case 'travelList': return <TravelListPage />;
    case 'travelForm': return <TravelFormPage key={route.params.id ?? 'new'} id={route.params.id ?? null} />;
    case 'advanceList': return <AdvanceListPage />;
    case 'advanceForm': return <AdvanceFormPage key={route.params.id ?? 'new'} id={route.params.id ?? null} />;
    case 'approvals': return <ApprovalsPage />;
    case 'receipts': return <ReceiptBoxPage />;
    default: return null;
  }
}
