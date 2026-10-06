import { supabase } from '@/lib/supabase';

export interface DuplicatableEdition {
  id: string;
  title?: string | null;
  collection_id: string | null;
  preheader?: string | null;
  content_category?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Duplicate a newsletter edition into a fresh draft: copies the edition row plus
 * its LIVE blocks and bricks. Soft-deleted (deleted_at) blocks/bricks are skipped
 * so a copy mirrors exactly what the editor shows — otherwise removed blocks came
 * back as active content in the copy. Returns the new edition id.
 *
 * Shared by the editions table (EditorTab) and the newsletters dashboard so the
 * behaviour stays identical in both places.
 */
export async function duplicateEdition(edition: DuplicatableEdition): Promise<{ id: string }> {
  const sourceTitle = (edition.title || 'Untitled').trim();

  // collection_id MUST carry over or the new row is orphaned and never appears
  // under any newsletter. There is no `subject` column on newsletters_editions.
  const { data: newEdition, error: createError } = await supabase
    .from('newsletters_editions')
    .insert({
      title: `${sourceTitle} (Copy)`,
      edition_date: new Date().toISOString().split('T')[0],
      status: 'draft',
      collection_id: edition.collection_id,
      preheader: edition.preheader ?? null,
      content_category: edition.content_category ?? null,
      metadata: edition.metadata ?? {},
    })
    .select()
    .single();
  if (createError) throw createError;

  const { data: blocks, error: blocksError } = await supabase
    .from('newsletters_edition_blocks')
    .select('*')
    .eq('edition_id', edition.id)
    .is('deleted_at', null);
  if (blocksError) throw blocksError;

  for (const block of blocks || []) {
    const { data: newBlock, error: blockError } = await supabase
      .from('newsletters_edition_blocks')
      .insert({
        edition_id: newEdition.id,
        templates_block_def_id: block.templates_block_def_id,
        block_type: block.block_type,
        content: block.content,
        sort_order: block.sort_order || block.block_order,
      })
      .select()
      .single();
    if (blockError) throw blockError;

    const { data: bricks, error: bricksError } = await supabase
      .from('newsletters_edition_bricks')
      .select('*')
      .eq('block_id', block.id)
      .is('deleted_at', null);
    if (bricksError) throw bricksError;

    for (const brick of bricks || []) {
      const { error: brickError } = await supabase
        .from('newsletters_edition_bricks')
        .insert({
          block_id: newBlock.id,
          templates_brick_def_id: brick.templates_brick_def_id,
          brick_type: brick.brick_type,
          content: brick.content,
          sort_order: brick.sort_order || brick.brick_order,
        });
      if (brickError) throw brickError;
    }
  }

  return { id: newEdition.id as string };
}
