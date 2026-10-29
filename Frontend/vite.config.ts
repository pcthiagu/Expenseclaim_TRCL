import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// API base URL is read at runtime from VITE_API_BASE_URL (see .env.example).
// In development, set VITE_DEV_PROXY_TARGET to the backend origin to avoid CORS.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: process.env.VITE_DEV_PROXY_TARGET
      ? { '/api': { target: process.env.VITE_DEV_PROXY_TARGET, changeOrigin: true } }
      : undefined,
  },
  build: { sourcemap: mode !== 'production' },
  test: { environment: 'jsdom', include: ['tests/**/*.test.{ts,tsx}'] },
}));
