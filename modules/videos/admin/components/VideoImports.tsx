/**
 * Video imports: bring masters into Gatewaze for talks that only exist on
 * YouTube.
 *
 * Two sources, in order of usefulness:
 *
 *   Google Drive (Takeout)   the originals the channel owner uploaded, via a
 *                            Takeout export delivered to a Drive folder
 *   YouTube                  the 360p progressive stream, the most YouTube
 *                            will serve without a browser session; a fallback
 *
 * Both only queue a job. The worker holds the budget caps and reports in the
 * recent-imports list below.
 */

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDownTrayIcon, ArrowPathIcon } from '@heroicons/react/24/outline';

import { Badge, Button, Card, Input, WorkspaceLayout } from '@/components/ui';

import {
  queueDriveImport,
  queueYoutubeImport,
  listRecentImports,
  formatBytes,
  type ImportedAsset,
} from '../utils/videosImportsService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function VideoImports() {
  const [folder, setFolder] = useState('');
  const [driveEvent, setDriveEvent] = useState('');
  const [ytScope, setYtScope] = useState('');
  const [busy, setBusy] = useState<'drive' | 'youtube' | null>(null);
  const [recent, setRecent] = useState<ImportedAsset[]>([]);
  const [loadingRecent, setLoadingRecent] = useState(true);

  const refresh = useCallback(async () => {
    setLoadingRecent(true);
    try {
      setRecent(await listRecentImports());
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load recent imports');
    } finally {
      setLoadingRecent(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submitDrive = async () => {
    if (!folder.trim()) return toast.error('Paste the Drive folder link or id');
    if (driveEvent.trim() && !UUID_RE.test(driveEvent.trim())) return toast.error('Event id must be a uuid');
    setBusy('drive');
    try {
      const r = await queueDriveImport({ folder_id: folder.trim(), ...(driveEvent.trim() ? { event_id: driveEvent.trim() } : {}) });
      toast.success(`Drive import queued (job ${r.job_id ?? 'pending'})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue the import');
    } finally {
      setBusy(null);
    }
  };

  const submitYoutube = async () => {
    const id = ytScope.trim();
    if (!UUID_RE.test(id)) return toast.error('Paste an event id or a recap id (uuid)');
    setBusy('youtube');
    try {
      // The API accepts either; an event id is the common case now that the
      // recap reads from the event.
      const r = await queueYoutubeImport({ event_id: id });
      toast.success(`YouTube import queued (job ${r.job_id ?? 'pending'})`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not queue the import');
    } finally {
      setBusy(null);
    }
  };

  return (
    <WorkspaceLayout title="Video imports">
      <p className="text-sm text-muted-foreground mb-4">
        Bring the master files for talks that only exist on YouTube into Gatewaze, so they can be given a poster,
        re-cut and re-published.
      </p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold">From a Google Drive folder (Takeout)</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Export the channel with Google Takeout, deliver it to Drive, and share the folder with the import
              service account. Files are matched to the YouTube videos by Takeout&apos;s <code>videos.csv</code>,
              or by title when there is no CSV. Anything unmatched lands in the unassigned queue.
            </p>
          </div>
          <label className="block text-sm">
            <span className="font-medium">Folder link or id</span>
            <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" className="mt-1" />
          </label>
          <label className="block text-sm">
            <span className="font-medium">Limit matching to one event (optional)</span>
            <Input value={driveEvent} onChange={(e) => setDriveEvent(e.target.value)} placeholder="event uuid" className="mt-1" />
          </label>
          <Button onClick={submitDrive} disabled={busy !== null}>
            <ArrowDownTrayIcon className="h-4 w-4 mr-2" />
            {busy === 'drive' ? 'Queuing…' : 'Import from Drive'}
          </Button>
        </Card>

        <Card className="p-5 space-y-4">
          <div>
            <h2 className="text-base font-semibold">From YouTube (fallback)</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Pulls the single progressive stream YouTube serves without a browser session, which is 360p. Use it
              only for a talk that has no original. Attaches to the existing video for each YouTube id.
            </p>
          </div>
          <label className="block text-sm">
            <span className="font-medium">Event id</span>
            <Input value={ytScope} onChange={(e) => setYtScope(e.target.value)} placeholder="event uuid" className="mt-1" />
          </label>
          <Button variant="soft" onClick={submitYoutube} disabled={busy !== null}>
            <ArrowDownTrayIcon className="h-4 w-4 mr-2" />
            {busy === 'youtube' ? 'Queuing…' : 'Import from YouTube'}
          </Button>
        </Card>
      </div>

      <Card className="p-5 mt-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold">Recent imports</h2>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loadingRecent}>
            <ArrowPathIcon className="h-4 w-4 mr-1" /> Refresh
          </Button>
        </div>
        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">{loadingRecent ? 'Loading…' : 'Nothing imported yet.'}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3">File</th>
                  <th className="py-1 pr-3">Source</th>
                  <th className="py-1 pr-3">Store</th>
                  <th className="py-1 pr-3">Size</th>
                  <th className="py-1 pr-3">State</th>
                  <th className="py-1">When</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="py-1 pr-3 max-w-[28rem] truncate" title={a.error ?? a.filename ?? ''}>{a.filename ?? a.id}</td>
                    <td className="py-1 pr-3">{a.source === 'drive_import' ? 'Drive' : 'YouTube'}</td>
                    <td className="py-1 pr-3">{a.storage_provider === 's3' ? 'B2' : 'Supabase'}</td>
                    <td className="py-1 pr-3">{formatBytes(a.bytes)}</td>
                    <td className="py-1 pr-3">
                      <Badge color={a.state === 'ready' ? 'success' : a.state === 'failed' ? 'error' : 'neutral'}>{a.state}</Badge>
                    </td>
                    <td className="py-1 whitespace-nowrap">{new Date(a.updated_at ?? a.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </WorkspaceLayout>
  );
}
