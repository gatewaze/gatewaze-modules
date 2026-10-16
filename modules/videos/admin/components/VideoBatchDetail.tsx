/**
 * One upload batch: what has landed, what the studio made of it, and the
 * two actions, sync now and mark complete.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card, WorkspaceLayout } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { getBatch, syncBatch, closeBatch, formatBytes, type UploadBatch, type BatchVideo } from '../utils/videosBatchesService';

export default function VideoBatchDetail() {
  const { batchId = '' } = useParams<{ batchId: string }>();
  const [batch, setBatch] = useState<UploadBatch | null>(null);
  const [videos, setVideos] = useState<BatchVideo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getBatch(batchId);
      setBatch(r.batch); setVideos(r.videos);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the batch');
    } finally { setLoading(false); }
  }, [batchId]);
  useEffect(() => { void load(); }, [load]);

  // Files land and analyses finish on their own time; keep the page fresh
  // while the batch is open or anything is still working.
  const working = batch?.state === 'open' || videos.some((v) => v.studio && ['queued', 'analysing', 'finalising'].includes(v.studio.state));
  useEffect(() => {
    if (!working) return;
    const h = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(h);
  }, [working, load]);

  const sync = async () => {
    setBusy(true);
    try { await syncBatch(batchId); toast.success('Checking the folder now'); setTimeout(() => void load(), 4000); }
    catch (err) { toast.error(err instanceof Error ? err.message : 'Could not sync'); }
    finally { setBusy(false); }
  };
  const close = async () => {
    setBusy(true);
    try {
      const r = await closeBatch(batchId);
      setBatch(r.batch);
      toast.success(r.key_revoked ? 'Batch closed and the key deleted' : 'Batch closed; the key could not be deleted at Backblaze and will expire on its own');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not close'); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="p-8 flex justify-center"><LoadingSpinner /></div>;
  if (!batch) return <div className="p-8 text-sm">Batch not found. <Link to="/videos/batches" className="text-[var(--accent-11)]">Back</Link></div>;

  return (
    <WorkspaceLayout title="Upload batch">
      <div className="p-6 max-w-5xl space-y-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">{batch.label}</h2>
            <p className="text-sm text-[var(--gray-11)]">
              {[batch.issued_to_name, batch.issued_to_email].filter(Boolean).join(' · ') || 'Nobody named'} · folder <code>{batch.prefix}</code>
              {batch.key_expires_at ? ` · key until ${new Date(batch.key_expires_at).toUTCString()}` : ''}
              {batch.last_synced_at ? ` · last checked ${new Date(batch.last_synced_at).toLocaleTimeString()}` : ''}
            </p>
            <Link to="/videos/batches" className="text-xs text-[var(--accent-11)] hover:underline">All batches</Link>
          </div>
          <div className="flex items-center gap-2">
            <Badge color={batch.state === 'open' ? 'green' : batch.state === 'expired' ? 'amber' : 'gray'} variant="soft">{batch.state}</Badge>
            <Button size="sm" variant="outline" disabled={busy || batch.state !== 'open'} onClick={() => void sync()}>Check the folder now</Button>
            <Button size="sm" variant="solid" disabled={busy || batch.state !== 'open'} onClick={() => void close()}>Mark complete</Button>
          </div>
        </div>

        {batch.flags?.length > 0 && (
          <Card variant="surface" className="p-4 border border-[var(--amber-a6)] text-xs">
            <div className="font-medium mb-1">Noticed and left alone</div>
            <ul className="space-y-1">
              {batch.flags.map((f, i) => <li key={i}><code>{f.path.split('/').pop()}</code>: {f.note}</li>)}
            </ul>
          </Card>
        )}

        <Card variant="surface" className="p-4">
          <h3 className="text-sm font-semibold mb-3">Videos ({videos.length})</h3>
          {videos.length === 0 ? (
            <p className="text-sm text-[var(--gray-11)]">
              Nothing has landed yet. The folder is checked every five minutes, or press “Check the folder now”. A file appears here once its upload has finished.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--gray-a5)]">
              {videos.map((v) => {
                const st = v.studio;
                const thumb = st?.thumbnail_url ?? v.thumbnail_url;
                return (
                  <li key={v.id} className="py-3 flex items-center gap-3 text-sm">
                    <div className="w-32 aspect-video bg-[var(--gray-a3)] rounded overflow-hidden shrink-0">
                      {thumb && <img src={thumb} alt="" className="w-full h-full object-cover" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">{v.title}</div>
                      <div className="text-xs text-[var(--gray-11)]">
                        {v.assets.map((a) => `${a.filename ?? ''} ${formatBytes(a.bytes)}`).join(', ')}
                        {v.subject ? (v.subject.subject_type === 'agenda_entry' ? ' · matched to a talk' : ' · attached to the event, no talk matched') : ' · not attached'}
                      </div>
                      {st?.error && <div className="text-xs text-[var(--red-11)]">{st.error}</div>}
                    </div>
                    {st ? (
                      <Badge color={st.state === 'approved' ? 'green' : st.state === 'failed' ? 'red' : st.state === 'ready' ? 'blue' : 'amber'} variant="soft">
                        {st.state}{st.progress && ['queued', 'analysing', 'finalising'].includes(st.state) ? `: ${st.progress}` : ''}
                      </Badge>
                    ) : <Badge color="gray" variant="soft">not analysed</Badge>}
                    <Link to={`/videos/studio/${v.id}`} className="text-xs text-[var(--accent-11)] hover:underline shrink-0">Open in studio</Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </WorkspaceLayout>
  );
}
