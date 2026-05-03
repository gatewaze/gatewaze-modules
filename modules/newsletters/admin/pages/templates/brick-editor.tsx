import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  EyeIcon,
  CodeBracketIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { supabase } from '@/lib/supabase';
import { renderTemplate } from '../../utils/templateParser';

interface BrickTemplate {
  id: string;
  brick_type: string;
  name: string;
  html_template: string;
  rich_text_template: string | null;
  variant_key: string;
  schema: Record<string, unknown>;
  sort_order: number;
  collection_id: string;
}

type EditorTab = 'html' | 'rich_text' | 'schema' | 'preview';

export default function BrickEditorPage() {
  const { collectionSlug, brickType } = useParams<{
    collectionSlug: string;
    brickType: string;
  }>();
  const navigate = useNavigate();

  const [template, setTemplate] = useState<BrickTemplate | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<EditorTab>('html');

  const [htmlTemplate, setHtmlTemplate] = useState('');
  const [richTextTemplate, setRichTextTemplate] = useState('');
  const [schemaJson, setSchemaJson] = useState('{}');

  useEffect(() => {
    if (collectionSlug && brickType) loadTemplate();
  }, [collectionSlug, brickType]);

  async function loadTemplate() {
    try {
      const { data: collection, error: collErr } = await supabase
        .from('newsletters_template_collections')
        .select('id')
        .eq('slug', collectionSlug)
        .single();

      if (collErr) throw collErr;

      // templates_brick_defs is parented by block_def_id, not collection_id
      // directly. PostgREST inner-embed lets us filter by the parent
      // block_def's library_id.
      const { data, error } = await supabase
        .from('templates_brick_defs')
        .select('id, block_def_id, key, name, schema, html, rich_text_template, sort_order, templates_block_defs!inner(library_id)')
        .eq('templates_block_defs.library_id', collection.id)
        .eq('key', brickType)
        .single();

      if (error) throw error;

      setTemplate(data);
      setHtmlTemplate(data.html || '');
      setRichTextTemplate(data.rich_text_template || '');
      setSchemaJson(JSON.stringify(data.schema || {}, null, 2));
    } catch (error) {
      console.error('Error loading template:', error);
      toast.error('Failed to load brick template');
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
        .from('templates_brick_defs')
        .update({
          html: htmlTemplate,
          rich_text_template: richTextTemplate || null,
          schema: parsedSchema,
          updated_at: new Date().toISOString(),
        })
        .eq('id', template.id);

      if (error) throw error;
      toast.success('Brick template saved');
    } catch (error) {
      console.error('Error saving template:', error);
      toast.error('Failed to save template');
    } finally {
      setSaving(false);
    }
  }, [template, htmlTemplate, richTextTemplate, schemaJson]);

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
      const sampleData = generateSampleData(schemaJson);
      return renderTemplate(currentTemplate, sampleData);
    } catch (error) {
      return `<pre style="color:red">${error instanceof Error ? error.message : 'Render error'}</pre>`;
    }
  }

  if (loading) {
    return (
      <Page title="Brick Editor">
        <div className="flex items-center justify-center p-12">
          <LoadingSpinner />
        </div>
      </Page>
    );
  }

  if (!template) {
    return (
      <Page title="Brick Not Found">
        <div className="p-6 text-center text-[var(--gray-10)]">
          Brick template not found
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
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate(`/newsletters/templates/${collectionSlug}`)}
            >
              <ArrowLeftIcon className="w-4 h-4" />
            </Button>
            <div>
              <h1 className="text-lg font-semibold text-[var(--gray-12)]">
                {template.name}
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-xs text-[var(--gray-10)]">
                  {template.brick_type}
                </span>
                <Badge variant="neutral" size="sm">{template.variant_key}</Badge>
              </div>
            </div>
          </div>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </div>

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
        default:
          data[key] = `Sample ${key}`;
      }
    }

    return data;
  } catch {
    return { title: 'Sample Title', description: '<p>Sample description</p>' };
  }
}
