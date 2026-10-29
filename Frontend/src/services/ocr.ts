import { isComplete, parseReceiptText, type ReceiptSuggestion } from '../domain/receiptOcr';

/**
 * OCR engines. All return PLAIN TEXT; src/domain/receiptOcr.ts turns text into suggested fields.
 *
 *  - 'browser' (default): Tesseract.js (+ PDF.js for PDFs) in the user's browser. Bills never leave the machine; no
 *    backend needed. Heavy assets are loaded lazily on first use. For an intranet, self-host them and set
 *    VITE_OCR_ASSETS_BASE (worker/core/language data) instead of relying on a public CDN.
 *  - 'remote': POST the file (multipart field `file`) to VITE_OCR_ENDPOINT, expect `{ "text": "..." }`
 *    (or `{ "success": true, "data": { "text": "..." } }`). Use this to run OCR on your own server.
 *  - 'off': no OCR; uploads work as before.
 *
 * STATUS: the text->fields parser is tested against real Tesseract output; the remote engine is tested against a real
 * HTTP server. The 'browser' engine could NOT be run in the authoring sandbox (packages not installable there): verify
 * it on a real build before relying on it.
 */
export interface OcrEngine {
  readonly name: string;
  recognize(file: File, onProgress?: (fraction: number) => void): Promise<string>;
}

export class OcrError extends Error {
  constructor(message: string, readonly code: 'unsupported' | 'timeout' | 'failed') { super(message); this.name = 'OcrError'; }
}

const OCR_TIMEOUT_MS = 90_000;
export const OCR_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

function withTimeout<T>(p: Promise<T>, ms = OCR_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new OcrError('Reading the bill took too long.', 'timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new OcrError('Could not read the bill.', 'failed')); });
  });
}

/* ------------------------------------- remote ------------------------------------- */
export class RemoteOcrEngine implements OcrEngine {
  readonly name = 'remote';
  constructor(private readonly endpoint: string, private readonly opts: { getAuthHeaders?: () => Record<string, string>; fetchImpl?: typeof fetch; credentials?: RequestCredentials } = {}) {
    if (!endpoint) throw new Error('RemoteOcrEngine: endpoint is required (VITE_OCR_ENDPOINT).');
  }
  async recognize(file: File, onProgress?: (fraction: number) => void): Promise<string> {
    if (!(OCR_TYPES as readonly string[]).includes(file.type)) throw new OcrError('Only PDF, JPG or PNG bills can be read.', 'unsupported');
    onProgress?.(0.1);
    const form = new FormData();
    form.append('file', file, file.name);
    const init: RequestInit = { method: 'POST', body: form, headers: { Accept: 'application/json', ...(this.opts.getAuthHeaders?.() ?? {}) } };
    if (this.opts.credentials) init.credentials = this.opts.credentials;
    const res = await withTimeout((this.opts.fetchImpl ?? fetch)(this.endpoint, init));
    if (!res.ok) throw new OcrError(`The OCR service returned ${res.status}.`, 'failed');
    const body = (await res.json().catch(() => null)) as { text?: unknown; data?: { text?: unknown } } | null;
    const text = typeof body?.text === 'string' ? body.text : typeof body?.data?.text === 'string' ? body.data.text : null;
    if (text === null) throw new OcrError('The OCR service sent an unexpected response.', 'failed');
    onProgress?.(1);
    return text;
  }
}

/* ------------------------------------- browser ------------------------------------- */
interface TessWorker { recognize(image: unknown): Promise<{ data: { text: string } }>; terminate(): Promise<unknown> }
interface TessModule { createWorker(lang: string, oem?: number, opts?: Record<string, unknown>): Promise<TessWorker> }
interface PdfPage { getTextContent(): Promise<{ items: Array<{ str?: string }> }>; getViewport(o: { scale: number }): { width: number; height: number }; render(o: Record<string, unknown>): { promise: Promise<void> } }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage>; destroy(): Promise<void> }
interface PdfModule { getDocument(o: { data: Uint8Array }): { promise: Promise<PdfDoc> }; GlobalWorkerOptions: { workerSrc: string } }

/** Upscale (so the shorter side is at least ~1400 px, at most 3x, longest side capped), convert to grayscale and stretch contrast. */
async function prepareForOcr(file: File): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(3, Math.max(1, 1400 / Math.min(bmp.width, bmp.height)), 3600 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new OcrError('Canvas is not available.', 'failed');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] as number) * 0.299 + (d[i + 1] as number) * 0.587 + (d[i + 2] as number) * 0.114; d[i] = d[i + 1] = d[i + 2] = g; if (g < lo) lo = g; if (g > hi) hi = g; }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) { const v = (((d[i] as number) - lo) * 255) / range; d[i] = d[i + 1] = d[i + 2] = v; }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const MAX_PDF_PAGES = 3;
const MIN_TEXT_LAYER_CHARS = 40;

