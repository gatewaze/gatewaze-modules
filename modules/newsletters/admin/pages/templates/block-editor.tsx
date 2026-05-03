import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  EyeIcon,
  CodeBracketIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { DetailPageHeader } from '@/components/shared/DetailPageHeader';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import { renderTemplate } from '../../utils/templateParser';

interface BlockTemplate {
  id: string;
  block_type: string;
  name: string;
  html_template: string;
  rich_text_template: string | null;
  variant_key: string;
  has_bricks: boolean;
  schema: Record<string, unknown>;
  sort_order: number;
  collection_id: string;
}

type EditorTab = 'html' | 'rich_text' | 'schema' | 'preview';

export default function BlockEditorPage() {
  const { collectionSlug, blockType } = useParams<{
    collectionSlug: string;
    blockType: string;
  }>();
  const navigate = useNavigate();

  const [template, setTemplate] = useState<BlockTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<EditorTab>('html');

  const [htmlTemplate, setHtmlTemplate] = useState('');
  const [richTextTemplate, setRichTextTemplate] = useState('');
  const [schemaJson, setSchemaJson] = useState('{}');
  const [hasBricks, setHasBricks] = useState(false);

  useEffect(() => {
    if (collectionSlug && blockType) loadTemplate();
  }, [collectionSlug, blockType]);

  async function loadTemplate() {
    try {
      // First get the collection
      const { data: collection, error: collErr } = await supabase
        .from('newsletters_template_collections')
        .select('id')
        .eq('slug', collectionSlug)
        .single();

      if (collErr) throw collErr;

      const { data, error } = await supabase
        .from('templates_block_defs')
        .select('id, key, name, description, schema, html, rich_text_template, has_bricks, library_id')
        .eq('library_id', collection.id)
        .eq('key', blockType)
        .single();

      if (error) throw error;

      setTemplate(data);
      setHtmlTemplate(data.html || '');
      setRichTextTemplate(data.rich_text_template || '');
      setSchemaJson(JSON.stringify(data.schema || {}, null, 2));
      setHasBricks(data.has_bricks || false);
    } catch (error) {
      console.error('Error loading template:', error);
      toast.error('Failed to load block template');
    } finally {
      setLoading(false);
    }
  }

  const handleSave = useCallback(async () => {
    if (!template) return;

    setSaving(true);
    try {
      let parsedSchema: Record<string, unknown> = {};
      try {
        parsedSchema = JSON.parse(schemaJson);
      } catch {
        toast.error('Invalid JSON in schema');
        setSaving(false);
        return;
      }

      const { error } = await supabase
        .from('templates_block_defs')
        .update({
          html: htmlTemplate,
          rich_text_template: richTextTemplate || null,
          schema: parsedSchema,
          has_bricks: hasBricks,
          updated_at: new Date().toISOString(),
        })
        .eq('id', template.id);

      if (error) throw error;
      toast.success('Block template saved');
    } catch (error) {
      console.error('Error saving template:', error);
      toast.error('Failed to save template');
    } finally {
      setSaving(false);
    }
  }, [template, htmlTemplate, richTextTemplate, schemaJson, hasBricks]);

  // Keyboard shortcut: Cmd+S to save
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  function getPreviewHtml(): string {
    const currentTemplate = activeTab === 'rich_text' ? richTextTemplate : htmlTemplate;
    if (!currentTemplate) return '<p style="color:#999">No template content</p>';

    try {
      // Generate sample data from schema
      const sampleData = generateSampleData(schemaJson);
      return renderTemplate(currentTemplate, sampleData);
    } catch (error) {
      return `<pre style="color:red">${error instanceof Error ? error.message : 'Render error'}</pre>`;
    }
  }

  if (loading) {
    return (
      <Page title="Block Editor">
        <div className="flex items-center justify-center p-12">
          <LoadingSpinner />
        </div>
      </Page>
    );
  }

  if (!template) {
    return (
      <Page title="Block Not Found">
        <div className="p-6 text-center text-[var(--gray-10)]">
          Block template not found
        </div>
      </Page>
    );
  }

  const tabs: { id: EditorTab; label: string }[] = [
    { id: 'html', label: 'HTML Template' },
    { id: 'rich_text', label: 'Rich Text Template' },
    { id: 'schema', label: 'Schema' },
    { id: 'preview', label: 'Preview' },
  ];

  return (
    <Page title={`Edit: ${template.name}`}>
      <div className="p-6 h-full flex flex-col">
        <DetailPageHeader
          title={template.name}
          subtitle={template.block_type}
          backTo={`/newsletters/templates/${collectionSlug}`}
          badges={[{ label: template.variant_key, color: 'blue' }]}
          actions={
            <>
              <label className="flex items-center gap-2 text-sm text-white/70">
                <input
                  type="checkbox"
                  checked={hasBricks}
                  onChange={(e) => setHasBricks(e.target.checked)}
                  className="rounded"
                />
                Has Bricks
              </label>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-3 py-1.5 text-sm font-medium rounded-md bg-white/90 backdrop-blur-md border border-white/40 text-gray-900 shadow-sm hover:bg-white transition-colors disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </>
          }
        />

        {/* Tabs */}
        <div className="flex gap-1 mb-4 border-b border-[var(--gray-4)]">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-[var(--accent-9)] text-[var(--accent-11)]'
                  : 'border-transparent text-[var(--gray-10)] hover:text-[var(--gray-12)]'
              }`}
            >
              {tab.id === 'preview' && <EyeIcon className="w-4 h-4 inline mr-1" />}
              {tab.id === 'html' && <CodeBracketIcon className="w-4 h-4 inline mr-1" />}
              {tab.label}
            </button>
          ))}
        </div>

        {/* Editor Content */}
        <div className="flex-1 min-h-0">
          {activeTab === 'html' && (
            <textarea
              value={htmlTemplate}
              onChange={(e) => setHtmlTemplate(e.target.value)}
              className="w-full h-full min-h-[500px] px-4 py-3 font-mono text-sm rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] resize-none focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              spellCheck={false}
            />
          )}

          {activeTab === 'rich_text' && (
            <textarea
              value={richTextTemplate}
              onChange={(e) => setRichTextTemplate(e.target.value)}
              placeholder="Optional rich text template for Substack/Beehiiv output"
              className="w-full h-full min-h-[500px] px-4 py-3 font-mono text-sm rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] resize-none focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              spellCheck={false}
            />
          )}

          {activeTab === 'schema' && (
            <textarea
              value={schemaJson}
              onChange={(e) => setSchemaJson(e.target.value)}
              className="w-full h-full min-h-[500px] px-4 py-3 font-mono text-sm rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] resize-none focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]"
              spellCheck={false}
            />
          )}

          {activeTab === 'preview' && (
            <div className="border border-[var(--gray-6)] rounded-md overflow-hidden h-full min-h-[500px]">
              <iframe
                srcDoc={getPreviewHtml()}
                className="w-full h-full min-h-[500px]"
                sandbox="allow-same-origin"
                title="Template Preview"
              />
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}

/**
 * Generate sample data from a schema JSON for preview rendering
 */
function generateSampleData(schemaJson: string): Record<string, unknown> {
  try {
    const schema = JSON.parse(schemaJson);
    const data: Record<string, unknown> = {};

    for (const [key, def] of Object.entries(schema)) {
      const fieldDef = def as Record<string, unknown>;
      const type = fieldDef.type as string;

      switch (type) {
        case 'string':
        case 'text':
        case 'richtext':
          data[key] = fieldDef.placeholder || fieldDef.default || `Sample ${key}`;
          break;
        case 'url':
          data[key] = fieldDef.default || 'https://example.com';
          break;
        case 'image':
          data[key] = fieldDef.default || 'https://via.placeholder.com/600x300';
          break;
        case 'boolean':
          data[key] = fieldDef.default ?? true;
          break;
        case 'number':
          data[key] = fieldDef.default ?? 1;
          break;
        case 'array':
          data[key] = [
            generateSampleData(JSON.stringify(fieldDef.items || {})),
            generateSampleData(JSON.stringify(fieldDef.items || {})),
          ];
          break;
        default:
          data[key] = `Sample ${key}`;
      }
    }

    return data;
  } catch {
    return { title: 'Sample Title', body: '<p>Sample body content</p>' };
  }
}
