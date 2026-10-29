# Backend contract — status

No API documentation, source, base URL or auth details were supplied, and the prototype makes no network calls. **Every operation below is UNVERIFIED.** Nothing has been integrated or simulated as successful.

Operations required by the UI (`src/services/ports.ts`): getSession, getPolicy, listRecords, getRecord, saveDraft, submit, deleteDraft, copyRejectedClaim, approve, reject, listPendingApprovals, listApprovalHistory, listReceipts, uploadReceipts, updateReceipt, deleteReceipt, uploadAttachment, openAttachment, lookupEmployees.

Questions to answer before writing `HttpGateway`:
1. Base URL/prefix and environments. 2. Auth (cookie session vs bearer; refresh; CSRF). 3. Endpoints/verbs/payloads for each operation above, incl. error body shape. 4. Does the backend generate `EMPCODE/YYYY/NNNN`, `TR/…`, `AR/…` atomically at first save? 5. Server-side enforcement of status transitions, ownership, approved ≤ claimed, medical/advance balance. 6. Attachment storage: upload endpoint, authorised download, type/size validation, receipt↔claim linking and release rules. 7. Is policy configuration exposed (rates, limits, per-item limits)? 8. Employee lookup/cost centres. 9. Does anything settle advances (the prototype never does)? 10. Server-side filtering/paging/sorting for lists.

If any is missing, propose the smallest backend change; none has been requested yet.
