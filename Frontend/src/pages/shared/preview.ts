import type { TravelClaimGateway } from '../../services/ports';
import type { AttachmentMeta } from '../../types/domain';

/**
 * Opens a stored attachment/PDF in a new tab. The file is fetched with the token + cookies (the protected route cannot be put in a plain
 * link) and shown from a short-lived blob URL, so the bytes never get a public address. The tab is opened synchronously on the click so
 * popup blockers allow it, then pointed at the blob once it has loaded.
 */
export async function previewAttachment(gateway: TravelClaimGateway, att: AttachmentMeta): Promise<void> {
  const tab = window.open('', '_blank');
  if (tab) tab.document.title = att.name;
  try {
    const blob = await gateway.openAttachment(att);
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 120_000);
  } catch (e) { tab?.close(); throw e; }
}
