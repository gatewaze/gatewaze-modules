/**
 * Upload batches: issue one person an upload-only, expiring key to a folder
 * in the master bucket, and hand them the connection bundle once.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Badge, Button, Card, Input, WorkspaceLayout } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { listSubjects, type SubjectOption } from '../utils/videosEditorService';
import { listBatches, createBatch, type UploadBatch, type BatchCredentials } from '../utils/videosBatchesService';

function copy(text: string, what: string) {
  navigator.clipboard?.writeText(text).then(() => toast.success(`${what} copied`)).catch(() => toast.error('Select and copy it by hand'));
}

export default function VideoBatches() {
  const [batches, setBatches] = useState<UploadBatch[]>([]);
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [events, setEvents] = useState<SubjectOption[]>([]);
  const [eventSearch, setEventSearch] = useState('');
  const [form, setForm] = useState({ label: '', event_id: '', issued_to_name: '', issued_to_email: '', days: 7 });
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ batch: UploadBatch; credentials: BatchCredentials } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await listBatches();
      setBatches(r.batches); setConfigured(r.configured);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load batches');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const h = setTimeout(() => {
      void listSubjects('event', eventSearch).then((r) => setEvents(r.subjects)).catch(() => {});
    }, eventSearch ? 250 : 0);
    return () => clearTimeout(h);
  }, [eventSearch]);

  const create = async () => {
    if (!form.label.trim()) { toast.error('Give the batch a label'); return; }
    setCreating(true);
    try {
      const r = await createBatch({
        label: form.label, event_id: form.event_id || null, issued_to_name: form.issued_to_name, issued_to_email: form.issued_to_email, days: form.days,
      });
      setIssued(r);
      setForm({ label: '', event_id: '', issued_to_name: '', issued_to_email: '', days: 7 });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the batch');
    } finally { setCreating(false); }
  };

  return (
    <WorkspaceLayout title="Upload batches">
      <div className="p-6 max-w-5xl space-y-6">
        <p className="text-sm text-[var(--gray-11)]">
          A batch is a folder in the master bucket that one person can upload into with a key that only writes, only there, and only for a few days.
          They connect Cyberduck or rclone, drag the folder in, and each file is adopted and sent through the studio as it lands.
        </p>

        {!configured && (
          <Card variant="surface" className="p-4 text-sm">
            Batches need the S3 master store (<code>VIDEO_S3_*</code>) and the Backblaze key-minting credential (<code>VIDEO_B2_KEY_ID</code>, <code>VIDEO_B2_KEY</code>) on the API and the worker.
          </Card>
        )}

        {issued && (
          <Card variant="surface" className="p-4 border border-[var(--amber-a6)]">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Connection details for “{issued.batch.label}”</h3>
                <p className="text-xs text-[var(--gray-11)] mt-1">
                  Shown once. The key is not stored anywhere else; if it is lost, close this batch and make another. It works until {issued.batch.key_expires_at ? new Date(issued.batch.key_expires_at).toUTCString() : 'the batch is closed'}.
                  Send it the way you would send a password, never into a shared channel.
                </p>
              </div>
              <Button size="xs" variant="outline" onClick={() => setIssued(null)}>Done, hide it</Button>
            </div>
            <div className="mt-3 space-y-3 text-xs">
              <div>
                <div className="font-medium mb-1">Cyberduck</div>
                <p className="text-[var(--gray-11)] mb-1">Click the link with Cyberduck installed and it opens connected to the folder. Then drag the videos in.</p>
                <div className="flex items-start gap-2">
                  <code className="flex-1 block break-all bg-[var(--gray-a3)] rounded p-2 select-all">{issued.credentials.cyberduck_url}</code>
                  <Button size="xs" variant="outline" onClick={() => copy(issued.credentials.cyberduck_url, 'Cyberduck link')}>Copy</Button>
                </div>
              </div>
              <div>
                <div className="font-medium mb-1">rclone (for an AV team)</div>
                <p className="text-[var(--gray-11)] mb-1">Save the first block as <code>rclone.conf</code>, then run the command from the folder of videos. Rerunning it skips files already uploaded.</p>
                <div className="flex items-start gap-2">
                  <pre className="flex-1 whitespace-pre-wrap break-all bg-[var(--gray-a3)] rounded p-2 select-all">{issued.credentials.rclone_conf}{'\n'}{issued.credentials.rclone_command}</pre>
                  <Button size="xs" variant="outline" onClick={() => copy(`${issued.credentials.rclone_conf}\n${issued.credentials.rclone_command}`, 'rclone setup')}>Copy</Button>
                </div>
              </div>
              <details>
                <summary className="cursor-pointer text-[var(--gray-11)]">Plain fields, for any other client</summary>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mt-2">
                  {Object.entries(issued.credentials.fields).map(([k, v]) => (
                    <div key={k} className="contents"><dt className="text-[var(--gray-9)]">{k.replace('_', ' ')}</dt><dd className="select-all break-all font-mono">{v}</dd></div>
                  ))}
                </dl>
              </details>
            </div>
          </Card>
        )}

        <Card variant="surface" className="p-4">
          <h3 className="text-sm font-semibold mb-3">New batch</h3>
          <div className="grid sm:grid-cols-2 gap-3">
            <Input label="Label" placeholder="AGNTCon EU day 2, Auditorium" value={form.label} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, label: e.target.value })} />
            <div>
              <Input label="Event (files are matched to its agenda by title)" placeholder="Type part of the event name…" value={eventSearch} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEventSearch(e.target.value)} />
              <select value={form.event_id} onChange={(e) => setForm({ ...form, event_id: e.target.value })}
                className="mt-1 w-full px-2 py-1.5 text-sm border border-[var(--gray-a6)] rounded bg-[var(--color-surface)]">
                <option value="">No event</option>
                {events.map((ev) => <option key={ev.id} value={ev.id}>{ev.label}{ev.starts_at ? ` (${String(ev.starts_at).slice(0, 10)})` : ''}</option>)}
              </select>
            </div>
            <Input label="Issued to (name)" value={form.issued_to_name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, issued_to_name: e.target.value })} />
            <Input label="Issued to (email)" placeholder="If it is an admin login, their uploads carry their name" value={form.issued_to_email} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, issued_to_email: e.target.value })} />
            <Input label="Days the key works" type="number" min={1} max={30} value={String(form.days)} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, days: Number(e.target.value) || 7 })} />
          </div>
          <div className="mt-3">
            <Button variant="solid" size="sm" disabled={creating || !configured} onClick={() => void create()}>{creating ? 'Creating…' : 'Create batch and mint the key'}</Button>
          </div>
        </Card>

        <Card variant="surface" className="p-4">
          <h3 className="text-sm font-semibold mb-3">Batches</h3>
          {loading ? <LoadingSpinner /> : batches.length === 0 ? (
            <p className="text-sm text-[var(--gray-11)]">None yet.</p>
          ) : (
            <ul className="divide-y divide-[var(--gray-a5)]">
              {batches.map((b) => (
                <li key={b.id} className="py-2 flex items-center gap-3 text-sm">
                  <Badge color={b.state === 'open' ? 'green' : b.state === 'expired' ? 'amber' : 'gray'} variant="soft">{b.state}</Badge>
                  <Link to={`/videos/batches/${b.id}`} className="flex-1 truncate text-[var(--accent-11)] hover:underline">{b.label}</Link>
                  <span className="text-xs text-[var(--gray-11)] shrink-0">
                    {b.issued_to_name || b.issued_to_email || 'unassigned'} · {b.adopted} adopted of {b.objects_seen} seen
                    {b.flags?.length ? ` · ${b.flags.length} flagged` : ''}
                    {b.key_expires_at && b.state === 'open' ? ` · key until ${b.key_expires_at.slice(0, 10)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </WorkspaceLayout>
  );
}
