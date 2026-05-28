/**
 * Admin: audit log search (spec §3.1).
 *
 * Phase 1: stub. Phase 3 implements paginated search over
 * fetch.audit_log with redaction (per §11.6) of cross-tenant URLs.
 */

export default function FetchAuditLogPage() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Web Fetch — Audit Log</h1>
      <p className="mt-2 text-sm text-gray-600">Phase 3 implements this view.</p>
    </div>
  );
}
