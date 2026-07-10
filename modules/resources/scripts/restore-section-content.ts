// Rollback tool for promoted talk sections (spec: Migration Plan → Rollback).
//
// A section whose content was nulled by the talk promotion renders EMPTY if
// its blocks are deleted (or under RESOURCES_FORCE_LEGACY_SECTIONS). This
// script restores sr_sections.content from sr_blocks_migration_audit and
// deletes the section's blocks, reverting it fully to legacy rendering.
//
// Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx restore-section-content.ts <section_id> [<section_id> ...]

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sectionIds = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (!url || !key || sectionIds.length === 0) {
  console.error('usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx restore-section-content.ts <section_id> ...');
  process.exit(2);
}
const supabase = createClient(url, key);

async function main() {
  for (const id of sectionIds) {
    const { data: audit, error } = await supabase
      .from('sr_blocks_migration_audit')
      .select('old_content, migrated_at')
      .eq('section_id', id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!audit) {
      console.log(`SKIP ${id}: no audit row (content was never nulled by promotion)`);
      continue;
    }
    const { error: upError } = await supabase
      .from('sr_sections')
      .update({ content: audit.old_content })
      .eq('id', id);
    if (upError) throw new Error(upError.message);
    const { error: delError } = await supabase.from('sr_blocks').delete().eq('section_id', id);
    if (delError) throw new Error(delError.message);
    console.log(`RESTORED ${id}: content back from audit (migrated_at ${audit.migrated_at}), blocks deleted`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
