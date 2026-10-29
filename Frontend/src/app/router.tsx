import { useCallback, useEffect, useState } from 'react';

/**
 * Small hash router with the prototype's route table (#/claims, #/claims/new, #/claims/:id, ...).
 * NOTE: the brief asks for React Router. It could not be installed in the authoring sandbox, so routing is
 * isolated here behind useRoute()/navigate(); swapping to react-router-dom's HashRouter only touches this file
 * and App.tsx.
 */
export type RouteName =
  | 'dashboard' | 'claims' | 'claimForm' | 'travelList' | 'travelForm' | 'advanceList' | 'advanceForm' | 'approvals' | 'receipts';

export interface RouteDef {
  re: RegExp; name: RouteName; title: string; nav: 'dashboard' | 'claims' | 'travel' | 'advance' | 'approvals';
  parent?: string; admin?: boolean; employee?: boolean; params?: (m: RegExpMatchArray) => Record<string, string>;
}

export const ROUTES: readonly RouteDef[] = [
  { re: /^#\/dashboard$/, name: 'dashboard', title: 'Dashboard', nav: 'dashboard' },
  { re: /^#\/claims$/, name: 'claims', title: 'Expense Claims', nav: 'claims' },
  { re: /^#\/claims\/new$/, name: 'claimForm', title: 'New Expense Claim', nav: 'claims', parent: '#/claims', params: () => ({}) },
  { re: /^#\/claims\/([^/]+)$/, name: 'claimForm', title: 'Expense Claim', nav: 'claims', parent: '#/claims', params: (m) => ({ id: decodeURIComponent(m[1] ?? '') }) },
  { re: /^#\/travel$/, name: 'travelList', title: 'Travel Requests', nav: 'travel' },
  { re: /^#\/travel\/new$/, name: 'travelForm', title: 'New Travel Request', nav: 'travel', parent: '#/travel', params: () => ({}) },
  { re: /^#\/travel\/([^/]+)$/, name: 'travelForm', title: 'Travel Request', nav: 'travel', parent: '#/travel', params: (m) => ({ id: decodeURIComponent(m[1] ?? '') }) },
  { re: /^#\/advance$/, name: 'advanceList', title: 'Advance Requests', nav: 'advance' },
  { re: /^#\/advance\/new$/, name: 'advanceForm', title: 'New Advance Request', nav: 'advance', parent: '#/advance', params: () => ({}) },
  { re: /^#\/advance\/([^/]+)$/, name: 'advanceForm', title: 'Advance Request', nav: 'advance', parent: '#/advance', params: (m) => ({ id: decodeURIComponent(m[1] ?? '') }) },
  { re: /^#\/approvals$/, name: 'approvals', title: 'Approvals', nav: 'approvals', admin: true },
  { re: /^#\/receipts$/, name: 'receipts', title: 'Receipt box', nav: 'dashboard', employee: true },
];

export interface ResolvedRoute { def: RouteDef; params: Record<string, string>; hash: string }

export function resolve(hash: string): ResolvedRoute | null {
  const h = hash || '#/dashboard';
  for (const def of ROUTES) {
    const m = h.match(def.re);
    if (m) return { def, params: def.params ? def.params(m) : {}, hash: h };
  }
  return null;
}

export function navigate(hash: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) { history.replaceState(null, '', hash); window.dispatchEvent(new HashChangeEvent('hashchange')); return; }
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

export function useRoute(): ResolvedRoute | null {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const on = (): void => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return resolve(hash);
}

export function useNavigate(): typeof navigate {
  return useCallback(navigate, []);
}
