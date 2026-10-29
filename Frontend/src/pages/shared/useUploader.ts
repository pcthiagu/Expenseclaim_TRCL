import { useCallback, useState } from 'react';
import { useApp } from '../../app/AppContext';
import { useToast } from '../../components/common/Toast';
import { ApiError, checkAttachment } from '../../services/apiClient';
import type { AttachmentMeta, RecordKind } from '../../types/domain';

/**
 * Uploads the files a user picks (through the gateway: base64 via TA_usp_UploadAttachment on the real backend) and returns their stored
 * metadata. Type/size are checked here for fast feedback and again by the server. Files that fail are reported and skipped.
 */
export function useUploader() {
  const { gateway, policy } = useApp();
  const toast = useToast();
  const [uploading, setUploading] = useState(0);
  const upload = useCallback(async (files: File[], target?: { kind?: RecordKind; recordId?: string; lineId?: string }): Promise<{ metas: AttachmentMeta[]; accepted: File[] }> => {
    const metas: AttachmentMeta[] = []; const accepted: File[] = [];
    setUploading((n) => n + 1);
    try {
      for (const f of files) {
        const bad = checkAttachment(f, policy);
        if (bad) { toast(bad, 'error'); continue; }
        try { metas.push(await gateway.uploadAttachment(f, target)); accepted.push(f); }
        catch (e) { toast(e instanceof ApiError ? `${f.name}: ${e.message}` : `${f.name}: upload failed.`, 'error'); }
      }
    } finally { setUploading((n) => n - 1); }
    return { metas, accepted };
  }, [gateway, policy, toast]);
  return { upload, uploading: uploading > 0 };
}
