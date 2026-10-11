/**
 * Test-time stub for the host admin app's `@/lib/supabase` (see ui.tsx
 * stub for why). BroadcastsTable.test.tsx mocks broadcastEngagement /
 * deleteBroadcast directly, but importing the real broadcastService.ts
 * (for its other, unmocked exports like broadcastSummary) still executes
 * this top-level import, so it needs to resolve to something.
 */
export const supabase = {};
