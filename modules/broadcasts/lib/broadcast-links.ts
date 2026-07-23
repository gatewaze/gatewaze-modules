/**
 * Broadcast link-registry builder — pure, renderer-agnostic.
 * Per spec-broadcasts-blocks.md §4.4 / §5.4.
 *
 * Turns a broadcast's ordered block instances into the rows that populate the
 * `broadcast_links` registry, reusing stable tracking_keys for occurrences that
 * already have one (so historical click attribution survives a re-render). The
 * output `taggable` list is what `tagHtmlLinks` consumes to stamp `?nlb=` onto
 * the rendered HTML — whatever renderer produced that HTML.
 *
 * This mirrors newsletters' `syncEditionLinkRegistry` (send-engine-binding.ts),
 * split into a pure core (this file) + a thin DB caller (the admin service), so
 * the ordering/keying logic is unit-testable without a database.
 */

import {
  extractTrackableLinks,
  generateTrackingKey,
  type LinkSourceBlock,
  type TaggableLink,
} from './link-tracking.js';

/** A row to upsert into `broadcast_links`. */
export interface BroadcastLinkRow {
  broadcast_id: string;
  block_id: string;
  brick_id: string | null;
  tracking_key: string;
  block_type: string;
  tracking_slug: string | null;
  field: string;
  link_index: number;
  original_url: string;
}

export interface BuildLinkRowsResult {
  /** Rows to upsert on `(block_id, field, link_index)`. */
  rows: BroadcastLinkRow[];
  /** Ordered link list for `tagHtmlLinks` (document order, distinct duplicates). */
  taggable: TaggableLink[];
}

/** Registry occurrence key: `${block_id}|${field}|${link_index}`. */
export function occurrenceKey(block_id: string, field: string, link_index: number): string {
  return `${block_id}|${field}|${link_index}`;
}

/**
 * Build the `broadcast_links` rows + the ordered taggable list for a broadcast.
 *
 * @param broadcastId  the parent broadcast id (stamped on every row)
 * @param blocks       ordered block instances (with optional bricks)
 * @param existingKeys map of occurrenceKey → tracking_key for occurrences that
 *                     already exist in the registry (reuse to keep keys stable);
 *                     omit/empty on first render.
 */
export function buildBroadcastLinkRows(
  broadcastId: string,
  blocks: ReadonlyArray<LinkSourceBlock>,
  existingKeys: ReadonlyMap<string, string> = new Map(),
): BuildLinkRowsResult {
  const occurrences = extractTrackableLinks(blocks);
  const rows: BroadcastLinkRow[] = [];
  const taggable: TaggableLink[] = [];

  for (const occ of occurrences) {
    const key = occurrenceKey(occ.block_id, occ.field, occ.link_index);
    const tracking_key = existingKeys.get(key) ?? generateTrackingKey();
    rows.push({
      broadcast_id: broadcastId,
      block_id: occ.block_id,
      brick_id: occ.brick_id,
      tracking_key,
      block_type: occ.block_type,
      tracking_slug: occ.tracking_slug,
      field: occ.field,
      link_index: occ.link_index,
      original_url: occ.original_url,
    });
    // Emit in the SAME document order extraction produced, so tagHtmlLinks
    // consumes duplicate URLs sequentially with distinct keys.
    taggable.push({ original_url: occ.original_url, tracking_key });
  }

  return { rows, taggable };
}
