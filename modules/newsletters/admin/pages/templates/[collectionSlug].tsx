import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  PlusIcon,
  CubeIcon,
  PuzzlePieceIcon,
  TrashIcon,
  ArrowUpTrayIcon,
  ArrowDownTrayIcon,
  Cog6ToothIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { DetailPageHeader } from '@/components/shared/DetailPageHeader';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import { useHasModule } from '@/hooks/useModuleFeature';
import { exportTemplateAsHtml, downloadTemplateHtml } from '../../utils';

interface TemplateCollection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_default: boolean;
  metadata: Record<string, unknown>;
}

/** templates_block_defs row shape (with `block_type` aliased from `key`). */
interface BlockTemplate {
  id: string;
  /** Aliased from templates_block_defs.key. */
  block_type: string;
  name: string;
  description: string | null;
  schema: Record<string, unknown>;
  html: string | null;
  rich_text_template: string | null;
  has_bricks: boolean;
  library_id: string;
}

/** templates_brick_defs row shape (parented by block_def_id). */
interface BrickTemplate {
  id: string;
  /** Aliased from templates_brick_defs.key. */
  brick_type: string;
  name: string;
  schema: Record<string, unknown>;
  html: string | null;
  rich_text_template: string | null;
  sort_order: number;
  block_def_id: string;
}

