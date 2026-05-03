/**
 * Google Doc Import Tab
 * Allows importing historical newsletters from Google Docs into the block editor.
 * Supports single doc import and batch import from a Drive folder.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  DocumentArrowDownIcon,
  FolderIcon,
  CheckCircleIcon,
  XCircleIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { useNavigate } from 'react-router';
import { Card, Badge } from '@/components/ui';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Form/Input';

interface GDocImportTabProps {
  newsletterId: string;
  newsletterSlug: string;
}

interface ImportResult {
  edition_id?: string;
  blocks_created?: number;
  bricks_created?: number;
  images_imported?: number;
  unmapped_sections?: string[];
  warnings?: string[];
  error?: string;
}

interface BatchJobStatus {
  job_id: string;
  status: string;
  total: number;
  completed: number;
  failed: number;
  results: Array<{
    doc_id: string;
    doc_name: string;
    edition_id: string | null;
    status: string;
    blocks?: number;
    error?: string;
  }>;
}

export function GDocImportTab({ newsletterId, newsletterSlug }: GDocImportTabProps) {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'single' | 'batch'>('single');

  // Single import state
  const [docUrl, setDocUrl] = useState('');
  const [editionDate, setEditionDate] = useState('');
  const [editionTitle, setEditionTitle] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);

  // Batch import state
  const [folderUrl, setFolderUrl] = useState('');
  const [titlePattern, setTitlePattern] = useState('');
  const [batchJob, setBatchJob] = useState<BatchJobStatus | null>(null);
  const [startingBatch, setStartingBatch] = useState(false);

  const apiUrl = (import.meta as any).env?.VITE_API_URL ?? '';

  const getHeaders = () => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${(window as any).__supabase_session?.access_token || ''}`,
  });

  // Extract Google Doc ID from URL
  const extractDocId = (url: string): string => {
    const match = url.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : url;
  };

  // Extract Google Folder ID from URL
  const extractFolderId = (url: string): string => {
    const match = url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
    return match ? match[1] : url;
  };

  // Single doc import
  const handleSingleImport = async () => {
    if (!docUrl.trim()) {
      toast.error('Please enter a Google Doc URL or ID');
      return;
    }

    setImporting(true);
    setImportResult(null);

    try {
      const supabaseUrl = (import.meta as any).env?.VITE_SUPABASE_URL ?? '';
      const supabaseKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY ?? '';

      const response = await fetch(`${supabaseUrl}/functions/v1/newsletter-gdoc-import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          collection_id: newsletterId,
          google_doc_id: extractDocId(docUrl),
          edition_date: editionDate || undefined,
          edition_title: editionTitle || undefined,
          status: 'draft',
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setImportResult({ error: data.error || 'Import failed' });
        toast.error(data.error || 'Import failed');
      } else {
        setImportResult(data);
        toast.success(`Imported ${data.blocks_created} blocks and ${data.bricks_created} bricks`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Import failed';
      setImportResult({ error: msg });
      toast.error(msg);
    } finally {
      setImporting(false);
    }
  };

  // Batch import
  const handleBatchImport = async () => {
    if (!folderUrl.trim()) {
      toast.error('Please enter a Google Drive folder URL or ID');
      return;
    }

    setStartingBatch(true);

    try {
      const supabaseUrl = (import.meta as any).env?.VITE_SUPABASE_URL ?? '';
      const supabaseKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY ?? '';

      const response = await fetch(`${supabaseUrl}/functions/v1/newsletter-gdoc-import`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          collection_id: newsletterId,
          google_folder_id: extractFolderId(folderUrl),
          date_extraction: 'from_title',
          title_pattern: titlePattern || undefined,
          status: 'draft',
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        toast.error(data.error || 'Batch import failed');
      } else {
        setBatchJob({
          job_id: data.job_id,
          status: 'processing',
          total: data.total_docs,
          completed: 0,
          failed: 0,
          results: [],
        });
        toast.success(`Batch import started for ${data.total_docs} documents`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Batch import failed');
    } finally {
      setStartingBatch(false);
    }
  };

  // Poll batch status
  const pollBatchStatus = useCallback(async () => {
    if (!batchJob?.job_id || batchJob.status === 'completed' || batchJob.status === 'failed') return;

    try {
      const supabaseUrl = (import.meta as any).env?.VITE_SUPABASE_URL ?? '';
      const supabaseKey = (import.meta as any).env?.VITE_SUPABASE_ANON_KEY ?? '';

      const response = await fetch(
        `${supabaseUrl}/functions/v1/newsletter-gdoc-import?job_id=${batchJob.job_id}`,
        { headers: { Authorization: `Bearer ${supabaseKey}` } },
      );

      if (response.ok) {
        const data = await response.json();
        setBatchJob(data);

        if (data.status === 'completed') {
          toast.success(`Batch import complete: ${data.completed} succeeded, ${data.failed} failed`);
        } else if (data.status === 'failed') {
          toast.error('Batch import failed');
        }
      }
    } catch { /* ignore polling errors */ }
  }, [batchJob?.job_id, batchJob?.status]);

  useEffect(() => {
    if (batchJob?.status === 'processing') {
      const interval = setInterval(pollBatchStatus, 3000);
      return () => clearInterval(interval);
    }
  }, [batchJob?.status, pollBatchStatus]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--gray-12)]">Import from Google Docs</h2>
        <p className="mt-1 text-sm text-[var(--gray-11)]">
          Import historical newsletters from Google Docs. The AI will analyze the document structure
          and map sections to your newsletter template blocks.
        </p>
      </div>

      {/* Mode switcher */}
      <div className="flex gap-2">
        <button
          onClick={() => setMode('single')}
          className={`px-4 py-2 text-sm font-medium rounded-lg flex items-center gap-2 transition-colors ${
            mode === 'single'
              ? 'bg-[var(--accent-a3)] text-[var(--accent-11)] ring-1 ring-[var(--accent-7)]'
              : 'text-[var(--gray-11)] hover:bg-[var(--gray-a3)]'
          }`}
        >
          <DocumentArrowDownIcon className="size-4" />
          Single Document
        </button>
        <button
          onClick={() => setMode('batch')}
          className={`px-4 py-2 text-sm font-medium rounded-lg flex items-center gap-2 transition-colors ${
            mode === 'batch'
              ? 'bg-[var(--accent-a3)] text-[var(--accent-11)] ring-1 ring-[var(--accent-7)]'
              : 'text-[var(--gray-11)] hover:bg-[var(--gray-a3)]'
          }`}
        >
          <FolderIcon className="size-4" />
          Batch Import (Folder)
        </button>
      </div>

      {/* Single import */}
      {mode === 'single' && (
        <Card className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
              Google Doc URL or ID
            </label>
            <Input
              value={docUrl}
              onChange={(e) => setDocUrl(e.target.value)}
              placeholder="https://docs.google.com/document/d/... or document ID"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
                Edition Date
              </label>
              <Input
                type="date"
                value={editionDate}
                onChange={(e) => setEditionDate(e.target.value)}
              />
              <p className="mt-1 text-xs text-[var(--gray-a9)]">Leave blank to auto-detect from content</p>
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
                Edition Title
              </label>
              <Input
                value={editionTitle}
                onChange={(e) => setEditionTitle(e.target.value)}
                placeholder="Auto-populated from doc title"
              />
            </div>
          </div>

          <Button
            onClick={handleSingleImport}
            disabled={importing || !docUrl.trim()}
          >
            {importing ? (
              <>
                <ArrowPathIcon className="size-4 mr-2 animate-spin" />
                Importing...
              </>
            ) : (
              <>
                <DocumentArrowDownIcon className="size-4 mr-2" />
                Import Document
              </>
            )}
          </Button>

          {/* Import result */}
          {importResult && (
            <div className={`mt-4 p-4 rounded-lg border ${
              importResult.error
                ? 'bg-red-500/10 border-red-500/20'
                : 'bg-green-500/10 border-green-500/20'
            }`}>
              {importResult.error ? (
                <div className="flex items-start gap-2">
                  <XCircleIcon className="size-5 text-red-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-red-500">Import Failed</p>
                    <p className="text-sm text-[var(--gray-11)] mt-1">{importResult.error}</p>
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-start gap-2">
                    <CheckCircleIcon className="size-5 text-green-500 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-sm font-medium text-green-500">Import Successful</p>
                      <p className="text-sm text-[var(--gray-11)] mt-1">
                        Created {importResult.blocks_created} blocks and {importResult.bricks_created} bricks
                        {importResult.images_imported ? `, imported ${importResult.images_imported} images` : ''}
                      </p>
                    </div>
                  </div>

                  {importResult.unmapped_sections && importResult.unmapped_sections.length > 0 && (
                    <div className="text-sm text-amber-500">
                      <p className="font-medium">Unmapped sections:</p>
                      <ul className="list-disc list-inside mt-1">
                        {importResult.unmapped_sections.map((s, i) => <li key={i}>{s}</li>)}
                      </ul>
                    </div>
                  )}

                  {importResult.warnings && importResult.warnings.length > 0 && (
                    <div className="text-sm text-amber-500">
                      <p className="font-medium">Warnings:</p>
                      <ul className="list-disc list-inside mt-1">
                        {importResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="1"
                    onClick={() => navigate(`/newsletters/${newsletterSlug}/editions/${importResult.edition_id}`)}
                  >
                    Open in Editor
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Batch import */}
      {mode === 'batch' && (
        <Card className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
              Google Drive Folder URL or ID
            </label>
            <Input
              value={folderUrl}
              onChange={(e) => setFolderUrl(e.target.value)}
              placeholder="https://drive.google.com/drive/folders/... or folder ID"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">
              Title Pattern (optional)
            </label>
            <Input
              value={titlePattern}
              onChange={(e) => setTitlePattern(e.target.value)}
              placeholder='e.g., "AAIF Weekly — {date}"'
            />
            <p className="mt-1 text-xs text-[var(--gray-a9)]">
              Used to extract edition dates from document titles
            </p>
          </div>

          <Button
            onClick={handleBatchImport}
            disabled={startingBatch || !folderUrl.trim() || batchJob?.status === 'processing'}
          >
            {startingBatch ? (
              <>
                <ArrowPathIcon className="size-4 mr-2 animate-spin" />
                Starting...
              </>
            ) : (
              <>
                <FolderIcon className="size-4 mr-2" />
                Start Batch Import
              </>
            )}
          </Button>

          {/* Batch progress */}
          {batchJob && (
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  {batchJob.status === 'processing' && (
                    <ArrowPathIcon className="size-4 text-[var(--accent-9)] animate-spin" />
                  )}
                  <span className="text-sm font-medium text-[var(--gray-12)]">
                    {batchJob.status === 'processing' ? 'Importing...' :
                     batchJob.status === 'completed' ? 'Import Complete' : 'Import Failed'}
                  </span>
                </div>
                <span className="text-sm text-[var(--gray-11)]">
                  {batchJob.completed + batchJob.failed} / {batchJob.total}
                </span>
              </div>

              {/* Progress bar */}
              <div className="w-full bg-[var(--gray-a3)] rounded-full h-2">
                <div
                  className="bg-[var(--accent-9)] h-2 rounded-full transition-all duration-300"
                  style={{ width: `${batchJob.total > 0 ? ((batchJob.completed + batchJob.failed) / batchJob.total) * 100 : 0}%` }}
                />
              </div>

              {/* Results table */}
              {batchJob.results.length > 0 && (
                <div className="max-h-64 overflow-y-auto rounded-lg border border-[var(--gray-a5)]">
                  <table className="w-full text-sm">
                    <thead className="bg-[var(--gray-a2)] sticky top-0">
                      <tr>
                        <th className="text-left px-3 py-2 text-[var(--gray-11)]">Document</th>
                        <th className="text-left px-3 py-2 text-[var(--gray-11)]">Status</th>
                        <th className="text-right px-3 py-2 text-[var(--gray-11)]">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchJob.results.map((r, i) => (
                        <tr key={i} className="border-t border-[var(--gray-a3)]">
                          <td className="px-3 py-2 text-[var(--gray-12)] truncate max-w-[200px]">
                            {r.doc_name}
                          </td>
                          <td className="px-3 py-2">
                            {r.status === 'success' ? (
                              <Badge color="green" size="1">{r.blocks} blocks</Badge>
                            ) : (
                              <Badge color="red" size="1" title={r.error}>Failed</Badge>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {r.edition_id && (
                              <button
                                onClick={() => navigate(`/newsletters/${newsletterSlug}/editions/${r.edition_id}`)}
                                className="text-xs text-[var(--accent-9)] hover:underline"
                              >
                                Review
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
