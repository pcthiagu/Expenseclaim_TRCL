import type { AuthStore } from '../auth/authStore';
import type { AuthApi } from '../services/authApi';
import { SpGateway } from '../services/SpGateway';
import type { TravelClaimGateway } from '../services/ports';
import type { ExecSp, FileApi } from '../services/spContract';

/** Real-backend dependencies, supplied by src/app/apiDeps.ts: the shared execSp, the file client and the sign-in operations. */
export interface ApiDeps {
  execSp: ExecSp;
  files: FileApi;
  /** Overrides the proposed TA_ procedure names (only if the whitelist differs). */
  names?: ConstructorParameters<typeof SpGateway>[2];
  auth: AuthApi;
  store: AuthStore;
  /** Restores a session from the httpOnly refresh cookie; resolves false when there is none. */
  restore: () => Promise<boolean>;
}

/** The only data source: the stored procedures behind POST /api/execute. There is no mock or demo data anywhere in the app. */
export const createGateway = (deps: ApiDeps): TravelClaimGateway => new SpGateway(deps.execSp, deps.files, deps.names);
