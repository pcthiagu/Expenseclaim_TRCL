# Travel Claim — React + Vite + TypeScript migration (in progress)

See `docs/` (start with `docs/03-status.md`). The original HTML prototype is no longer part of the project; its computed values are kept as golden fixtures (`tests/fixtures/golden.json`). The app has no demo or mock mode: it needs the Express backend and the `sql/TA` database objects.

```bash
npm install
npm run typecheck
npm test              # node:test via tsx: domain, gateway, auth transport, OCR, SQL contract (no browser needed)
npm run dev | build | preview
npm run sandbox:e2e  # esbuild bundle + headless-browser scenarios (used where the npm registry is unreachable)
```
Copy `.env.example` to `.env.local` and set the real `VITE_API_BASE_URL`. Never put secrets in `VITE_*` variables.

## Backend and OCR
- Data: the stored procedures behind `POST /api/execute` (see `docs/05-sp-contract.md`, `sql/TA/README.md` and `src/app/apiDeps.ts`). There is no demo or mock mode.
- Bill reading: `VITE_OCR_MODE=browser|remote|off` (see `docs/06-ocr.md`).
- Browser verification without SQL Server (the app against a FAKE of the Express API, `tests/helpers/fakeBackend.ts`): `npm run sandbox:e2e` (screens) and `npm run sandbox:e2e:api` (sign-in, session, files, views). They need `tsx` and Playwright.
- SQL: `npm run sql:lint` (static checks); install and test per `sql/TA/README.md`.
