import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Test-only OCR via the Tesseract CLI (+ pdftotext / pdftoppm for PDFs). Mirrors what the browser/remote engines return: plain text. */
export const hasTesseract = (): boolean => spawnSync('tesseract', ['--version']).status === 0;

export function ocrFile(file: string): string {
  if (file.toLowerCase().endsWith('.pdf')) {
    const t = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    if (t.replace(/\s/g, '').length >= 40) return t; // real text layer
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-'));
    execFileSync('pdftoppm', ['-r', '200', '-png', '-f', '1', '-l', '1', file, path.join(dir, 'p')]);
    const png = (fs.readdirSync(dir) as string[]).find((f: string) => f.endsWith('.png')) as string;
    return execFileSync('tesseract', [path.join(dir, png), '-', '--psm', '6'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  }
  return execFileSync('tesseract', [file, '-', '--psm', '6'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
