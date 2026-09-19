#!/usr/bin/env node
/**
 * Orphan sweep for guest uploads — lists (and optionally deletes)
 * storage objects under event/<eventId>/... that have no host_media
 * row. Orphans are the expected cost of the stateless ticket flow: a
 * guest PUT the bytes but never called complete (closed the tab,
 * walked out of wifi). No cron runs this — it's a manual, occasional
 * tidy-up.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/sweep-orphan-guest-media.mjs <eventId> [--delete]
 *
 * Report-only by default; nothing is removed without --delete.
 * Objects younger than 24h are always left alone (the guest may still
 * complete them — tickets live 2h, plus generous slack).
 */

import { createClient } from '@supabase/supabase-js';

const BUCKET = process.env.HOST_MEDIA_BUCKET ?? 'media';
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

const [eventId, ...flags] = process.argv.slice(2);
const doDelete = flags.includes('--delete');

if (!eventId || !/^[0-9a-f-]{36}$/i.test(eventId)) {
  console.error('usage: sweep-orphan-guest-media.mjs <event uuid> [--delete]');
  process.exit(1);
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(1);
}

const supabase = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

// storage list is per-directory: event/<eventId>/ has one folder per
// media id; each folder holds the original (+ variants/).
const prefix = `event/${eventId}`;
const { data: folders, error: listErr } = await supabase.storage.from(BUCKET).list(prefix, { limit: 10_000 });
if (listErr) {
  console.error(`storage list failed: ${listErr.message}`);
  process.exit(1);
}

const mediaFolders = (folders ?? []).filter((f) => !f.name.startsWith('__') && !f.metadata);
console.log(`${mediaFolders.length} media folder(s) under ${prefix}/`);

let orphans = 0;
let removed = 0;

for (const folder of mediaFolders) {
  const mediaId = folder.name;
  if (!/^[0-9a-f-]{36}$/i.test(mediaId)) continue;

  const { data: row } = await supabase.from('host_media').select('id').eq('id', mediaId).maybeSingle();
  if (row) continue;

  const { data: files } = await supabase.storage.from(BUCKET).list(`${prefix}/${mediaId}`, { limit: 100 });
  const young = (files ?? []).some(
    (f) => f.created_at && Date.now() - new Date(f.created_at).getTime() < MIN_AGE_MS,
  );
  if (young) {
    console.log(`skip (younger than 24h): ${prefix}/${mediaId}`);
    continue;
  }

  orphans += 1;
  const paths = (files ?? []).map((f) => `${prefix}/${mediaId}/${f.name}`);
  console.log(`orphan: ${prefix}/${mediaId} (${paths.length} object(s))`);

  if (doDelete && paths.length > 0) {
    const { error: rmErr } = await supabase.storage.from(BUCKET).remove(paths);
    if (rmErr) console.error(`  delete failed: ${rmErr.message}`);
    else { removed += 1; console.log('  deleted'); }
  }
}

console.log(`\n${orphans} orphan folder(s)${doDelete ? `, ${removed} deleted` : ' (report-only; pass --delete to remove)'}`);