export default function TemplateDetailPage() {
  const { collectionSlug } = useParams<{ collectionSlug: string }>();
  const navigate = useNavigate();
  const hasShortio = useHasModule('redirects-shortio');
  const hasBitly = useHasModule('redirects-bitly');

  const [collection, setCollection] = useState<TemplateCollection | null>(null);
  const [blocks, setBlocks] = useState<BlockTemplate[]>([]);
  const [bricks, setBricks] = useState<BrickTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');

  const redirectProvider = (collection?.metadata?.redirect_provider as string) || '';

  const redirectOptions = [
    { value: '', label: 'None (use full URLs)' },
    ...(hasShortio ? [{ value: 'redirects-shortio', label: 'Short.io' }] : []),
    ...(hasBitly ? [{ value: 'redirects-bitly', label: 'Bitly' }] : []),
  ];

  useEffect(() => {
    if (collectionSlug) loadCollection();
  }, [collectionSlug]);

  async function loadCollection() {
    try {
      const { data: collectionData, error: collectionError } = await supabase
        .from('newsletters_template_collections')
        .select('*')
        .eq('slug', collectionSlug)
        .single();

      if (collectionError) throw collectionError;
      setCollection(collectionData);
      setEditName(collectionData.name);

      const [blocksRes, bricksRes] = await Promise.all([
        supabase
          .from('templates_block_defs')
          .select('id, key, name, description, schema, html, rich_text_template, has_bricks, library_id, block_type:key')
          .eq('library_id', collectionData.id)
          .order('key'),
        supabase
          .from('templates_brick_defs')
          .select('id, block_def_id, key, name, schema, html, rich_text_template, sort_order, brick_type:key, templates_block_defs!inner(library_id)')
          .eq('templates_block_defs.library_id', collectionData.id)
          .order('sort_order'),
      ]);

      if (blocksRes.error) throw blocksRes.error;
      if (bricksRes.error) throw bricksRes.error;

      setBlocks(blocksRes.data || []);
      setBricks(bricksRes.data || []);
    } catch (error) {
      console.error('Error loading template:', error);
      toast.error('Failed to load template');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveName() {
    if (!collection || !editName.trim()) return;
    try {
      const { error } = await supabase
        .from('newsletters_template_collections')
        .update({ name: editName.trim() })
        .eq('id', collection.id);
      if (error) throw error;
      setCollection({ ...collection, name: editName.trim() });
      setEditingName(false);
      toast.success('Name updated');
    } catch (error) {
      console.error('Error updating name:', error);
      toast.error('Failed to update name');
    }
  }

  async function handleRedirectProviderChange(value: string) {
    if (!collection) return;
    try {
      const metadata = { ...(collection.metadata || {}), redirect_provider: value || null };
      const { error } = await supabase
        .from('newsletters_template_collections')
        .update({ metadata })
        .eq('id', collection.id);
      if (error) throw error;
      setCollection({ ...collection, metadata });
      toast.success('Redirect provider updated');
    } catch (error) {
      console.error('Error updating redirect provider:', error);
      toast.error('Failed to update redirect provider');
    }
  }

  async function handleDownload() {
    if (!collection) return;
    try {
      const html = await exportTemplateAsHtml(collection.id);
      downloadTemplateHtml(html, collection.slug);
      toast.success('Template downloaded');
    } catch (error) {
      console.error('Error downloading template:', error);
      toast.error('Failed to download template');
    }
  }

  async function handleDeleteBlock(id: string, name: string) {
    if (!confirm(`Delete block template "${name}"? This cannot be undone.`)) return;
    try {
      const { error } = await supabase.from('templates_block_defs').delete().eq('id', id);
      if (error) throw error;
      toast.success('Block template deleted');
      loadCollection();
    } catch (error) {
      console.error('Error deleting block:', error);
      toast.error('Failed to delete block template');
    }
  }

  async function handleDeleteBrick(id: string, name: string) {
    if (!confirm(`Delete brick template "${name}"? This cannot be undone.`)) return;
    try {
      const { error } = await supabase.from('templates_brick_defs').delete().eq('id', id);
      if (error) throw error;
      toast.success('Brick template deleted');
      loadCollection();
    } catch (error) {
      console.error('Error deleting brick:', error);
      toast.error('Failed to delete brick template');
    }
  }

  if (loading) {
    return (
      <Page title="Template">
        <div className="flex items-center justify-center p-12">
          <LoadingSpinner />
        </div>
      </Page>
    );
  }

  if (!collection) {
    return (
      <Page title="Template Not Found">
        <div className="p-6 text-center text-[var(--gray-10)]">
          Template not found
        </div>
      </Page>
    );
  }

  return (
    <Page title={collection.name}>
      <div className="p-6">
        {/* Header */}
        <DetailPageHeader
          title={editingName ? '' : collection.name}
          subtitle={collection.description || undefined}
          backTo="/newsletters/templates"
          badges={collection.is_default ? [{ label: 'Default', color: 'blue' }] : undefined}
          actions={
            <>
              {blocks.length > 0 && (
                <button onClick={handleDownload} className="px-3 py-1.5 text-sm font-medium rounded-md bg-white/90 backdrop-blur-md border border-white/40 text-gray-900 shadow-sm hover:bg-white transition-colors">
                  <ArrowDownTrayIcon className="w-4 h-4 inline mr-1" />
                  Download
                </button>
              )}
              <button
                onClick={() => {
                  if (blocks.length > 0 && !confirm('This will replace all block and brick templates. Existing editions are not affected. Continue?')) return;
                  navigate(`/newsletters/templates/${collectionSlug}/upload`);
                }}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-white/90 backdrop-blur-md border border-white/40 text-gray-900 shadow-sm hover:bg-white transition-colors"
              >
                <ArrowUpTrayIcon className="w-4 h-4 inline mr-1" />
                {blocks.length > 0 ? 'Re-upload' : 'Upload'}
              </button>
            </>
          }
        >
          {editingName && (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="text-lg font-semibold px-2 py-1 rounded border border-white/40 bg-white/90 text-gray-900"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveName();
                  if (e.key === 'Escape') { setEditingName(false); setEditName(collection.name); }
                }}
                autoFocus
              />
              <button onClick={handleSaveName} className="px-2 py-1 text-sm rounded bg-white/90 text-gray-900 hover:bg-white">Save</button>
              <button onClick={() => { setEditingName(false); setEditName(collection.name); }} className="px-2 py-1 text-sm rounded bg-white/20 text-white/80 hover:bg-white/30">Cancel</button>
            </div>
          )}
        </DetailPageHeader>

        {/* Settings Panel */}
        {(hasShortio || hasBitly) && (
          <Card className="p-4 mb-6">
            <div className="flex items-center gap-2 mb-3">
              <Cog6ToothIcon className="w-5 h-5 text-[var(--gray-10)]" />
              <h2 className="text-sm font-medium text-[var(--gray-12)]">Template Settings</h2>
            </div>
            <div className="max-w-sm">
              <label className="text-xs text-[var(--gray-10)] mb-1 block">
                Link Redirect Provider
              </label>
              <select
                value={redirectProvider}
                onChange={(e) => handleRedirectProviderChange(e.target.value)}
                className="w-full px-3 py-2 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm"
              >
                {redirectOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <p className="text-xs text-[var(--gray-10)] mt-1">
                Choose how links are shortened in editions using this template
              </p>
            </div>
          </Card>
        )}

        {/* Block Templates */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-[var(--gray-12)] flex items-center gap-2">
              <CubeIcon className="w-5 h-5 text-[var(--accent-9)]" />
              Block Templates
            </h2>
          </div>

          <div className="space-y-2">
            {blocks.map((block) => (
              <Card
                key={block.id}
                className="p-3 flex items-center justify-between hover:border-[var(--accent-8)] transition-colors cursor-pointer"
                onClick={() => navigate(`/newsletters/templates/${collectionSlug}/blocks/${block.block_type}`)}
              >
                <div className="flex items-center gap-3">
                  <CubeIcon className="w-4 h-4 text-[var(--gray-10)]" />
                  <div>
                    <span className="text-sm font-medium text-[var(--gray-12)]">
                      {block.name}
                    </span>
                    <span className="text-xs text-[var(--gray-10)] ml-2">
                      {block.block_type}
                    </span>
                  </div>
                  {block.has_bricks && (
                    <Badge color="gray">has bricks</Badge>
                  )}
                  {block.rich_text_template && (
                    <Badge color="gray">+ rich text</Badge>
                  )}
                </div>
                <Button
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteBlock(block.id, block.name);
                  }}
                >
                  <TrashIcon className="w-4 h-4 text-[var(--red-9)]" />
                </Button>
              </Card>
            ))}
            {blocks.length === 0 && (
              <p className="text-sm text-[var(--gray-10)] text-center py-4">
                No block templates yet — upload an HTML file to get started
              </p>
            )}
          </div>
        </div>

        {/* Brick Templates */}
        <div>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-medium text-[var(--gray-12)] flex items-center gap-2">
              <PuzzlePieceIcon className="w-5 h-5 text-[var(--accent-9)]" />
              Brick Templates
            </h2>
          </div>

          <div className="space-y-2">
            {bricks.map((brick) => (
              <Card
                key={brick.id}
                className="p-3 flex items-center justify-between hover:border-[var(--accent-8)] transition-colors cursor-pointer"
                onClick={() => navigate(`/newsletters/templates/${collectionSlug}/bricks/${brick.brick_type}`)}
              >
                <div className="flex items-center gap-3">
                  <PuzzlePieceIcon className="w-4 h-4 text-[var(--gray-10)]" />
                  <div>
                    <span className="text-sm font-medium text-[var(--gray-12)]">
                      {brick.name}
                    </span>
                    <span className="text-xs text-[var(--gray-10)] ml-2">
                      {brick.brick_type}
                    </span>
                  </div>
                  {brick.rich_text_template && (
                    <Badge color="gray">+ rich text</Badge>
                  )}
                </div>
                <Button
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteBrick(brick.id, brick.name);
                  }}
                >
                  <TrashIcon className="w-4 h-4 text-[var(--red-9)]" />
                </Button>
              </Card>
            ))}
            {bricks.length === 0 && (
              <p className="text-sm text-[var(--gray-10)] text-center py-4">
                No brick templates yet
              </p>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}
