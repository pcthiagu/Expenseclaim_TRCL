// SANDBOX-ONLY verification build. The real build is `vite build` (needs npm install). This bundles the SAME source with
// esbuild so the app can be exercised in a headless browser where the npm registry is unreachable.
//   NODE_PATH=<global node_modules> node scripts/sandbox/bundle.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const G = process.env.GLOBAL_NODE_MODULES ?? '/home/claude/.npm-global/lib/node_modules';
const esbuild = createRequire(G + '/tsx/')('esbuild');
const root = path.resolve(import.meta.dirname, '../..');
const out = path.join(root, process.env.OUT_DIR ?? 'dist-sandbox');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'app'), { recursive: true });

const result = await esbuild.build({
  entryPoints: [path.join(root, 'src/main.tsx')],
  outdir: path.join(out, 'app'), bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  jsx: 'automatic', sourcemap: true, minify: false, tsconfig: path.join(root, 'tsconfig.json'),
  nodePaths: [G], logLevel: 'info', metafile: true,
  define: { 'import.meta.env': JSON.stringify({ VITE_OCR_MODE: process.env.VITE_OCR_MODE ?? 'off', VITE_OCR_ENDPOINT: process.env.VITE_OCR_ENDPOINT ?? '', VITE_API_BASE_URL: process.env.VITE_API_BASE_URL ?? '', BASE_URL: '/' }) },
  loader: { '.svg': 'dataurl' },
  // Browser-OCR packages are not installable here; they are only imported lazily by BrowserOcrEngine (never run in sandbox tests).
  external: ['tesseract.js', 'pdfjs-dist', 'pdfjs-dist/*'],
});
fs.cpSync(path.join(root, 'public'), out, { recursive: true });
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  .replace('</head>', '  <link rel="stylesheet" href="/app/main.css">\n</head>')
  .replace('/src/main.tsx', '/app/main.js');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log('bundled', Object.keys(result.metafile.outputs).filter((f) => f.endsWith('.js')).length, 'js chunks');
