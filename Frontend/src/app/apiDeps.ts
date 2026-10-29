import { authStore } from '../auth/authStore';
import { readAppConfig } from '../config/appConfig';
import { ApiError } from '../services/apiClient';
import { createAuthApi } from '../services/authApi';
import { authedFetchOf, createExecSp, restoreSessionOf } from '../services/execSp';
import { createFileClient } from '../services/fileApi';
import { SP, docTypeFor, type UploadedFile } from '../services/spContract';
import type { ApiDeps } from '../services';

/** File -> base64 without building one giant string of char codes at once. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Backend wiring, following the existing Express API:
 *  - execSp: POST {VITE_API_BASE_URL}/api/execute, Bearer token, httpOnly refresh cookie, one silent refresh on TOKEN_EXPIRED;
 *  - auth: /api/auth/login, /refresh, /logout, /change-password, /forgot-password, /reset-password, /magic-login;
 *  - files: uploads go THROUGH /api/execute as base64 (TA_usp_UploadAttachment, as the existing usp_UploadAttachment does);
 *    previews use GET {VITE_ATTACHMENT_VIEW_PATH or /api/attachment/view}/:docType/:fileName with the token + cookies.
 */
export const getApiDeps = (): ApiDeps => {
  const cfg = readAppConfig(import.meta.env);
  const execSp = createExecSp({ baseUrl: cfg.apiBaseUrl, store: authStore, timeoutMs: cfg.apiTimeoutMs });
  const authedFetch = authedFetchOf(execSp);
  const fileClient = createFileClient({ baseUrl: cfg.apiBaseUrl, authedFetch, viewPath: import.meta.env.VITE_ATTACHMENT_VIEW_PATH });
  return {
    execSp,
    store: authStore,
    auth: createAuthApi({ baseUrl: cfg.apiBaseUrl, store: authStore, authedFetch }),
    restore: () => restoreSessionOf(execSp),
    files: {
      async upload(file, target) {
        const docType = docTypeFor(target?.kind);
        const r = (await execSp(SP.uploadAttachment, {
          DocType: docType, FileName: file.name, MimeType: file.type, Size: file.size, Base64Content: await toBase64(file),
          Kind: target?.kind, RecordId: target?.recordId, LineId: target?.lineId,
        })) as { storedFileName?: unknown } | null;
        if (!r || typeof r.storedFileName !== 'string' || !r.storedFileName) throw new ApiError('parse', 'The server did not confirm the upload.', null, null, null);
        const out: UploadedFile = { fileId: r.storedFileName, docType, name: file.name, size: file.size, type: file.type };
        return out;
      },
      download: (att) => fileClient.fetchAttachment(att.docType, att.fileId),
    },
  };
};
