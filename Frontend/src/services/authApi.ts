import type { AuthStore, AuthUser } from '../auth/authStore';
import { ApiError } from '../services/apiClient';
import { buildError } from '../services/execSp';

/**
 * Client for the existing /api/auth routes (contract read from the backend source):
 *   POST /login {employeeId,password} -> {success,data:{accessToken,user:{employeeId,name,role,mustChangePassword}}} (+ httpOnly refresh cookie)
 *   POST /refresh (cookie) -> {accessToken,user}      POST /logout      GET /me      POST /change-password {currentPassword,newPassword}
 *   POST /forgot-password {employeeId}                POST /reset-password {token,newPassword}      GET /magic-login?guid=
 * The access token lives only in the AuthStore (memory); the refresh token only in the httpOnly cookie.
 */
export interface AuthApi {
  login(employeeId: string, password: string): Promise<AuthUser>;
  logout(): Promise<void>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  forgotPassword(employeeId: string): Promise<string>;
  resetPassword(token: string, newPassword: string): Promise<string>;
  magicLogin(guid: string): Promise<{ user: AuthUser; transactionNo?: string }>;
}

export interface AuthApiOptions {
  baseUrl: string;
  store: AuthStore;
  /** Token-bearing fetch with the single refresh-and-retry (from createExecSp). */
  authedFetch: (url: string, init?: RequestInit) => Promise<Response>;
  fetchImpl?: typeof fetch;
}

type Envelope<T> = { success?: boolean; message?: string; data?: T } | null;

export function createAuthApi(o: AuthApiOptions): AuthApi {
  const f = o.fetchImpl ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' };

  async function call<T>(path: string, init: RequestInit, authed = false): Promise<NonNullable<Envelope<T>>> {
    let res: Response;
    try { res = await (authed ? o.authedFetch(base + path, init) : f(base + path, { ...init, credentials: 'include' })); }
    catch (e) { throw e instanceof ApiError ? e : new ApiError('network', 'Could not reach the server. Check your connection and try again.', null, null, null); }
    const body = (await res.json().catch(() => null)) as Envelope<T>;
    if (!res.ok || !body?.success) throw buildError(res.status, body, 'client');
    return body;
  }

  return {
    async login(employeeId, password) {
      const b = await call<{ accessToken: string; user: AuthUser }>('/api/auth/login', { method: 'POST', headers: json, body: JSON.stringify({ employeeId, password }) });
      if (!b.data?.accessToken) throw new ApiError('parse', 'The server sent a response this app could not read.', null, null, null);
      o.store.setAuthState(b.data.accessToken, b.data.user ?? null);
      return b.data.user;
    },
    async logout() {
      try { await call('/api/auth/logout', { method: 'POST', headers: json, body: '{}' }); }
      finally { o.store.clearAuthState(); } // signed out locally even if the server could not be reached
    },
    async changePassword(currentPassword, newPassword) {
      await call('/api/auth/change-password', { method: 'POST', headers: json, body: JSON.stringify({ currentPassword, newPassword }) }, true);
      o.store.clearAuthState(); // the server revokes every refresh token: sign in again
    },
    async forgotPassword(employeeId) { return (await call('/api/auth/forgot-password', { method: 'POST', headers: json, body: JSON.stringify({ employeeId }) })).message ?? ''; },
    async resetPassword(token, newPassword) { return (await call('/api/auth/reset-password', { method: 'POST', headers: json, body: JSON.stringify({ token, newPassword }) })).message ?? ''; },
    async magicLogin(guid) {
      const b = await call<{ accessToken: string; user: AuthUser; transactionNo?: string }>(`/api/auth/magic-login?guid=${encodeURIComponent(guid)}`, { method: 'GET', headers: { Accept: 'application/json' } });
      if (!b.data?.accessToken) throw new ApiError('parse', 'The server sent a response this app could not read.', null, null, null);
      o.store.setAuthState(b.data.accessToken, b.data.user ?? null);
      return { user: b.data.user, ...(b.data.transactionNo ? { transactionNo: b.data.transactionNo } : {}) };
    },
  };
}
