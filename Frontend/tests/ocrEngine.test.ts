import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OcrError, RemoteOcrEngine, createOcrEngine, readBill } from '../src/services/ocr.ts';
import { hasTesseract } from './helpers/ocrCli.ts';
import { startOcrServer } from './helpers/ocrServer.ts';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/receipts');
const fileOf = (name: string, type: string) => new File([fs.readFileSync(path.join(dir, name))], name, { type });
const skip = !hasTesseract() && 'tesseract not installed';
const NOW = new Date(2026, 9, 17);

test('remote engine: uploads the file as multipart and returns the service text; readBill parses it (real Tesseract behind a real HTTP server)', { skip }, async () => {
  const srv = await startOcrServer();
  try {
    const engine = new RemoteOcrEngine(srv.url);
    const progress: number[] = [];
    const r = await readBill(engine, fileOf('fuel.png', 'image/png'), (p) => progress.push(p), NOW);
    assert.equal(r.error, null);
    assert.deepEqual([r.suggestion?.amount?.value, r.suggestion?.billNumber?.value, r.suggestion?.date?.value], [3640, 'HP-21190', '2026-09-30']);
    assert.deepEqual([progress[0], progress.at(-1)], [0.1, 1]);
    const pdf = await readBill(engine, fileOf('restaurant_scan.pdf', 'application/pdf'), undefined, NOW);
    assert.equal(pdf.suggestion?.amount?.value, 168, 'scanned PDF is rasterised and read');
    assert.equal(srv.hits(), 2);
  } finally { srv.close(); }
});

test('remote engine rejects unsupported files before any network call', async () => {
  let called = false;
  const engine = new RemoteOcrEngine('http://x/ocr', { fetchImpl: (async () => { called = true; return new Response('{}'); }) as typeof fetch });
  await assert.rejects(engine.recognize(new File(['x'], 'a.gif', { type: 'image/gif' })), (e: unknown) => e instanceof OcrError && e.code === 'unsupported');
  assert.equal(called, false);
});

test('readBill never throws: HTTP errors, bad payloads and unsupported types become a message; engine=null is a quiet no-op', async () => {
  const mk = (res: () => Response) => new RemoteOcrEngine('http://x/ocr', { fetchImpl: (async () => res()) as typeof fetch });
  const f = new File(['x'], 'a.png', { type: 'image/png' });
  assert.match((await readBill(mk(() => new Response('boom', { status: 500 })), f)).error ?? '', /returned 500/);
  assert.match((await readBill(mk(() => new Response('{"nope":1}')), f)).error ?? '', /unexpected response/);
  assert.match((await readBill(mk(() => new Response('<html>')), f)).error ?? '', /unexpected response/);
  assert.match((await readBill(mk(() => new Response('{}')), new File(['x'], 'a.gif', { type: 'image/gif' }))).error ?? '', /Only PDF, JPG or PNG/);
  assert.deepEqual(await readBill(null, f), { suggestion: null, error: null });
  const net = new RemoteOcrEngine('http://x/ocr', { fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  assert.ok((await readBill(net, f)).error);
  const alt = mk(() => new Response('{"success":true,"data":{"text":"Grand Total 10.00"}}'));
  assert.equal((await readBill(alt, f, undefined, NOW)).suggestion?.amount?.value, 10, 'accepts the {success,data:{text}} envelope too');
});

test('factory: off -> null, remote needs an endpoint, unknown mode throws, browser is the default', () => {
  assert.equal(createOcrEngine({ VITE_OCR_MODE: 'off' }), null);
  assert.throws(() => createOcrEngine({ VITE_OCR_MODE: 'remote' }), /endpoint is required/);
  assert.throws(() => createOcrEngine({ VITE_OCR_MODE: 'cloud' }), /Unknown VITE_OCR_MODE/);
  assert.equal(createOcrEngine({ VITE_OCR_MODE: 'remote', VITE_OCR_ENDPOINT: 'http://x/ocr' })?.name, 'remote');
  assert.equal(createOcrEngine({})?.name, 'browser');
});
