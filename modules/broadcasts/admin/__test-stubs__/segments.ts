/**
 * Test-time stub for the host admin app's `@/lib/segments` (see ui.tsx for
 * why host modules are stubbed). Only the duplicate path calls it.
 */
export function createSegmentService() {
  return { recalculateSegment: async () => undefined };
}
export type SegmentDefinition = Record<string, unknown>;
