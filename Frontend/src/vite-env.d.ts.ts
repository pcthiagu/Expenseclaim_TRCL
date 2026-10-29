/// <reference types="vite/client" />
// Typing of the Vite env variables this app reads (merges with vite/client).
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_API_TIMEOUT_MS?: string;
  readonly VITE_OCR_MODE?: string;
  readonly VITE_OCR_ENDPOINT?: string;
  readonly VITE_OCR_ASSETS_BASE?: string;
  readonly VITE_OCR_DEBUG?: string;
  readonly VITE_ATTACHMENT_VIEW_PATH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
