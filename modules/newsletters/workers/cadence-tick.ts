/**
 * Cron (hourly): for each collection with an enabled cadence, create the
 * next edition when it is within create_lead_days of its slot.
 * spec-content-discovery-and-research-blocks.md §6.
 *
 *   * The occurrence row (collection_id, slot) is inserted FIRST; its primary
 *     key is what makes two workers or a restart safe, and what keeps a
 *     deleted or moved edition from being recreated.
 *   * The edition is seeded from templates_libraries.new_edition_blocks the
 *     way the editor's New edition does (lib/edition-skeleton.ts +
 *     lib/schema-defaults.ts), with status draft, send_target_at = slot,
 *     research_at NULL (derived), metadata.auto_created = true.
 *   * Never creates a newsletter_sends row.
 *   * A previous auto-created edition still untouched past its own slot is
 *     archived as superseded when the next one is created, so abandoned
 *     drafts do not pile up and their daily research stops.
 */

import type { Job } from 'bullmq';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { validateCadence, nextOccurrence, localDate, editionTitle, type Cadence } from '../lib/cadence.js';
import { defaultsFor } from '../lib/schema-defaults.js';

interface CollectionRow { id: string; name: string; slug: string; cadence: unknown; content_category: string | null }
interface LibraryRow { id: string; new_edition_blocks: unknown }

const DAY = 86_400_000;

