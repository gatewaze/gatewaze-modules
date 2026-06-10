/**
 * Newsletter link-tracking reconciler.
 * Per spec-newsletter-link-tracking.md §4.4 / §8.
 *
 * Re-resolves email_interactions click rows that were stored with a NULL
 * edition_link_id (e.g. a click that arrived before the registry row existed,
 * a webhook redelivery, or a transient lookup failure). Parses the ?nlb= key
 * from clicked_url and back-fills the resolved block/edition. Idempotent and
 * safe to re-run — already-resolved rows are excluded by the query.
 */

import { createClient } from '@supabase/supabase-js';
import type { Job } from 'bullmq';
import { parseNlb } from '../lib/link-tracking.js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface ReconcileJobData {
  kind: string;
}

const BATCH = 1000;

export default async function handleLinkReconcile(_job: Job<ReconcileJobData>) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Candidate clicks: tracked-but-unresolved (carry an nlb param).
  const { data: rows, error } = await supabase
    .from('email_interactions')
    .select('id, clicked_url')
    .eq('event_type', 'click')
    .is('edition_link_id', null)
    .not('clicked_url', 'is', null)
    .like('clicked_url', '%nlb=%')
    .limit(BATCH);

  if (error) {
    console.error('[link-reconciler] candidate query failed:', error.message);
    return { resolved: 0, scanned: 0 };
  }
  const candidates = (rows ?? []) as Array<{ id: string; clicked_url: string }>;
  if (candidates.length === 0) return { resolved: 0, scanned: 0 };

  const keyByRow = new Map<string, string>();
  for (const r of candidates) {
    const key = parseNlb(r.clicked_url);
    if (key) keyByRow.set(r.id, key);
  }
  const keys = [...new Set(keyByRow.values())];
  if (keys.length === 0) return { resolved: 0, scanned: candidates.length };

  const linkByKey = new Map<string, { id: string; block_id: string | null; block_type: string | null; edition_id: string | null }>();
  for (let i = 0; i < keys.length; i += 500) {
    const { data: links } = await supabase
      .from('newsletters_edition_links')
      .select('id, tracking_key, block_id, block_type, edition_id')
      .in('tracking_key', keys.slice(i, i + 500));
    for (const l of (links ?? []) as Array<{ id: string; tracking_key: string; block_id: string | null; block_type: string | null; edition_id: string | null }>) {
      linkByKey.set(l.tracking_key, { id: l.id, block_id: l.block_id, block_type: l.block_type, edition_id: l.edition_id });
    }
  }

  let resolved = 0;
  for (const [rowId, key] of keyByRow) {
    const link = linkByKey.get(key);
    if (!link) continue;
    const { error: updErr } = await supabase
      .from('email_interactions')
      .update({ edition_link_id: link.id, block_id: link.block_id, block_type: link.block_type, edition_id: link.edition_id })
      .eq('id', rowId);
    if (!updErr) resolved++;
  }

  console.log(`[link-reconciler] resolved ${resolved}/${candidates.length} unresolved clicks`);
  return { resolved, scanned: candidates.length };
}
