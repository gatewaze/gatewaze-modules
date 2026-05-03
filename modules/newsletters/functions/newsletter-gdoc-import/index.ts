/**
 * Newsletter Google Doc Import Edge Function
 *
 * Supports three modes:
 * 1. POST with { collection_id, google_doc_id, edition_date, edition_title } → single doc import
 * 2. POST with { collection_id, google_folder_id, ... } → batch import from Drive folder
 * 3. GET with ?job_id=uuid → poll batch import status
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fetchGoogleDoc, listDocsInFolder } from './doc-fetcher.ts';
import { mapSectionsToBlocks, mapHtmlToBlocks, type BlockTemplate, type BrickTemplate } from './ai-mapper.ts';
import { processImages } from './image-processor.ts';
import { createEditionFromMapping } from './edition-creator.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const MAX_DOC_SIZE = 200 * 1024; // 200KB text limit

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Template loading
// ---------------------------------------------------------------------------

async function loadTemplates(supabase: any, collectionId: string) {
  // collection.id == library.id post-migration 021. Read directly from
  // templates_block_defs / templates_brick_defs.
  const { data: blockTemplates, error: btError } = await supabase
    .from('templates_block_defs')
    .select('id, key, name, description, has_bricks, schema')
    .eq('library_id', collectionId)
    .order('key');

  if (btError) throw new Error(`Failed to load block templates: ${btError.message}`);
  if (!blockTemplates || blockTemplates.length === 0) {
    throw new Error('Collection has no block templates configured');
  }

  const { data: brickTemplates, error: brError } = await supabase
    .from('templates_brick_defs')
    .select('id, key, name, schema, block_def_id, sort_order, templates_block_defs!inner(library_id)')
    .eq('templates_block_defs.library_id', collectionId)
    .order('sort_order');

  if (brError) throw new Error(`Failed to load brick templates: ${brError.message}`);

  // Index blocks by `key` for stable sort_order assignment in static-block
  // creation; templates_block_defs has no library-wide sort_order so we
  // synthesize one from the key alphabet (mirrors the static-block fallback
  // in edition-creator).
  const blocks: BlockTemplate[] = (blockTemplates || []).map((bt: any, idx: number) => ({
    id: bt.id,
    block_type: bt.key,
    name: bt.name || bt.key,
    description: bt.description,
    has_bricks: bt.has_bricks === true,
    schema: bt.schema || {},
    sort_order: idx,
  }));

  const bricks: BrickTemplate[] = (brickTemplates || []).map((bt: any) => ({
    id: bt.id,
    brick_type: bt.key,
    name: bt.name || bt.key,
    schema: bt.schema || {},
    block_def_id: bt.block_def_id,
    sort_order: bt.sort_order ?? 0,
  }));

  return { blocks, bricks };
}

// ---------------------------------------------------------------------------
// Single doc import
// ---------------------------------------------------------------------------

async function importSingleDoc(
  supabase: any,
  collectionId: string,
  googleDocId: string,
  editionDate: string,
  editionTitle: string,
  status = 'draft',
) {
  const startTime = Date.now();

  // 1. Fetch Google Doc
  console.log(`[gdoc-import] Fetching doc ${googleDocId}`);
  const doc = await fetchGoogleDoc(googleDocId);

  if (doc.textSizeBytes > MAX_DOC_SIZE) {
    throw new Error(
      `Document is too large (${Math.round(doc.textSizeBytes / 1024)}KB). Maximum is ${MAX_DOC_SIZE / 1024}KB. Consider splitting the document.`
    );
  }

  // 2. Load templates
  const templates = await loadTemplates(supabase, collectionId);

  // 3. AI mapping — use raw HTML path when available (public export), section tree when structured API was used
  let mapping;
  let tokenUsage;

  if (doc.rawHtml) {
    console.log(`[gdoc-import] Using raw HTML mapping (${Math.round(doc.rawHtml.length / 1024)}KB) to ${templates.blocks.length} block templates`);
    ({ result: mapping, tokenUsage } = await mapHtmlToBlocks(
      doc.rawHtml,
      templates.blocks,
      templates.bricks,
    ));
  } else {
    console.log(`[gdoc-import] Mapping ${doc.sections.length} sections to ${templates.blocks.length} block templates`);
    ({ result: mapping, tokenUsage } = await mapSectionsToBlocks(
      doc.sections,
      templates.blocks,
      templates.bricks,
    ));
  }

  // 4. Process images
  const { data: collection } = await supabase
    .from('newsletters_template_collections')
    .select('slug')
    .eq('id', collectionId)
    .single();

  const storagePath = `newsletters/${collection?.slug || 'import'}/${editionDate}`;
  const { mappings: imageMappings, warnings: imageWarnings } = await processImages(
    doc.inlineImages,
    supabase,
    storagePath,
  );

  // 5. Create edition
  const title = editionTitle || doc.title;
  const date = editionDate || mapping.extracted_date || new Date().toISOString().split('T')[0];

  const { editionId, blocksCreated, bricksCreated } = await createEditionFromMapping({
    supabase,
    collectionId,
    mapping,
    imageMappings,
    title,
    editionDate: date,
    status,
    importSource: { docId: googleDocId, docTitle: doc.title },
  });

  const duration = Date.now() - startTime;
  console.log(`[gdoc-import] Complete in ${duration}ms: ${blocksCreated} blocks, ${bricksCreated} bricks`);

  return {
    edition_id: editionId,
    blocks_created: blocksCreated,
    bricks_created: bricksCreated,
    images_imported: imageMappings.length,
    unmapped_sections: mapping.unmapped.map((u) => u.heading),
    warnings: imageWarnings,
    token_usage: tokenUsage,
    duration_ms: duration,
  };
}

// ---------------------------------------------------------------------------
// Batch import
// ---------------------------------------------------------------------------

async function startBatchImport(
  supabase: any,
  collectionId: string,
  googleFolderId: string,
  config: Record<string, unknown>,
  createdBy?: string,
) {
  // Check for existing processing job on this collection
  const { data: existing } = await supabase
    .from('newsletter_import_jobs')
    .select('id')
    .eq('collection_id', collectionId)
    .eq('status', 'processing')
    .limit(1);

  if (existing && existing.length > 0) {
    throw new Error('A batch import is already running for this collection. Wait for it to complete or cancel it.');
  }

  // List docs in folder
  const docs = await listDocsInFolder(googleFolderId);
  if (docs.length === 0) {
    throw new Error('No Google Docs found in the specified folder');
  }

  // Create job record
  const { data: job, error } = await supabase
    .from('newsletter_import_jobs')
    .insert({
      collection_id: collectionId,
      google_folder_id: googleFolderId,
      import_type: 'batch',
      status: 'processing',
      total_docs: docs.length,
      config: { ...config, docs: docs.map((d) => ({ id: d.id, name: d.name })) },
      created_by: createdBy,
    })
    .select('id')
    .single();

  if (error) throw new Error(`Failed to create import job: ${error.message}`);

  // Process docs sequentially (fire-and-forget — the function returns immediately)
  processBatchInBackground(supabase, job.id, collectionId, docs, config);

  return {
    job_id: job.id,
    total_docs: docs.length,
    message: 'Batch import started',
  };
}

async function processBatchInBackground(
  supabase: any,
  jobId: string,
  collectionId: string,
  docs: Array<{ id: string; name: string; createdTime: string }>,
  config: Record<string, unknown>,
) {
  const results: any[] = [];
  let completed = 0;
  let failed = 0;

  const titlePattern = config.title_pattern as string | undefined;
  const dateExtraction = config.date_extraction as string | undefined;

  for (const doc of docs) {
    try {
      // Extract date from title if configured
      let editionDate = '';
      let editionTitle = doc.name;

      if (dateExtraction === 'from_title' && titlePattern) {
        const dateMatch = extractDateFromTitle(doc.name, titlePattern);
        if (dateMatch) {
          editionDate = dateMatch;
        }
      }

      if (!editionDate) {
        // Fallback to doc creation date
        editionDate = doc.createdTime?.split('T')[0] || new Date().toISOString().split('T')[0];
      }

      const result = await importSingleDoc(
        supabase,
        collectionId,
        doc.id,
        editionDate,
        editionTitle,
        'draft',
      );

      results.push({
        doc_id: doc.id,
        doc_name: doc.name,
        edition_id: result.edition_id,
        status: 'success',
        blocks: result.blocks_created,
      });
      completed++;
    } catch (err) {
      results.push({
        doc_id: doc.id,
        doc_name: doc.name,
        edition_id: null,
        status: 'failed',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      failed++;
    }

    // Update progress
    await supabase
      .from('newsletter_import_jobs')
      .update({
        completed_count: completed,
        failed_count: failed,
        results,
      })
      .eq('id', jobId);
  }

  // Mark job as completed
  await supabase
    .from('newsletter_import_jobs')
    .update({
      status: failed === docs.length ? 'failed' : 'completed',
      completed_count: completed,
      failed_count: failed,
      results,
    })
    .eq('id', jobId);
}

function extractDateFromTitle(title: string, pattern: string): string | null {
  // Common date patterns in newsletter titles
  const datePatterns = [
    /(\w+ \d{1,2},?\s*\d{4})/,          // "March 10, 2026" or "March 10 2026"
    /(\d{1,2}\/\d{1,2}\/\d{4})/,         // "3/10/2026"
    /(\d{4}-\d{2}-\d{2})/,               // "2026-03-10"
    /(\d{1,2}\s+\w+\s+\d{4})/,           // "10 March 2026"
    /(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/, // "March 10th, 2026"
  ];

  for (const regex of datePatterns) {
    const match = title.match(regex);
    if (match) {
      try {
        const date = new Date(match[1]);
        if (!isNaN(date.getTime())) {
          return date.toISOString().split('T')[0];
        }
      } catch { /* continue */ }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // GET — poll batch import status
    if (req.method === 'GET') {
      const url = new URL(req.url);
      const jobId = url.searchParams.get('job_id');
      if (!jobId) return jsonResponse({ error: 'job_id query parameter required' }, 400);

      const { data: job, error } = await supabase
        .from('newsletter_import_jobs')
        .select('*')
        .eq('id', jobId)
        .single();

      if (error || !job) return jsonResponse({ error: 'Job not found' }, 404);

      return jsonResponse({
        job_id: job.id,
        status: job.status,
        total: job.total_docs,
        completed: job.completed_count,
        failed: job.failed_count,
        results: job.results,
      });
    }

    // POST — single or batch import
    if (req.method !== 'POST') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const body = await req.json();
    const { collection_id } = body;

    if (!collection_id) {
      return jsonResponse({ error: 'collection_id is required' }, 400);
    }

    // Verify collection exists
    const { data: collection, error: collError } = await supabase
      .from('newsletters_template_collections')
      .select('id')
      .eq('id', collection_id)
      .single();

    if (collError || !collection) {
      return jsonResponse({ error: 'Collection not found' }, 404);
    }

    // Batch import
    if (body.google_folder_id) {
      const result = await startBatchImport(
        supabase,
        collection_id,
        body.google_folder_id,
        {
          date_extraction: body.date_extraction,
          title_pattern: body.title_pattern,
        },
        body.created_by,
      );
      return jsonResponse(result);
    }

    // Single doc import
    if (body.google_doc_id) {
      // Extract doc ID from URL if a full URL was provided
      let docId = body.google_doc_id;
      const urlMatch = docId.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
      if (urlMatch) docId = urlMatch[1];

      const result = await importSingleDoc(
        supabase,
        collection_id,
        docId,
        body.edition_date || '',
        body.edition_title || '',
        body.status || 'draft',
      );

      return jsonResponse(result);
    }

    return jsonResponse({ error: 'Provide either google_doc_id or google_folder_id' }, 400);

  } catch (error: any) {
    console.error('[gdoc-import] Error:', error);

    const status =
      error.message?.includes('not found') ? 404 :
      error.message?.includes('permissions') || error.message?.includes('OAuth') ? 403 :
      error.message?.includes('no block templates') ? 422 :
      500;

    return jsonResponse({ error: error.message }, status);
  }
}

export default handler;
Deno.serve(handler);
