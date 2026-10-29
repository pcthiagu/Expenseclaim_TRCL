import { buildError } from '../services/execSp';

/**
 * Existing protected file routes (contract as described by the project owner):
 *   GET {base}{viewPath}/:docType/:fileName   (attachment / PDF preview; default /api/attachment/view)
 * Upload is NOT a route: files go through /api/execute as base64 (TA_usp_UploadAttachment), see src/app/apiDeps.ts.
 * An <iframe>/<img> cannot send an Authorization header, so previews are fetched with the token + cookies and shown from a blob URL
 * (the bytes never get a public URL). Every path segment is percent-encoded, so transaction numbers such as "TR/2026/0048" travel as
 * ONE segment (TR%2F2026%2F0048) and cannot change the route.
 */
/** The attached server implements /api/attachment/view/:docType/:fileName; your brief names /api/taattachment/view: set VITE_ATTACHMENT_VIEW_PATH. */
export const DEFAULT_VIEW_PATH = '/api/attachment/view';
export const attachmentViewPath = (docType: string, fileName: string, prefix: string = DEFAULT_VIEW_PATH): string =>
  `${prefix.replace(/\/+$/, '')}/${encodeURIComponent(docType)}/${encodeURIComponent(fileName)}`;

export interface FileClientOptions { baseUrl: string; authedFetch: (url: string, init?: RequestInit) => Promise<Response>; viewPath?: string }

export function createFileClient(o: FileClientOptions) {
  const base = o.baseUrl.replace(/\/+$/, '');
  const prefix = o.viewPath ?? DEFAULT_VIEW_PATH;
  return {
    /** The (protected) preview route as a URL; fetch it with credentials, do not put it in an <iframe src> directly. */
    viewUrl: (docType: string, fileName: string): string => base + attachmentViewPath(docType, fileName, prefix),
    /** Fetches the protected file as a Blob. 401/403/404 become typed errors; nothing is exposed on failure. */
    async fetchAttachment(docType: string, fileName: string): Promise<Blob> {
      const res = await o.authedFetch(base + attachmentViewPath(docType, fileName, prefix), { method: 'GET' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw buildError(res.status, body);
      }
      return res.blob();
    },
    /** Blob URL for an <iframe>/<img>; call revoke() when the preview closes. */
    async openPreview(docType: string, fileName: string): Promise<{ url: string; revoke: () => void; type: string }> {
      const blob = await this.fetchAttachment(docType, fileName);
      const url = URL.createObjectURL(blob);
      return { url, type: blob.type, revoke: () => URL.revokeObjectURL(url) };
    },
  };
}
