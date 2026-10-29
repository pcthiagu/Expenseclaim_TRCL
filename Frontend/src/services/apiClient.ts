/**
 * Centralised HTTP client.
 *
 * This is deliberately CONTRACT-AGNOSTIC: no endpoint paths, payload shapes or auth scheme are
 * assumed, because none were provided with the project (see docs/02-api-gaps.md). Per-resource
 * services (expenseService, travelService, ...) must be written against the real backend contract
 * and call this client.
 *
 * Responsibilities: base URL from env, injectable auth, timeout, network-error handling, normalised
 * errors that keep the backend's own message, 401/403 hooks, JSON + multipart bodies, and a guard
 * against duplicate in-flight submissions. It NEVER logs request bodies, headers, tokens or
 * responses.
 */

export type ApiErrorCode =
  | 'network' | 'timeout' | 'aborted' | 'unauthorized' | 'forbidden' | 'not_found'
  | 'validation' | 'conflict' | 'server' | 'client' | 'parse';

export class ApiError extends Error {
  readonly status: number | null;
  readonly code: ApiErrorCode;
  /** The backend's own message when it sent one (never replaced by a generic text). */
  readonly backendMessage: string | null;
  /** The parsed error body, for field-level validation messages. */
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, status: number | null, backendMessage: string | null, details: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.backendMessage = backendMessage;
    this.details = details;
  }
}

export interface ApiClientOptions {
  /** e.g. import.meta.env.VITE_API_BASE_URL. No trailing slash required. */
  baseUrl: string;
  timeoutMs?: number;
  /** Supplies auth headers per request (token, CSRF, ...). The scheme is the backend's, not assumed here. */
  getAuthHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** 'include' for cookie sessions. Leave undefined for token-in-header auth. */
  credentials?: RequestCredentials;
  /** Called once per 401 response (e.g. redirect to sign-in). */
  onUnauthorized?: (err: ApiError) => void;
  /** Called once per 403 response (e.g. show "no permission"). */
  onForbidden?: (err: ApiError) => void;
  fetchImpl?: typeof fetch;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | null | undefined>;
  /** JSON body (serialised) or FormData (sent as multipart; the browser sets the boundary). */
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30000;

function joinUrl(base: string, path: string, query?: RequestOptions['query']): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  let url = b + p;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) qs.append(k, String(v));
    const s = qs.toString();
    if (s) url += (url.includes('?') ? '&' : '?') + s;
  }
  return url;
}

/** Best-effort extraction of a human message from an error body; the raw body is kept in `details`. */
function messageFrom(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() || null;
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const k of ['message', 'error', 'title', 'detail']) {
      const v = o[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return null;
}

function codeForStatus(status: number): ApiErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'validation';
  if (status >= 500) return 'server';
  return 'client';
}

const FALLBACK_TEXT: Record<ApiErrorCode, string> = {
  network: 'Could not reach the server. Check your connection and try again.',
  timeout: 'The server took too long to respond. Try again.',
  aborted: 'The request was cancelled.',
  unauthorized: 'Your session has expired. Sign in again.',
  forbidden: 'You do not have permission to do that.',
  not_found: 'The requested record was not found.',
  validation: 'The server rejected the submitted data.',
  conflict: 'The record was changed by someone else. Reload and try again.',
  server: 'The server hit an error. Try again later.',
  client: 'The request could not be completed.',
  parse: 'The server sent a response this app could not read.',
};

export class ApiClient {
  private readonly opts: ApiClientOptions;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(opts: ApiClientOptions) {
    if (!opts.baseUrl) throw new Error('ApiClient: baseUrl is required (set VITE_API_BASE_URL).');
    this.opts = opts;
  }

