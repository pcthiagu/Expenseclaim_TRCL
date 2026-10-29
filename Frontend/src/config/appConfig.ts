/** Application configuration from environment variables (never secrets: everything VITE_* is public in the bundle). */
export interface AppConfig { apiBaseUrl: string; apiTimeoutMs: number }

export function readAppConfig(env: { VITE_API_BASE_URL?: string; VITE_API_TIMEOUT_MS?: string }): AppConfig {
  const base = (env.VITE_API_BASE_URL ?? 'http://localhost:4000').trim().replace(/\/+$/, '');
  const t = Number(env.VITE_API_TIMEOUT_MS);
  return { apiBaseUrl: base, apiTimeoutMs: Number.isFinite(t) && t > 0 ? t : 20000 };
}