export class BrowserOcrEngine implements OcrEngine {
  readonly name = 'browser';
  private worker: Promise<TessWorker> | null = null;
  constructor(private readonly assetsBase?: string) {}

  private getWorker(): Promise<TessWorker> {
    if (!this.worker) {
      this.worker = (async () => {
        // Depending on the bundler/interop, createWorker is on the module or on its default export.
        const T = (await import('tesseract.js')) as unknown as Partial<TessModule> & { default?: TessModule };
        const mod = (T.createWorker ? T : T.default) as TessModule | undefined;
        if (!mod) throw new OcrError('The OCR library could not be loaded.', 'failed');
        const base = this.assetsBase?.replace(/\/+$/, '');
        const opts = base ? { workerPath: `${base}/worker.min.js`, corePath: base, langPath: base } : undefined;
        return mod.createWorker('eng', 1, opts);
      })();
      this.worker.catch(() => { this.worker = null; }); // allow a retry after a failed load
    }
    return this.worker;
  }

  async recognize(file: File, onProgress?: (fraction: number) => void): Promise<string> {
    if (!(OCR_TYPES as readonly string[]).includes(file.type)) throw new OcrError('Only PDF, JPG or PNG bills can be read.', 'unsupported');
    return withTimeout((async () => {
      onProgress?.(0.05);
      if (file.type === 'application/pdf') return this.readPdf(file, onProgress);
      const w = await this.getWorker();
      onProgress?.(0.3);
      const first = (await w.recognize(file)).data.text;
      onProgress?.(0.7);
      // Pass 2 only when pass 1 left something unread: an upscaled, grayscale, contrast-stretched copy often reads small or
      // low-contrast bills better (and sometimes worse, which is why it is a fallback, merged field by field by the parser).
      if (isComplete(parseReceiptText(first))) { onProgress?.(1); return first; }
      try {
        const prepared = await prepareForOcr(file);
        const second = (await w.recognize(prepared)).data.text;
        onProgress?.(1);
        return `${first}\f${second}`;
      } catch { onProgress?.(1); return first; } // preprocessing is best-effort
    })());
  }

  private async readPdf(file: File, onProgress?: (f: number) => void): Promise<string> {
    const pdfjs = (await import('pdfjs-dist')) as unknown as PdfModule;
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')) as unknown as { default: string };
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl.default;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    try {
      const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
      let layer = '';
      for (let n = 1; n <= pages; n++) layer += (await (await doc.getPage(n)).getTextContent()).items.map((i) => i.str ?? '').join(' ') + '\n';
      if (layer.replace(/\s/g, '').length >= MIN_TEXT_LAYER_CHARS) { onProgress?.(1); return layer; } // a real text layer needs no OCR
      const w = await this.getWorker();
      let out = '';
      for (let n = 1; n <= pages; n++) {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
        await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport: vp }).promise;
        out += (await w.recognize(canvas)).data.text + '\n';
        onProgress?.(0.3 + (0.7 * n) / pages);
      }
      return out;
    } finally { void doc.destroy(); }
  }

  async dispose(): Promise<void> { if (this.worker) { const w = await this.worker.catch(() => null); this.worker = null; await w?.terminate(); } }
}

/* ------------------------------------- factory ------------------------------------- */
export interface OcrEnv { VITE_OCR_MODE?: string; VITE_OCR_ENDPOINT?: string; VITE_OCR_ASSETS_BASE?: string; VITE_OCR_DEBUG?: string }

/** Returns null when OCR is off. Throws on misconfiguration (e.g. remote mode without an endpoint) instead of silently disabling. */
export function createOcrEngine(env: OcrEnv, hooks: { getAuthHeaders?: () => Record<string, string> } = {}): OcrEngine | null {
  const mode = env.VITE_OCR_MODE ?? 'browser';
  if (mode === 'off') return null;
  if (mode === 'browser') return new BrowserOcrEngine(env.VITE_OCR_ASSETS_BASE);
  if (mode === 'remote') return new RemoteOcrEngine(env.VITE_OCR_ENDPOINT ?? '', hooks.getAuthHeaders ? { getAuthHeaders: hooks.getAuthHeaders, credentials: 'include' } : { credentials: 'include' });
  throw new Error(`Unknown VITE_OCR_MODE "${mode}" (expected "browser", "remote" or "off").`);
}

/** Reads a bill and returns suggested fields; never throws (OCR is a convenience, not a requirement). */
export async function readBill(engine: OcrEngine | null, file: File, onProgress?: (f: number) => void, now: Date = new Date(), debug?: (fileName: string, text: string) => void): Promise<{ suggestion: ReceiptSuggestion | null; error: string | null }> {
  if (!engine) return { suggestion: null, error: null };
  try { const text = await engine.recognize(file, onProgress); debug?.(file.name, text); return { suggestion: parseReceiptText(text, now), error: null }; }
  catch (e) { return { suggestion: null, error: e instanceof OcrError ? e.message : 'Could not read this bill.' }; }
}