  async request<T>(method: string, path: string, ro: RequestOptions = {}): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeoutMs = ro.timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const onCallerAbort = (): void => controller.abort();
    if (ro.signal) {
      if (ro.signal.aborted) controller.abort(); else ro.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    try {
      const auth = this.opts.getAuthHeaders ? await this.opts.getAuthHeaders() : {};
      const headers: Record<string, string> = { Accept: 'application/json', ...auth, ...(ro.headers ?? {}) };
      let body: BodyInit | undefined;
      if (ro.body instanceof FormData) {
        body = ro.body; // multipart: never set Content-Type manually
      } else if (ro.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(ro.body);
      }
      const init: RequestInit = { method, headers, signal: controller.signal };
      if (body !== undefined) init.body = body;
      if (this.opts.credentials) init.credentials = this.opts.credentials;

      let res: Response;
      try {
        res = await f(joinUrl(this.opts.baseUrl, path, ro.query), init);
      } catch (e) {
        if (timedOut) throw new ApiError('timeout', FALLBACK_TEXT.timeout, null, null, null);
        if ((e as { name?: string }).name === 'AbortError') throw new ApiError('aborted', FALLBACK_TEXT.aborted, null, null, null);
        throw new ApiError('network', FALLBACK_TEXT.network, null, null, null);
      }

      const text = await res.text().catch(() => '');
      let parsed: unknown = null;
      let parseFailed = false;
      if (text) {
        try { parsed = JSON.parse(text); } catch { parsed = text; parseFailed = true; }
      }

      if (!res.ok) {
        const code = codeForStatus(res.status);
        const backendMessage = messageFrom(parsed);
        const err = new ApiError(code, backendMessage ?? FALLBACK_TEXT[code], res.status, backendMessage, parsed);
        if (code === 'unauthorized') this.opts.onUnauthorized?.(err);
        if (code === 'forbidden') this.opts.onForbidden?.(err);
        throw err;
      }
      if (parseFailed && text) throw new ApiError('parse', FALLBACK_TEXT.parse, res.status, null, null);
      return parsed as T;
    } finally {
      clearTimeout(timer);
      ro.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  get<T>(path: string, ro?: RequestOptions): Promise<T> { return this.request<T>('GET', path, ro); }
  post<T>(path: string, body?: unknown, ro?: RequestOptions): Promise<T> { return this.request<T>('POST', path, { ...ro, body }); }
  put<T>(path: string, body?: unknown, ro?: RequestOptions): Promise<T> { return this.request<T>('PUT', path, { ...ro, body }); }
  patch<T>(path: string, body?: unknown, ro?: RequestOptions): Promise<T> { return this.request<T>('PATCH', path, { ...ro, body }); }
  delete<T>(path: string, ro?: RequestOptions): Promise<T> { return this.request<T>('DELETE', path, ro); }
  /** Multipart upload. Client-side checks (type/size) are a convenience; the server must enforce them. */
  upload<T>(path: string, form: FormData, ro?: RequestOptions): Promise<T> { return this.request<T>('POST', path, { ...ro, body: form }); }

  /**
   * Duplicate-submission guard: while a call with the same key is in flight, further calls with that
   * key share its promise instead of sending a second request (e.g. a double-clicked Submit).
   */
  runOnce<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, p);
    return p;
  }
}

/** Reads configuration from Vite env. Fails loudly when the base URL is missing instead of guessing. */
export function createApiClientFromEnv(
  env: { VITE_API_BASE_URL?: string; VITE_API_TIMEOUT_MS?: string },
  hooks: Pick<ApiClientOptions, 'getAuthHeaders' | 'credentials' | 'onUnauthorized' | 'onForbidden'> = {},
): ApiClient {
  const baseUrl = env.VITE_API_BASE_URL ?? '';
  const timeout = Number(env.VITE_API_TIMEOUT_MS);
  const opts: ApiClientOptions = { baseUrl, ...hooks };
  if (Number.isFinite(timeout) && timeout > 0) opts.timeoutMs = timeout;
  return new ApiClient(opts);
}

/** Client-side attachment pre-check (mirrors the prototype's readFiles). The backend must re-check. */
export function checkAttachment(
  file: { name: string; size: number; type: string },
  policy: { attachmentMaxBytes: number; attachmentTypes: readonly string[] },
): string | null {
  if (!policy.attachmentTypes.includes(file.type)) return `${file.name}: only PDF, JPG or PNG files are accepted.`;
  if (file.size > policy.attachmentMaxBytes) return `${file.name}: larger than 5 MB.`;
  return null;
}
