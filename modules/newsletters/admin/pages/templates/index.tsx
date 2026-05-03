import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router';
import {
  RectangleGroupIcon,
  PlusIcon,
  StarIcon,
  ArrowDownTrayIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import { exportTemplateAsHtml, downloadTemplateHtml } from '../../utils';

interface TemplateCollection {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  is_default: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  block_count?: number;
  brick_count?: number;
}

export default function TemplatesPage() {
  const navigate = useNavigate();
  const [collections, setCollections] = useState<TemplateCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);

  useEffect(() => {
    loadCollections();
  }, []);

  async function loadCollections() {
    try {
      const { data, error } = await supabase
        .from('newsletters_template_collections')
        .select('*')
        .order('is_default', { ascending: false })
        .order('name');

      if (error) throw error;

      const collectionsWithCounts = await Promise.all(
        (data || []).map(async (collection) => {
          const [blocksRes, bricksRes] = await Promise.all([
            supabase
              .from('templates_block_defs')
              .select('id', { count: 'exact', head: true })
              .eq('library_id', collection.id),
            // Bricks are parented by templates_block_defs.id, not directly
            // by library; PostgREST inner-embed lets us filter via the join.
            supabase
              .from('templates_brick_defs')
              .select('id, templates_block_defs!inner(library_id)', { count: 'exact', head: true })
              .eq('templates_block_defs.library_id', collection.id),
          ]);

          return {
            ...collection,
            block_count: blocksRes.count || 0,
            brick_count: bricksRes.count || 0,
          };
        })
      );

      setCollections(collectionsWithCounts);
    } catch (error) {
      console.error('Error loading templates:', error);
      toast.error('Failed to load templates');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) {
      toast.error('Template name is required');
      return;
    }

    setCreating(true);
    try {
      const slug = newName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const isFirst = collections.length === 0;

      const { data, error } = await supabase
        .from('newsletters_template_collections')
        .insert({
          name: newName.trim(),
          slug,
          description: newDescription.trim() || null,
          is_default: isFirst,
        })
        .select()
        .single();

      if (error) throw error;

      toast.success('Template created');
      setNewName('');
      setNewDescription('');
      setShowCreateForm(false);
      navigate(`/newsletters/templates/${data.slug}/upload`);
    } catch (error) {
      console.error('Error creating template:', error);
      toast.error('Failed to create template');
    } finally {
      setCreating(false);
    }
  }

  async function handleSetDefault(collection: TemplateCollection) {
    try {
      await supabase
        .from('newsletters_template_collections')
        .update({ is_default: false })
        .eq('is_default', true);

      const { error } = await supabase
        .from('newsletters_template_collections')
        .update({ is_default: true })
        .eq('id', collection.id);

      if (error) throw error;

      toast.success(`"${collection.name}" set as default`);
      loadCollections();
    } catch (error) {
      console.error('Error setting default:', error);
      toast.error('Failed to set default template');
    }
  }

  async function handleDelete(collection: TemplateCollection) {
    const { count, error: countError } = await supabase
      .from('newsletters_editions')
      .select('id', { count: 'exact', head: true })
      .eq('collection_id', collection.id);

    if (countError) {
      toast.error('Failed to check template usage');
      return;
    }

    if (count && count > 0) {
      toast.error(`Cannot delete — ${count} edition(s) use this template. Reassign or delete them first.`);
      return;
    }

    if (!confirm(`Delete template "${collection.name}"? This will also delete all its block and brick templates.`)) return;

    try {
      const { error } = await supabase
        .from('newsletters_template_collections')
        .delete()
        .eq('id', collection.id);

      if (error) throw error;
      toast.success('Template deleted');
      loadCollections();
    } catch (error) {
      console.error('Error deleting template:', error);
      toast.error('Failed to delete template');
    }
  }

  async function handleDownload(collection: TemplateCollection) {
    try {
      const html = await exportTemplateAsHtml(collection.id);
      downloadTemplateHtml(html, collection.slug);
      toast.success('Template downloaded');
    } catch (error) {
      console.error('Error downloading template:', error);
      toast.error('Failed to download template');
    }
  }

  if (loading) {
    return (
      <Page title="Newsletter Templates">
        <div className="flex items-center justify-center p-12">
          <LoadingSpinner />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Newsletter Templates">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
              Newsletter Templates
            </h1>
            <p className="text-[var(--gray-11)] mt-1">
              Manage newsletter templates — upload HTML, configure settings, and create editions
            </p>
          </div>
          <Button
            onClick={() => setShowCreateForm(!showCreateForm)}
            variant="primary"
          >
            <PlusIcon className="w-4 h-4 mr-2" />
            Create Template
          </Button>
        </div>

        {showCreateForm && (
          <Card className="p-4 mb-6">
            <h3 className="text-sm font-medium text-[var(--gray-12)] mb-2">
              Create New Template
            </h3>
            <div className="space-y-3">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Template name (e.g., Weekly Newsletter)"
                className="w-full px-3 py-2 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <input
                type="text"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Description (optional)"
                className="w-full px-3 py-2 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              />
              <div className="flex gap-2">
                <Button
                  onClick={handleCreate}
                  variant="primary"
                  disabled={creating || !newName.trim()}
                >
                  {creating ? 'Creating...' : 'Create & Upload HTML'}
                </Button>
                <Button
                  onClick={() => {
                    setShowCreateForm(false);
                    setNewName('');
                    setNewDescription('');
                  }}
                  variant="ghost"
                >
                  Cancel
                </Button>
              </div>
            </div>
          </Card>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {collections.map((collection) => (
            <Card
              key={collection.id}
              className="p-4 cursor-pointer hover:border-[var(--accent-8)] transition-colors"
              onClick={() => navigate(`/newsletters/templates/${collection.slug}`)}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2">
                  <RectangleGroupIcon className="w-5 h-5 text-[var(--accent-9)]" />
                  <h3 className="font-medium text-[var(--gray-12)]">
                    {collection.name}
                  </h3>
                </div>
                {collection.is_default && (
                  <Badge color="info">
                    <StarIcon className="w-3 h-3 mr-1" />
                    Default
                  </Badge>
                )}
              </div>
              {collection.description && (
                <p className="text-sm text-[var(--gray-11)] mb-3 line-clamp-2">
                  {collection.description}
                </p>
              )}
              <div className="flex gap-4 text-xs text-[var(--gray-10)] mb-3">
                <span>{collection.block_count} blocks</span>
                <span>{collection.brick_count} bricks</span>
              </div>
              <div className="flex gap-1 border-t border-[var(--gray-4)] pt-3 -mx-1">
                {(collection.block_count || 0) > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownload(collection);
                    }}
                    title="Download HTML"
                  >
                    <ArrowDownTrayIcon className="w-4 h-4" />
                  </Button>
                )}
                {!collection.is_default && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSetDefault(collection);
                    }}
                    title="Set as Default"
                  >
                    <StarIcon className="w-4 h-4" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDelete(collection);
                  }}
                  title="Delete"
                >
                  <TrashIcon className="w-4 h-4 text-[var(--red-9)]" />
                </Button>
              </div>
            </Card>
          ))}

          {collections.length === 0 && (
            <div className="col-span-full text-center py-12 text-[var(--gray-10)]">
              <RectangleGroupIcon className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="text-lg font-medium mb-1">No templates yet</p>
              <p className="text-sm mb-4">Create your first newsletter template to get started</p>
              <Button
                variant="primary"
                onClick={() => setShowCreateForm(true)}
              >
                <PlusIcon className="w-4 h-4 mr-2" />
                Create Your First Template
              </Button>
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
