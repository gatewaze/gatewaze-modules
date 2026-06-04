/**
 * Admin: per-key usage charts (spec §3.1 admin pages).
 *
 * Phase 1: stub render. Phase 3 wires up a chart from the
 * gw_fetch.usage_ledger table.
 */

export default function FetchUsagePage() {
  return (
    <div className="p-6">
      <h1 className="text-xl font-semibold">Web Fetch — Usage</h1>
      <p className="mt-2 text-sm text-gray-600">
        Per-key usage charts (Phase 3). Backed by the
        <code> gw_fetch.usage_ledger </code> table.
      </p>
    </div>
  );
}
