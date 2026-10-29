import { useEffect, useState } from 'react';
import type { TravelClaimGateway } from '../../services/ports';
import type { Receipt } from '../../types/domain';

/**
 * Loads the signed-in employee's receipt box when a drawer opens, so pickers always use the server's current
 * used/unused state (never a stale snapshot from page load). Approvers have no receipt box: returns an empty list.
 */
export function useReceipts(gateway: TravelClaimGateway, isAdmin: boolean): { receipts: Receipt[]; loading: boolean } {
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(!isAdmin);
  useEffect(() => {
    if (isAdmin) return;
    let off = false;
    gateway.listReceipts().then((r) => { if (!off) setReceipts(r); }).catch(() => undefined).finally(() => { if (!off) setLoading(false); });
    return () => { off = true; };
  }, [gateway, isAdmin]);
  return { receipts, loading };
}