export default async function handleCadenceTick(_job: Job<{ kind: string }>) {
  const sb = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
  const log = (m: string) => console.log(`[newsletters:cadence-tick] ${m}`);
  const { data: cols, error } = await sb.from('newsletters_template_collections').select('id, name, slug, cadence, content_category').not('cadence', 'is', null);
  if (error) throw new Error(`[newsletters:cadence-tick] collections query failed: ${error.message}`);
  const now = new Date();
  for (const col of (cols ?? []) as CollectionRow[]) {
    const { cadence, errors } = validateCadence(col.cadence);
    if (!cadence || cadence.enabled === false) { if (errors.length) log(`${col.slug}: cadence invalid (${errors.join('; ')}), skipped`); continue; }
    try {
      await tickCollection(sb, col, cadence, now, log);
    } catch (e) {
      log(`${col.slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

async function tickCollection(sb: SupabaseClient, col: CollectionRow, c: Cadence, now: Date, log: (m: string) => void) {
  // A claim whose edition insert never happened (crash between the two) would
  // block its slot forever; release claims with no edition after 10 minutes.
  await sb.from('newsletters_cadence_occurrences').delete().eq('collection_id', col.id).eq('state', 'created').is('edition_id', null).lt('created_at', new Date(now.getTime() - 10 * 60_000).toISOString());
  const slot = nextOccurrence(c, now);
  const leadMs = (c.create_lead_days ?? 4) * DAY;
  if (slot.getTime() - now.getTime() > leadMs) return; // not yet
  const slotIso = slot.toISOString();

  // Claim the slot. The PK refuses a second claim; a skipped slot is a claim too.
  const claim = await sb.from('newsletters_cadence_occurrences').insert({ collection_id: col.id, slot: slotIso, state: 'created' }).select('slot').maybeSingle();
  if (claim.error) {
    if (/duplicate key|newsletters_cadence_occurrences_pkey/i.test(claim.error.message)) return; // already created or skipped
    throw new Error(`claim failed: ${claim.error.message}`);
  }

  // The library this newsletter's template lives in (templates host registration).
  const lib = await sb.from('templates_libraries').select('id, new_edition_blocks').eq('host_kind', 'newsletter').eq('host_id', col.id).maybeSingle();
  const library = lib.data as LibraryRow | null;
  const tz = c.timezone ?? 'UTC';
  const title = editionTitle(c.title_pattern, slot, tz, `${col.name} — ${localDate(slot, tz).ymd}`);

  const ed = await sb.from('newsletters_editions').insert({
    title,
    edition_date: localDate(slot, tz).ymd,
    status: 'draft',
    collection_id: col.id,
    content_category: col.content_category,
    templates_library_id: library?.id ?? null,
    send_target_at: slotIso,
    research_at: null,
    metadata: { auto_created: true, cadence_slot: slotIso },
    version: 1,
  }).select('id').maybeSingle();
  if (ed.error || !ed.data) {
    // Release the claim so the next tick retries rather than silently leaving a hole.
    await sb.from('newsletters_cadence_occurrences').delete().eq('collection_id', col.id).eq('slot', slotIso);
    throw new Error(`edition insert failed: ${ed.error?.message ?? 'no row'}`);
  }
  const editionId = (ed.data as { id: string }).id;
  // Link the claim to its edition. If this fails the claim still has no
  // edition_id, and the 10-minute release above would free the slot and a
  // later tick would create a SECOND edition for it. So undo: delete the
  // edition (nothing references it yet) and release the claim now; the next
  // tick starts clean.
  const link = await sb.from('newsletters_cadence_occurrences').update({ edition_id: editionId }).eq('collection_id', col.id).eq('slot', slotIso).select('slot');
  if (link.error || !link.data?.length) {
    const del = await sb.from('newsletters_editions').delete().eq('id', editionId);
    await sb.from('newsletters_cadence_occurrences').delete().eq('collection_id', col.id).eq('slot', slotIso).is('edition_id', null);
    throw new Error(`could not link edition ${editionId} to its slot (${link.error?.message ?? 'claim row gone'}); ${del.error ? `and could not delete it: ${del.error.message}` : 'edition deleted, slot released'}`);
  }

  // Seed blocks from edition.json.
  if (library?.new_edition_blocks) {
    const { asEditionSkeleton, buildSkeletonBlocks } = await import('../lib/edition-skeleton.js');
    const skeleton = asEditionSkeleton(library.new_edition_blocks);
    if (skeleton) {
      const { data: defs } = await sb.from('templates_block_defs').select('id, key, name, description, schema, html, rich_text_template, has_bricks, render_kind, component_id').eq('library_id', library.id).eq('is_current', true);
      const rows = (defs ?? []) as Array<{ id: string; key: string; name: string; description: string | null; schema: Record<string, unknown> | null; html: string | null; rich_text_template: string | null; has_bricks: boolean | null; render_kind: string | null; component_id: string | null }>;
      const { randomUUID } = await import('node:crypto');
      const { blocks, missing } = buildSkeletonBlocks({
        skeleton,
        defs: rows,
        defaultsFor: (key: string) => defaultsFor((rows.find((d) => d.key === key)?.schema ?? {}) as Record<string, never>),
        newId: () => randomUUID(),
      });
      if (missing.length) log(`${col.slug}: edition.json names blocks the library does not have: ${missing.join(', ')}`);
      if (blocks.length) {
        const { error: bErr } = await sb.from('newsletters_edition_blocks').insert(
          blocks.map((b: { id: string; block_template: { id: string; key: string }; content: Record<string, unknown> }, i: number) => ({ id: b.id, edition_id: editionId, block_type: b.block_template.key, templates_block_def_id: b.block_template.id, content: b.content, sort_order: i, block_order: i })),
        );
        if (bErr) log(`${col.slug}: seeding blocks failed: ${bErr.message}`);
      }
    }
  }
  log(`${col.slug}: created edition ${editionId} for ${slotIso} ("${title}")`);

  // Supersede an untouched auto-created draft whose own slot has passed.
  // "Untouched" = no safe-save revision rows (the editor writes one per
  // save), no send rows, and no research edit layer on any block (a pin or
  // an override is saved by newsletters_research_edits_write, which bumps the
  // version without writing a revision). Research RUNS bump the version too
  // and do not count as touching, so the version number alone cannot decide.
  const { data: olds } = await sb.from('newsletters_editions').select('id, send_target_at, metadata').eq('collection_id', col.id).eq('status', 'draft').neq('id', editionId).lt('send_target_at', now.toISOString());
  for (const o of (olds ?? []) as Array<{ id: string; send_target_at: string; metadata: Record<string, unknown> | null }>) {
    if (!o.metadata?.auto_created) continue;
    const [sendsQ, revisionsQ, editsQ] = await Promise.all([
      sb.from('newsletter_sends').select('id', { count: 'exact', head: true }).eq('edition_id', o.id),
      sb.from('newsletters_edition_revisions').select('id', { count: 'exact', head: true }).eq('edition_id', o.id),
      sb.from('newsletters_edition_blocks').select('id', { count: 'exact', head: true }).eq('edition_id', o.id).not('content->research_edits', 'is', null),
    ]);
    // Any failed count is "touched": never archive on a guess.
    if (sendsQ.error || revisionsQ.error || editsQ.error) { log(`${col.slug}: could not check edition ${o.id} for edits; left alone`); continue; }
    if ((sendsQ.count ?? 0) > 0 || (revisionsQ.count ?? 0) > 0 || (editsQ.count ?? 0) > 0) continue;
    // Guard on status so a concurrent edit that published it is not archived; re-read metadata inside the same statement.
    const { data: fresh } = await sb.from('newsletters_editions').select('metadata').eq('id', o.id).eq('status', 'draft').maybeSingle();
    if (!fresh) continue;
    const meta = ((fresh as { metadata: Record<string, unknown> | null }).metadata ?? {});
    await sb.from('newsletters_editions').update({ status: 'archived', metadata: { ...meta, skipped_reason: 'superseded' } }).eq('id', o.id).eq('status', 'draft');
    await sb.from('newsletters_cadence_occurrences').update({ state: 'skipped', note: 'superseded by the next slot' }).eq('edition_id', o.id);
    log(`${col.slug}: archived untouched auto-created edition ${o.id} (slot ${o.send_target_at})`);
  }
}
