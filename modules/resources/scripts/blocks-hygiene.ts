// Structured-blocks hygiene report (spec: Migration Plan deliverable).
//
// Recomputes search_text and derived slugs through the CURRENT module
// functions and diffs them against stored values — the check that catches
// write-path drift (out-of-band SQL, stale generators) that shape queries
// cannot. Also reports unknown kinds and schema-invalid payloads.
//
// Run: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx blocks-hygiene.ts [--fix]
//   --fix rewrites drifted search_text values through the module projection
//   (slug drift is reported only — slugs are load-bearing deep-link ids).

import { createClient } from '@supabase/supabase-js';
import { BLOCK_KINDS, validateBlock, projectSearchText, deriveHtmlSlug } from '../blocks';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  process.exit(2);
}
const fix = process.argv.includes('--fix');
const supabase = createClient(url, key);

async function main() {
  const { data: blocks, error } = await supabase
    .from('sr_blocks')
    .select('id, item_id, section_id, kind, slug, sort_order, data, search_text')
    .order('item_id')
    .order('section_id')
    .order('sort_order');
  if (error) throw new Error(error.message);

  const report = { total: blocks!.length, unknown_kind: 0, invalid_payload: 0, search_text_drift: 0, slug_drift: 0, fixed: 0 };

  for (const b of blocks!) {
    if (!BLOCK_KINDS[b.kind]) {
      report.unknown_kind++;
      console.log(JSON.stringify({ event: 'resources.blocks.hygiene_violation', reason: 'unknown_kind', block_id: b.id, kind: b.kind }));
      continue;
    }
    const issues = validateBlock({ kind: b.kind, slug: b.slug, sort_order: b.sort_order, data: b.data }, 'block');
    if (issues.length > 0) {
      report.invalid_payload++;
      console.log(JSON.stringify({ event: 'resources.blocks.hygiene_violation', reason: 'invalid_payload', block_id: b.id, kind: b.kind, path: issues[0].path, keyword: issues[0].keyword }));
    }
    const expected = projectSearchText(b.kind, b.data);
    if ((expected ?? null) !== (b.search_text ?? null)) {
      report.search_text_drift++;
      console.log(JSON.stringify({ event: 'resources.blocks.hygiene_violation', reason: 'search_text_drift', block_id: b.id, kind: b.kind }));
      if (fix) {
        const { error: upError } = await supabase.from('sr_blocks').update({ search_text: expected }).eq('id', b.id);
        if (upError) console.log(JSON.stringify({ event: 'resources.blocks.hygiene_fix_failed', block_id: b.id, message: upError.message }));
        else report.fixed++;
      }
    }
    // html slug parity with the derivation rule (explicit slugs may legitimately
    // differ; only flag derivable-but-missing or underivable-but-set-and-unresolved)
    if (b.kind === 'html' && typeof b.data?.html === 'string') {
      const derived = deriveHtmlSlug(b.data.html);
      if (!b.slug && derived) {
        report.slug_drift++;
        console.log(JSON.stringify({ event: 'resources.blocks.hygiene_violation', reason: 'slug_derivable_but_null', block_id: b.id, derived }));
      }
    }
  }

  console.log(JSON.stringify({ event: 'resources.blocks.hygiene_report', ...report }));
  process.exit(report.unknown_kind + report.invalid_payload + report.search_text_drift > 0 && !fix ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
