# execSp gateway

**Superseded by `docs/05-sp-contract.md`**, which names every stored procedure, its parameters, results and the rules it must enforce. `SpGateway` (src/services/SpGateway.ts) is implemented and tested against a fake `execSp`; to go live, return the project's `execSp` and a file client from `getApiDeps()` in `src/app/apiDeps.ts` and set `VITE_DATA_MODE=api`.

Original plan: Plugging in the real backend (`execSp`)
