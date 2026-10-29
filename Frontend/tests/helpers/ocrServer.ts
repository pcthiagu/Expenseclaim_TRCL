import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { ocrFile } from './ocrCli.ts';

/** Test OCR service: accepts multipart `file`, runs the real Tesseract CLI, answers `{ text }`. */
export async function startOcrServer(opts: { delayMs?: number; port?: number } = {}): Promise<{ url: string; hits: () => number; close: () => void }> {
  let hits = 0;
  const server = http.createServer(async (req, res) => {
    // Credentials are sent by the remote engine, so a wildcard origin is not allowed: echo the caller's origin.
    const cors: Record<string, string> = { 'Access-Control-Allow-Origin': String(req.headers.origin ?? '*'), 'Access-Control-Allow-Credentials': 'true', 'Access-Control-Allow-Headers': '*', Vary: 'Origin' };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
    try {
      hits++;
      const form = await new Response(Readable.toWeb(req) as unknown as BodyInit, { headers: { 'content-type': String(req.headers['content-type']) }, method: 'POST', duplex: 'half' } as RequestInit).formData();
      const f = form.get('file') as File;
      const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocrsrv-')), f.name);
      fs.writeFileSync(tmp, Buffer.from(await f.arrayBuffer()));
      const delay = /slow/i.test(f.name) ? 2500 : (opts.delayMs ?? 0); // files named *slow* simulate a slow OCR service
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const text = ocrFile(tmp); // compute first: a corrupt file must produce a clean 500, not a half-written 200
      res.writeHead(200, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ text }));
    } catch (e) {
      if (res.headersSent) return res.end();
      res.writeHead(500, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ message: 'OCR failed' }));
    }
  });
  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ocr`, hits: () => hits, close: () => server.close() };
}
