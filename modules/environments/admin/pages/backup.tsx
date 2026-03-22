import { useState, useRef } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowLeftIcon,
  ArrowDownTrayIcon,
  ArrowUpTrayIcon,
  ArrowPathIcon,
  CheckIcon,
  ExclamationTriangleIcon,
  CircleStackIcon,
  DocumentArrowDownIcon,
  DocumentArrowUpIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { Page } from '@/components/shared/Page';

interface RestoreResult {
  success: boolean;
  backup_version: string;
  backup_created_at: string;
  tables_restored: number;
  tables_skipped: number;
  tables_errored: number;
  details: Array<{
    table: string;
    rows: number;
    status: string;
    error?: string;
  }>;
}

export default function BackupPage() {
  const navigate = useNavigate();

  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null);
  const [clearExisting, setClearExisting] = useState(true);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    setExporting(true);
    try {
      const response = await fetch('/api/environments/backup');

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: 'Export failed' }));
        throw new Error(err.error || 'Export failed');
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;

      // Extract filename from Content-Disposition header or generate one
      const disposition = response.headers.get('Content-Disposition');
      const filenameMatch = disposition?.match(/filename="(.+)"/);
      a.download = filenameMatch?.[1] ?? `gatewaze-backup-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json.gz`;

      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      toast.success('Backup downloaded successfully');
    } catch (err: any) {
      console.error('Export error:', err);
      toast.error(err.message || 'Failed to export backup');
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    if (!selectedFile) {
      toast.error('Please select a backup file first');
      return;
    }

    setImporting(true);
    setRestoreResult(null);

    try {
      // Read the file as an ArrayBuffer and send as raw body
      const buffer = await selectedFile.arrayBuffer();

      const response = await fetch(
        `/api/environments/restore?clearExisting=${clearExisting}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/gzip',
          },
          body: buffer,
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Restore failed');
      }

      setRestoreResult(result);
      toast.success(`Restored ${result.tables_restored} tables successfully`);
    } catch (err: any) {
      console.error('Import error:', err);
      toast.error(err.message || 'Failed to restore backup');
    } finally {
      setImporting(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.name.endsWith('.json.gz') && !file.name.endsWith('.gz')) {
        toast.error('Please select a .json.gz backup file');
        return;
      }
      setSelectedFile(file);
      setRestoreResult(null);
    }
  };

  return (
    <Page title="Database Backup">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            onClick={() => navigate('/admin/environments')}
            className="gap-1"
          >
            <ArrowLeftIcon className="size-4" />
            Back
          </Button>
        </div>

        <div>
          <h1 className="text-2xl font-semibold text-[var(--gray-12)]">
            Database Backup & Restore
          </h1>
          <p className="text-[var(--gray-a8)] mt-1">
            Export your entire database as a compressed file for backup or seed data, or restore from a previous backup.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Export Card */}
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <DocumentArrowDownIcon className="size-6 text-[var(--blue-9)]" />
              <h3 className="text-lg font-semibold text-[var(--gray-12)]">
                Export Backup
              </h3>
            </div>

            <p className="text-sm text-[var(--gray-a8)] mb-6">
              Download all database tables as a single compressed file (.json.gz).
              All tables and their data are included with metadata.
            </p>

            <div className="space-y-3 mb-6">
              <div className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
                <CircleStackIcon className="size-4 text-[var(--gray-a8)]" />
                All public tables included automatically
              </div>
              <div className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
                <CheckIcon className="size-4 text-[var(--green-9)]" />
                FK-safe ordering preserved
              </div>
              <div className="flex items-center gap-2 text-sm text-[var(--gray-11)]">
                <CheckIcon className="size-4 text-[var(--green-9)]" />
                Gzip compressed for fast transfer
              </div>
            </div>

            <Button
              onClick={handleExport}
              disabled={exporting}
              className="w-full gap-2"
              color="primary"
            >
              {exporting ? (
                <>
                  <ArrowPathIcon className="size-4 animate-spin" />
                  Exporting...
                </>
              ) : (
                <>
                  <ArrowDownTrayIcon className="size-4" />
                  Download Backup
                </>
              )}
            </Button>
          </Card>

          {/* Import Card */}
          <Card className="p-6">
            <div className="flex items-center gap-3 mb-4">
              <DocumentArrowUpIcon className="size-6 text-[var(--green-9)]" />
              <h3 className="text-lg font-semibold text-[var(--gray-12)]">
                Restore Backup
              </h3>
            </div>

            <p className="text-sm text-[var(--gray-a8)] mb-6">
              Upload a previously exported backup file to restore database tables.
              Use this to seed a fresh environment with test data.
            </p>

            {/* File Selection */}
            <div className="mb-4">
              <input
                ref={fileInputRef}
                type="file"
                accept=".gz,.json.gz"
                onChange={handleFileSelect}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="w-full p-4 border-2 border-dashed border-[var(--gray-a5)] rounded-lg hover:border-[var(--gray-a7)] transition-colors cursor-pointer text-center"
              >
                {selectedFile ? (
                  <div className="flex items-center justify-center gap-2">
                    <CircleStackIcon className="size-5 text-[var(--green-9)]" />
                    <span className="text-sm font-medium text-[var(--gray-12)]">
                      {selectedFile.name}
                    </span>
                    <Badge color="info" variant="soft">
                      {(selectedFile.size / 1024 / 1024).toFixed(1)} MB
                    </Badge>
                  </div>
                ) : (
                  <div>
                    <ArrowUpTrayIcon className="size-6 mx-auto mb-2 text-[var(--gray-a8)]" />
                    <div className="text-sm text-[var(--gray-a8)]">
                      Click to select a .json.gz backup file
                    </div>
                  </div>
                )}
              </button>
            </div>

            {/* Clear Existing Option */}
            <label className="flex items-center gap-3 mb-4 cursor-pointer">
              <input
                type="checkbox"
                checked={clearExisting}
                onChange={(e) => setClearExisting(e.target.checked)}
                disabled={importing}
                className="rounded"
              />
              <div>
                <span className="text-sm font-medium text-[var(--gray-12)]">
                  Clear existing data before restore
                </span>
                <span className="text-xs text-[var(--gray-a8)] block">
                  Removes current rows before importing. Recommended for seed data.
                </span>
              </div>
            </label>

            {/* Warning */}
            {clearExisting && (
              <div className="flex items-start gap-2 p-3 bg-[var(--amber-a2)] rounded-lg mb-4">
                <ExclamationTriangleIcon className="size-5 text-[var(--amber-9)] shrink-0 mt-0.5" />
                <p className="text-xs text-[var(--amber-11)]">
                  This will delete all existing data in the target tables before restoring.
                  Make sure you have a backup if needed.
                </p>
              </div>
            )}

            <Button
              onClick={handleImport}
              disabled={importing || !selectedFile}
              className="w-full gap-2"
              color="success"
            >
              {importing ? (
                <>
                  <ArrowPathIcon className="size-4 animate-spin" />
                  Restoring...
                </>
              ) : (
                <>
                  <ArrowUpTrayIcon className="size-4" />
                  Restore Backup
                </>
              )}
            </Button>
          </Card>
        </div>

        {/* Restore Results */}
        {restoreResult && (
          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-[var(--gray-12)]">
                Restore Results
              </h3>
              <div className="flex gap-2">
                <Badge color="success" variant="soft">
                  {restoreResult.tables_restored} restored
                </Badge>
                {restoreResult.tables_skipped > 0 && (
                  <Badge color="warning" variant="soft">
                    {restoreResult.tables_skipped} skipped
                  </Badge>
                )}
                {restoreResult.tables_errored > 0 && (
                  <Badge color="danger" variant="soft">
                    {restoreResult.tables_errored} errors
                  </Badge>
                )}
              </div>
            </div>

            <div className="text-xs text-[var(--gray-a8)] mb-3">
              Backup created: {new Date(restoreResult.backup_created_at).toLocaleString()}
              {' | '}Version: {restoreResult.backup_version}
            </div>

            <div className="bg-[var(--gray-a2)] rounded-lg p-4 max-h-80 overflow-y-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[var(--gray-a8)]">
                    <th className="pb-2 font-medium">Table</th>
                    <th className="pb-2 font-medium text-right">Rows</th>
                    <th className="pb-2 font-medium text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs">
                  {restoreResult.details.map((detail) => (
                    <tr key={detail.table} className="border-t border-[var(--gray-a3)]">
                      <td className="py-1.5">{detail.table}</td>
                      <td className="py-1.5 text-right">{detail.rows.toLocaleString()}</td>
                      <td className="py-1.5 text-right">
                        {detail.status === 'ok' ? (
                          <span className="text-[var(--green-9)]">OK</span>
                        ) : detail.status === 'skipped' ? (
                          <span className="text-[var(--gray-a8)]">Skipped</span>
                        ) : (
                          <span className="text-[var(--red-9)]" title={detail.error}>
                            Error
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </Page>
  );
}
