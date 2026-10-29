/**
 * In-memory auth state: the short-lived access token and the signed-in user. The refresh token lives ONLY in the httpOnly
 * cookie set by the backend (never readable from JavaScript). Nothing here is written to localStorage/sessionStorage.
 */
export interface AuthUser { employeeId?: string | number; [k: string]: unknown }
export interface AuthStore {
  getAccessToken(): string | null;
  getCurrentUser(): AuthUser | null;
  setAuthState(accessToken: string, user: AuthUser | null): void;
  clearAuthState(): void;
  /** Notified on every change (the app shows the login page when the state is cleared). Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void;
}

export function createAuthStore(): AuthStore {
  let token: string | null = null;
  let user: AuthUser | null = null;
  const subs = new Set<() => void>();
  const emit = (): void => { subs.forEach((f) => f()); };
  return {
    getAccessToken: () => token,
    getCurrentUser: () => user,
    setAuthState: (t, u) => { token = t; user = u; emit(); },
    clearAuthState: () => { token = null; user = null; emit(); },
    subscribe: (fn) => { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
export const authStore: AuthStore = createAuthStore();
