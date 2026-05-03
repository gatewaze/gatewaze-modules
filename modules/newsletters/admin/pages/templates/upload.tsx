import { useState, useRef } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowUpTrayIcon,
  DocumentTextIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';
import {
  parseHtmlTemplate,
  importParsedBlocks,
  type ParseResult,
  type ParsedBlock,
} from '../../utils/htmlUploadParser';

type ImportState = 'idle' | 'parsed' | 'importing' | 'done';

export default function TemplateUploadPage() {
  const { collectionSlug } = useParams<{ collectionSlug: string }>();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [importState, setImportState] = useState<ImportState>('idle');
  const [parseResult, setParseResult] = useState<ParseResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [variantKey, setVariantKey] = useState('html_template');
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: string[] } | null>(null);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setFileName(file.name);

    try {
      const html = await file.text();
      const result = parseHtmlTemplate(html);
      setParseResult(result);
      setImportState('parsed');

      if (result.errors.length > 0) {
        toast.warning(`Parsed with ${result.errors.length} warning(s)`);
      } else {
        toast.success(`Found ${result.blocks.length} blocks`);
      }
    } catch (error) {
      toast.error('Failed to parse HTML file');
      console.error(error);
    }
  }

  async function handleImport() {
    if (!parseResult || !collectionSlug) return;

    setImportState('importing');

    try {
      // Get collection ID from slug
      const { data: collection, error: collErr } = await supabase
        .from('newsletters_template_collections')
        .select('id')
        .eq('slug', collectionSlug)
        .single();

      if (collErr) throw collErr;

      const result = await importParsedBlocks(
        supabase,
        collection.id,
        parseResult,
        variantKey
      );

      setImportResult(result);
      setImportState('done');

      if (result.errors.length > 0) {
        toast.warning(`Import completed with ${result.errors.length} error(s)`);
      } else {
        toast.success(`Imported ${result.created} new, updated ${result.updated} existing`);
      }
    } catch (error) {
      console.error('Import error:', error);
      toast.error('Failed to import templates');
      setImportState('parsed');
    }
  }

  function handleReset() {
    setImportState('idle');
    setParseResult(null);
    setFileName('');
    setImportResult(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }

  return (
    <Page title="Upload HTML Template">
      <div className="p-6 max-w-3xl">
        {/* Header */}
        <div className="mb-6">
          <button
            onClick={() => navigate(`/newsletters/templates/${collectionSlug}`)}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md bg-[var(--gray-a3)] border border-[var(--gray-a5)] text-[var(--gray-11)] hover:bg-[var(--gray-a4)] transition-colors mb-3"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
            Back
          </button>
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Upload HTML Template
          </h1>
          <p className="text-[var(--gray-11)] mt-1">
            Upload an HTML file with block comment delimiters to auto-parse into templates
          </p>
        </div>

        {/* Instructions */}
        <Card className="p-4 mb-6 bg-[var(--accent-a2)]">
          <h3 className="text-sm font-medium text-[var(--gray-12)] mb-2">Expected Format</h3>
          <pre className="text-xs text-[var(--gray-11)] overflow-x-auto whitespace-pre">{`<!-- BLOCK:header -->
<table width="100%">...</table>
<!-- /BLOCK:header -->

<!-- BLOCK:community | has_bricks=true -->
<table width="100%">
  {{bricks}}
</table>
  <!-- BRICK:podcast -->
  <h3>{{title}}</h3>
  <!-- /BRICK:podcast -->
<!-- /BLOCK:community -->`}</pre>
        </Card>

        {/* File Upload */}
        {importState === 'idle' && (
          <Card className="p-8 text-center border-dashed border-2 border-[var(--gray-6)]">
            <ArrowUpTrayIcon className="w-10 h-10 mx-auto mb-3 text-[var(--gray-9)]" />
            <p className="text-sm text-[var(--gray-11)] mb-4">
              Choose an HTML file to parse
            </p>
            <input
              ref={fileInputRef}
              type="file"
              accept=".html,.htm"
              onChange={handleFileSelect}
              className="hidden"
            />
            <Button
              variant="primary"
              onClick={() => fileInputRef.current?.click()}
            >
              Select HTML File
            </Button>
          </Card>
        )}

        {/* Parse Preview */}
        {importState === 'parsed' && parseResult && (
          <div className="space-y-4">
            <Card className="p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <DocumentTextIcon className="w-5 h-5 text-[var(--accent-9)]" />
                  <span className="text-sm font-medium text-[var(--gray-12)]">{fileName}</span>
                </div>
                <Button variant="ghost" size="sm" onClick={handleReset}>
                  Change File
                </Button>
              </div>

              {parseResult.errors.length > 0 && (
                <div className="mb-3 p-3 rounded bg-[var(--red-a2)] text-sm text-[var(--red-11)]">
                  {parseResult.errors.map((err, i) => (
                    <p key={i}>{err}</p>
                  ))}
                </div>
              )}

              <div className="text-sm text-[var(--gray-11)] mb-3">
                Found {parseResult.blocks.length} block(s) with{' '}
                {parseResult.blocks.reduce((sum, b) => sum + b.bricks.length, 0)} brick(s)
              </div>

              {/* Block list preview */}
              <div className="space-y-2">
                {parseResult.blocks.map((block, i) => (
                  <BlockPreview key={i} block={block} />
                ))}
              </div>
            </Card>

            {/* Variant selector */}
            <Card className="p-4">
              <label className="text-sm font-medium text-[var(--gray-12)] block mb-2">
                Template Variant
              </label>
              <select
                value={variantKey}
                onChange={(e) => setVariantKey(e.target.value)}
                className="px-3 py-2 rounded-md border border-[var(--gray-6)] bg-[var(--gray-1)] text-[var(--gray-12)] text-sm"
              >
                <option value="html_template">HTML Template (email)</option>
                <option value="rich_text_template">Rich Text Template (Substack/Beehiiv)</option>
              </select>
              <p className="text-xs text-[var(--gray-10)] mt-1">
                Which template variant to save. Existing templates with the same type and variant will be updated.
              </p>
            </Card>

            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={handleImport}
                disabled={parseResult.blocks.length === 0}
              >
                Import {parseResult.blocks.length} Block(s)
              </Button>
              <Button variant="ghost" onClick={handleReset}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Importing */}
        {importState === 'importing' && (
          <Card className="p-8 text-center">
            <div className="animate-spin w-8 h-8 border-2 border-[var(--accent-9)] border-t-transparent rounded-full mx-auto mb-3" />
            <p className="text-sm text-[var(--gray-11)]">Importing templates...</p>
          </Card>
        )}

        {/* Done */}
        {importState === 'done' && importResult && (
          <Card className="p-6">
            <div className="flex items-center gap-2 mb-4">
              <CheckCircleIcon className="w-6 h-6 text-[var(--green-9)]" />
              <h3 className="text-lg font-medium text-[var(--gray-12)]">Import Complete</h3>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="p-3 rounded bg-[var(--green-a2)]">
                <p className="text-2xl font-semibold text-[var(--green-9)]">{importResult.created}</p>
                <p className="text-xs text-[var(--gray-10)]">Created</p>
              </div>
              <div className="p-3 rounded bg-[var(--accent-a2)]">
                <p className="text-2xl font-semibold text-[var(--accent-9)]">{importResult.updated}</p>
                <p className="text-xs text-[var(--gray-10)]">Updated</p>
              </div>
            </div>

            {importResult.errors.length > 0 && (
              <div className="mb-4 p-3 rounded bg-[var(--red-a2)]">
                <div className="flex items-center gap-1 mb-1">
                  <ExclamationTriangleIcon className="w-4 h-4 text-[var(--red-9)]" />
                  <span className="text-sm font-medium text-[var(--red-11)]">Errors</span>
                </div>
                {importResult.errors.map((err, i) => (
                  <p key={i} className="text-xs text-[var(--red-11)]">{err}</p>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                variant="primary"
                onClick={() => navigate(`/newsletters/templates/${collectionSlug}`)}
              >
                View Collection
              </Button>
              <Button variant="ghost" onClick={handleReset}>
                Upload Another
              </Button>
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}

function BlockPreview({ block }: { block: ParsedBlock }) {
  const schemaProps = (block.schema as any)?.properties;
  const fieldCount = schemaProps ? Object.keys(schemaProps).length : 0;

  return (
    <div className="p-2 rounded border border-[var(--gray-4)] text-sm">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium text-[var(--gray-12)]">{block.name}</span>
        <span className="text-xs text-[var(--gray-9)]">{block.blockType}</span>
        {block.hasBricks && (
          <Badge color="cyan">{block.bricks.length} bricks</Badge>
        )}
        {fieldCount > 0 && (
          <Badge color="gray">{fieldCount} fields</Badge>
        )}
      </div>
      {block.description && (
        <p className="text-xs text-[var(--gray-10)] mt-1">{block.description}</p>
      )}
      {block.bricks.length > 0 && (
        <div className="ml-4 mt-1 space-y-1">
          {block.bricks.map((brick, i) => {
            const brickProps = (brick.schema as any)?.properties;
            const brickFieldCount = brickProps ? Object.keys(brickProps).length : 0;
            return (
              <div key={i} className="text-xs text-[var(--gray-10)]">
                ↳ {brick.name} ({brick.brickType}){brickFieldCount > 0 ? ` — ${brickFieldCount} fields` : ''}{brick.richTextHtml ? ' + rich text' : ''}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
