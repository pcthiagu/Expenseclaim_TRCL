import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ReceiptSuggestion } from '../domain/receiptOcr';
import { createOcrEngine, readBill, type OcrEngine } from '../services/ocr';

export interface BillReader {
  /** False when OCR is switched off (VITE_OCR_MODE=off). */
  enabled: boolean;
  read(file: File, onProgress?: (f: number) => void): Promise<{ suggestion: ReceiptSuggestion | null; error: string | null }>;
}
const Ctx = createContext<BillReader>({ enabled: false, read: async () => ({ suggestion: null, error: null }) });

export function OcrProvider({ engine, debug, children }: { engine: OcrEngine | null; /** VITE_OCR_DEBUG=true: log the raw OCR text to the console (development only; bills are confidential). */ debug?: boolean; children?: ReactNode }) {
  const reader = useMemo<BillReader>(() => ({
    enabled: !!engine,
    read: (f, p) => readBill(engine, f, p, new Date(), debug ? (name, text) => { console.debug(`[ocr] ${name}\n${text}`); } : undefined),
  }), [engine, debug]);
  return <Ctx.Provider value={reader}>{children}</Ctx.Provider>;
}

export const useBillReader = (): BillReader => useContext(Ctx);
export { createOcrEngine };
