import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import { Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { EditionCanvas } from '@/components/newsletters/EditionCanvas';
import { supabase } from '@/lib/supabase';
import {
  type NewsletterEdition,
  type EditionBlock,
  type BlockTemplate,
  type BrickTemplate,
} from '@/utils/newsletter';

interface DbBlockTemplate {
  id: string;
  name: string;
  block_type: string;
  description: string | null;
  html_template: string;
  rich_text_template: string | null;
  has_bricks: boolean;
  schema: Record<string, unknown>;
  sort_order: number;
}

interface DbBrickTemplate {
  id: string;
  name: string;
  brick_type: string;
  html_template: string;
  rich_text_template: string | null;
  schema: Record<string, unknown>;
  block_template_id: string;
}

interface DbEditionBlock {
  id: string;
  edition_id: string;
  block_template_id: string;
  content: Record<string, unknown>;
  sort_order: number;
  block_template: DbBlockTemplate;
}

interface DbEditionBrick {
  id: string;
  edition_block_id: string;
  brick_template_id: string;
  content: Record<string, unknown>;
  sort_order: number;
  brick_template: DbBrickTemplate;
}

export default function EditionEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [edition, setEdition] = useState<NewsletterEdition | null>(null);
  const [blockTemplates, setBlockTemplates] = useState<(DbBlockTemplate & BlockTemplate)[]>([]);
  const [brickTemplates, setBrickTemplates] = useState<BrickTemplate[]>([]);

  // Load block and brick templates
  const loadTemplates = useCallback(async () => {
    try {
      const [blocksRes, bricksRes] = await Promise.all([
        supabase
          .from('newsletters_block_templates')
          .select('*')
          .eq('is_active', true)
          .order('sort_order'),
        supabase
          .from('newsletters_brick_templates')
          .select('*')
          .eq('is_active', true)
          .order('sort_order'),
      ]);

      if (blocksRes.error) throw blocksRes.error;
      if (bricksRes.error) throw bricksRes.error;

      setBlockTemplates(blocksRes.data || []);
      setBrickTemplates(bricksRes.data || []);
    } catch (error) {
      console.error('Error loading templates:', error);
      toast.error('Failed to load templates');
    }
  }, []);

  // Load edition data
  const loadEdition = useCallback(async () => {
    if (isNew) {
      // Create a new empty edition
      setEdition({
        id: 'new',
        edition_date: new Date().toISOString().split('T')[0],
        subject: '',
        preheader: '',
        blocks: [],
      });
      setLoading(false);
      return;
    }

    try {
      // Load edition
      const { data: editionData, error: editionError } = await supabase
        .from('newsletters_editions')
        .select('*')
        .eq('id', id)
        .single();

      if (editionError) throw editionError;

      // Load blocks with their templates
      const { data: blocksData, error: blocksError } = await supabase
        .from('newsletters_edition_blocks')
        .select(`
          *,
          block_template:newsletter_block_templates(*)
        `)
        .eq('edition_id', id)
        .order('sort_order');

      if (blocksError) throw blocksError;

      // Load bricks for all blocks
      const blockIds = (blocksData || []).map((b: DbEditionBlock) => b.id);
      let bricksData: DbEditionBrick[] = [];

      if (blockIds.length > 0) {
        const { data: bricks, error: bricksError } = await supabase
          .from('newsletters_edition_bricks')
          .select(`
            *,
            brick_template:newsletter_brick_templates(*)
          `)
          .in('edition_block_id', blockIds)
          .order('sort_order');

        if (bricksError) throw bricksError;
        bricksData = bricks || [];
      }

      // Transform data to match our types
      const blocks: EditionBlock[] = (blocksData || []).map((block: DbEditionBlock) => ({
        id: block.id,
        block_template: block.block_template,
        content: block.content || {},
        sort_order: block.sort_order,
        bricks: bricksData
          .filter((brick: DbEditionBrick) => brick.edition_block_id === block.id)
          .map((brick: DbEditionBrick) => ({
            id: brick.id,
            brick_template: brick.brick_template,
            content: brick.content || {},
            sort_order: brick.sort_order,
          })),
      }));

      setEdition({
        id: editionData.id,
        edition_date: editionData.edition_date,
        subject: editionData.subject || '',
        preheader: editionData.preheader || '',
        blocks,
      });
    } catch (error) {
      console.error('Error loading edition:', error);
      toast.error('Failed to load edition');
      navigate('/newsletters/editor');
    } finally {
      setLoading(false);
    }
  }, [id, isNew, navigate]);

  useEffect(() => {
    loadTemplates();
    loadEdition();
  }, [loadTemplates, loadEdition]);

  // Save edition
  const handleSave = async () => {
    if (!edition) return;

    try {
      setSaving(true);

      if (isNew) {
        // Create new edition
        const { data: newEdition, error: createError } = await supabase
          .from('newsletters_editions')
          .insert({
            edition_date: edition.edition_date,
            subject: edition.subject || null,
            preheader: edition.preheader || null,
            status: 'draft',
          })
          .select()
          .single();

        if (createError) throw createError;

        // Create blocks
        for (const block of edition.blocks) {
          const { data: newBlock, error: blockError } = await supabase
            .from('newsletters_edition_blocks')
            .insert({
              edition_id: newEdition.id,
              block_template_id: block.block_template.id,
              content: block.content,
              sort_order: block.sort_order,
            })
            .select()
            .single();

          if (blockError) throw blockError;

          // Create bricks
          for (const brick of block.bricks) {
            const { error: brickError } = await supabase
              .from('newsletters_edition_bricks')
              .insert({
                edition_block_id: newBlock.id,
                brick_template_id: brick.brick_template.id,
                content: brick.content,
                sort_order: brick.sort_order,
              });

            if (brickError) throw brickError;
          }
        }

        toast.success('Edition created successfully');
        navigate(`/newsletters/editor/${newEdition.id}`);
      } else {
        // Update existing edition
        const { error: updateError } = await supabase
          .from('newsletters_editions')
          .update({
            edition_date: edition.edition_date,
            subject: edition.subject || null,
            preheader: edition.preheader || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', edition.id);

        if (updateError) throw updateError;

        // Delete existing blocks and bricks
        const { error: deleteError } = await supabase
          .from('newsletters_edition_blocks')
          .delete()
          .eq('edition_id', edition.id);

        if (deleteError) throw deleteError;

        // Recreate blocks and bricks
        // Note: block_id/brick_id on newsletter_edition_links use ON DELETE SET NULL,
        // so existing links survive this delete+recreate cycle.
        // The link URL replacement only uses originalUrl matching, not block/brick IDs.
        for (const block of edition.blocks) {
          const { data: newBlock, error: blockError } = await supabase
            .from('newsletters_edition_blocks')
            .insert({
              edition_id: edition.id,
              block_template_id: block.block_template.id,
              content: block.content,
              sort_order: block.sort_order,
            })
            .select()
            .single();

          if (blockError) throw blockError;

          // Create bricks
          for (const brick of block.bricks) {
            const { error: brickError } = await supabase
              .from('newsletters_edition_bricks')
              .insert({
                edition_block_id: newBlock.id,
                brick_template_id: brick.brick_template.id,
                content: brick.content,
                sort_order: brick.sort_order,
              });

            if (brickError) throw brickError;
          }
        }

        toast.success('Edition saved successfully');

        // Reload the edition to get the new block IDs
        await loadEdition();
      }
    } catch (error) {
      console.error('Error saving edition:', error);
      toast.error('Failed to save edition');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Page title="Loading...">
        <div className="flex items-center justify-center h-96">
          <LoadingSpinner size="large" />
        </div>
      </Page>
    );
  }

  if (!edition) {
    return (
      <Page title="Not Found">
        <div className="flex flex-col items-center justify-center h-96">
          <p className="text-gray-500 dark:text-gray-400 mb-4">Edition not found</p>
          <Button onClick={() => navigate('/newsletters/editor')}>
            Back to Editor
          </Button>
        </div>
      </Page>
    );
  }

  return (
    <Page title={edition.subject || 'Newsletter Edition'}>
      <div className="h-[calc(100vh-80px)] flex flex-col">
        {/* Top Navigation Bar */}
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 flex items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => navigate('/newsletters/editor')}
          >
            <ArrowLeftIcon className="w-4 h-4" />
            Back to Editions
          </Button>
        </div>

        {/* Main Editor Canvas */}
        <div className="flex-1 overflow-hidden p-4">
          <EditionCanvas
            edition={edition}
            blockTemplates={blockTemplates}
            brickTemplates={brickTemplates}
            onChange={setEdition}
            onSave={handleSave}
            isSaving={saving}
          />
        </div>
      </div>
    </Page>
  );
}
