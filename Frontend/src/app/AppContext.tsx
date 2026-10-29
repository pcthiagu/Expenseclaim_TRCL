import { createContext, useContext } from 'react';
import type { PolicyConfig } from '../config/policy';
import type { AuthApi } from '../services/authApi';
import type { TravelClaimGateway, SessionUser } from '../services/ports';
import type { Actor, Role } from '../types/domain';

export interface AppState {
  gateway: TravelClaimGateway;
  session: SessionUser;
  actor: Actor;
  policy: PolicyConfig;
  isAdmin: boolean;
  /** Install scripts of the database that are missing or older than this build expects (real backend only). */
  staleScripts: string[];
  /** Approvers only: switch between acting as an employee (apply claims, receipt box) and as an approver. */
  viewSwitch?: { mode: Role; set: (mode: Role) => void };
  /** Sign-in related actions for the account menu. */
  auth: AuthApi;
  signOut: () => Promise<void>;
  /** Called after the password was changed (the server ends every session). */
  onPasswordChanged: () => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const c = useContext(AppContext);
  if (!c) throw new Error('useApp must be used inside the app provider');
  return c;
}
