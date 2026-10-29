import type { AuthStore } from '../auth/authStore';
import { ApiError, type ApiErrorCode } from './apiClient';
import { toApiError } from './SpGateway';
import type { ExecSp } from './spContract';

/**
 * The shared stored-procedure transport, following the existing backend contract:
 *   POST {base}/api/execute   body { spName, params }   ->  { success, data, message }
 *   Authorization: Bearer <access token>;  cookies included (httpOnly refresh-token cookie)
 *   401 with code TOKEN_EXPIRED -> ONE silent refresh via POST {base}/api/auth/refresh (concurrent calls share it), then the
 *   original call is retried ONCE. If refresh fails the auth state is cleared (the app then shows the login page).
 *
 * The browser does NOT send an identity: the backend adds `ExecutedBy` (the employeeId from the verified token) to every call, and
 * procedures must use only that.
 *
 * Errors are normalised to ApiError. Messages that look like SQL Server / driver internals are never shown to the user.
 */
export interface ExecSpOptions {
  baseUrl: string;
  store: AuthStore;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const GENERIC: Record<ApiErrorCode, string> = {
  network: 'Could not reach the server. Check your connection and try again.', timeout: 'The server took too long to respond. Try again.', aborted: 'The request was cancelled.',
  unauthorized: 'Your session has expired. Please sign in again.', forbidden: 'You do not have permission to do that.', not_found: 'The requested record was not found.',
  validation: 'The server rejected the submitted data.', conflict: 'The record was changed by someone else. Reload and try again.',
  server: 'The server could not complete the request. Try again, or contact support if it continues.', client: 'The request could not be completed.', parse: 'The server sent a response this app could not read.',
};

/** True when a backend message looks like database/driver internals, a stack trace or a file path. */
export function looksLikeInternals(msg: string): boolean {
  return /(\bMsg \d+|Invalid object name|Invalid column name|Incorrect syntax|Conversion failed|Violation of (PRIMARY|UNIQUE|FOREIGN)|Cannot insert|Timeout expired|RequestError|ConnectionError|mssql|tedious|\bat \S+ \(|node_modules|[A-Za-z]:\\|\/(usr|var|home|app)\/|SELECT\s.+\sFROM|EXEC(UTE)?\s+\w+\.?\w*\s*@|stack)/i.test(msg);
}

function codeFor(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized'; if (status === 403) return 'forbidden'; if (status === 404) return 'not_found'; if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation'; return status >= 500 ? 'server' : 'client';
}

/** Builds the user-facing error. Business messages from the backend are kept; internals are replaced by a generic text. */
export function buildError(status: number | null, body: unknown, fallbackCode: ApiErrorCode = 'client'): ApiError {
  const b = (body && typeof body === 'object' ? body : {}) as { message?: unknown; code?: unknown };
  const raw = typeof b.message === 'string' ? b.message.trim() : '';
  const prefixed = raw ? toApiError(new Error(raw)) : null;           // honours an optional "[FORBIDDEN] ..." convention
  const code: ApiErrorCode = prefixed && prefixed.code !== 'server' ? prefixed.code : status ? codeFor(status) : fallbackCode;
  const safe = raw && !looksLikeInternals(raw) && raw.length <= 300;
  const msg = safe ? (prefixed && prefixed.code !== 'server' ? prefixed.message : raw) : GENERIC[code];
  return new ApiError(code, msg, status, safe ? msg : null, safe ? { summary: [msg] } : null);
}

export function createExecSp(o: ExecSpOptions): ExecSp {
  const f = o.fetchImpl ?? fetch;
  const base = o.baseUrl.replace(/\/+$/, '');
  const timeoutMs = o.timeoutMs ?? 20000;
  let refreshing: Promise<string> | null = null;

  async function timed(url: string, init: RequestInit): Promise<Response> {
    const c = new AbortController(); let timedOut = false;
    const t = setTimeout(() => { timedOut = true; c.abort(); }, timeoutMs);
    try { return await f(url, { ...init, signal: c.signal, credentials: 'include' }); }
    catch (e) { throw new ApiError(timedOut ? 'timeout' : (e as { name?: string }).name === 'AbortError' ? 'aborted' : 'network', GENERIC[timedOut ? 'timeout' : 'network'], null, null, null); }
    finally { clearTimeout(t); }
  }

  /** One refresh at a time; every caller that hit TOKEN_EXPIRED waits for the same result. */
  function silentRefresh(): Promise<string> {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const res = await timed(`${base}/api/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' });
          const data = (await res.json().catch(() => null)) as { success?: boolean; message?: string; data?: { accessToken?: string; user?: Record<string, unknown> } } | null;
          if (!res.ok || !data?.success || !data.data?.accessToken) throw buildError(res.status, data, 'unauthorized');
          o.store.setAuthState(data.data.accessToken, (data.data.user ?? null) as never);
          return data.data.accessToken;
        } catch (e) { o.store.clearAuthState(); throw e instanceof ApiError ? e : new ApiError('unauthorized', GENERIC.unauthorized, 401, null, null); }
        finally { refreshing = null; }
      })();
    }
    return refreshing;
  }

  /** Authenticated request with the single refresh-and-retry. Used by execSp and by the protected file routes. */
  async function authed(url: string, init: RequestInit, retried = false): Promise<Response> {
    const token = o.store.getAccessToken();
    const headers = { ...(init.headers as Record<string, string> | undefined), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
    const res = await timed(url, { ...init, headers });
    if (res.status === 401 && !retried) {
      const body = (await res.clone().json().catch(() => null)) as { code?: unknown } | null;
      if (body?.code === 'TOKEN_EXPIRED') { await silentRefresh(); return authed(url, init, true); }
    }
    return res;
  }

  const execSp: ExecSp & { authed?: typeof authed; refresh?: () => Promise<{ accessToken: string }> } = async (spName, params = {}) => {
    const payload = {moduleName: "TA", spName, params };
    const res = await authed(`${base}/api/execute`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload) });
    const text = await res.text().catch(() => '');
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    const b = body as { success?: boolean; data?: unknown } | null;
    if (!res.ok) throw buildError(res.status, body);
    if (!b || typeof b !== 'object') throw new ApiError('parse', GENERIC.parse, res.status, null, null);
    if (!b.success) throw buildError(res.status, body, 'client');
    return b.data;
  };
  execSp.authed = authed;
  /** Restores a session from the httpOnly refresh cookie (used at start-up). Rejects with 'unauthorized' when there is none. */
  execSp.refresh = async () => ({ accessToken: await silentRefresh() });
  return execSp;
}

/** Exposes the authenticated fetch (with refresh-and-retry) of an execSp created by createExecSp, for the file routes. */
export function authedFetchOf(execSp: ExecSp): (url: string, init?: RequestInit) => Promise<Response> {
  const a = (execSp as ExecSp & { authed?: (url: string, init: RequestInit) => Promise<Response> }).authed;
  if (!a) throw new Error('authedFetchOf needs an execSp created by createExecSp.');
  return (url, init = {}) => a(url, init);
}

/** Restores a session from the refresh cookie; resolves false (never throws) when there is no valid session. */
export async function restoreSessionOf(execSp: ExecSp): Promise<boolean> {
  const r = (execSp as ExecSp & { refresh?: () => Promise<unknown> }).refresh;
  if (!r) throw new Error('restoreSessionOf needs an execSp created by createExecSp.');
  try { await r(); return true; } catch { return false; }
}
