/**
 * Suppression lists — upload a CSV of email addresses or SHA-256 hashes under
 * a name you choose, then exclude it from any audience with the "Suppression
 * list" condition in the segment builder.
 *
 * Addresses are hashed in this browser before upload; only hashes are sent
 * and stored, and nothing records where a list came from.
 */
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Page } from '@/components/shared/Page';
import { WorkspaceLayout } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { chunk, parseSuppressionCsv, type SuppressionCsvResult } from '../utils/suppressionCsv';

interface SuppressionList {
  id: string;
  name: string;
  entry_count: number;
  created_at: string;
  updated_at: string;
}

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const FIELD = 'w-full px-3 py-2 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-background)] text-[var(--gray-12)]';
const BUTTON = 'px-3 py-1.5 text-sm rounded-md border border-[var(--gray-a6)] text-[var(--gray-12)] hover:bg-[var(--gray-a3)] disabled:opacity-50';
const PRIMARY = 'px-3 py-1.5 text-sm font-medium rounded-md bg-[var(--accent-9)] text-[var(--accent-contrast,#fff)] disabled:opacity-50';

export default function SuppressionListsPage() {
  const navigate = useNavigate();
  const [lists, setLists] = useState<SuppressionList[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [parsed, setParsed] = useState<SuppressionCsvResult | null>(null);
  const [fileName, setFileName] = useState('');
  const [reading, setReading] = useState(false);
  const [uploading, setUploading] = useState<{ done: number; total: number } | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  // Adding more entries to an existing list instead of creating a new one.
  const [appendTo, setAppendTo] = useState<string>('');

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from('segments_suppression_lists')
      .select('id, name, entry_count, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) toast.error(error.message);
    setLists((data ?? []) as SuppressionList[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setParsed(null);
    setFileName(file?.name ?? '');
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) { toast.error('File is larger than 20 MB'); return; }
    setReading(true);
    try {
      setParsed(await parseSuppressionCsv(await file.text()));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not read the file');
    } finally {
      setReading(false);
    }
  };

  const upload = async () => {
    if (!parsed || parsed.hashes.length === 0) return;
    if (!appendTo && !name.trim()) { toast.error('Give the list a name'); return; }
    const batches = chunk(parsed.hashes);
    setUploading({ done: 0, total: parsed.hashes.length });
    try {
      let listId = appendTo;
      if (!listId) {
        const { data, error } = await supabase.rpc('segments_suppression_create', { p_name: name.trim() });
        if (error) throw error;
        listId = data as string;
      }
      let done = 0;
      for (const batch of batches) {
        const { error } = await supabase.rpc('segments_suppression_add', { p_list_id: listId, p_hashes: batch });
        if (error) throw error;
        done += batch.length;
        setUploading({ done, total: parsed.hashes.length });
      }
      toast.success(`Uploaded ${parsed.hashes.length.toLocaleString()} entries`);
      setParsed(null); setFileName(''); setName(''); setAppendTo('');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(null);
    }
  };

  const rename = async () => {
    if (!editing || !editing.name.trim()) return;
    const { error } = await supabase.rpc('segments_suppression_rename', { p_list_id: editing.id, p_name: editing.name.trim() });
    if (error) { toast.error(error.message); return; }
    setEditing(null);
    await load();
  };

  const remove = async (l: SuppressionList) => {
    if (!window.confirm(`Delete "${l.name}"? Any audience that excludes it will match nobody until the condition is changed.`)) return;
    const { error } = await supabase.rpc('segments_suppression_delete', { p_list_id: l.id });
    if (error) { toast.error(error.message); return; }
    await load();
  };

  return (
    <Page title="Suppression lists">
      <WorkspaceLayout
        title="Segments"
        breadcrumbs={[{ label: 'Segments', to: '/segments' }, { label: 'Suppression lists' }]}
        onBreadcrumbNavigate={(to) => navigate(to)}
      >
        <div className="space-y-6 max-w-4xl">
          <p className="text-sm text-[var(--gray-11)]">
            Upload a CSV of email addresses or SHA-256 hashes, one per row, under a name of your choosing. Addresses are hashed
            in your browser before upload, so only hashes are stored. Exclude a list from any audience with the
            &ldquo;Suppression list&rdquo; condition, set to &ldquo;Not On List&rdquo;.
          </p>

          <section className="border border-[var(--gray-a5)] rounded-lg p-4 space-y-3">
            <h2 className="text-sm font-semibold text-[var(--gray-12)]">Upload a list</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Add to</label>
                <select className={FIELD} value={appendTo} onChange={(e) => setAppendTo(e.target.value)}>
                  <option value="">A new list</option>
                  {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              {!appendTo && (
                <div>
                  <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">Name</label>
                  <input className={FIELD} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="e.g. Suppression, 15 Oct" />
                </div>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">CSV file</label>
              <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(e) => void onFile(e)} className="text-sm" />
            </div>
            {reading && <p className="text-xs text-[var(--gray-10)]">Reading {fileName}…</p>}
            {parsed && (
              <div className="text-sm text-[var(--gray-12)] space-y-1">
                <p>{parsed.hashes.length.toLocaleString()} unique entries ready to upload from {parsed.rows.toLocaleString()} rows.</p>
                <p className="text-xs text-[var(--gray-10)]">
                  {parsed.emails.toLocaleString()} addresses hashed here, {parsed.hashesGiven.toLocaleString()} hashes as given,{' '}
                  {parsed.duplicates.toLocaleString()} duplicates and {parsed.skipped.toLocaleString()} rows that were neither (headers or blanks) left out.
                </p>
              </div>
            )}
            <div className="flex items-center gap-3">
              <button type="button" className={PRIMARY} disabled={!parsed || parsed.hashes.length === 0 || !!uploading} onClick={() => void upload()}>
                {uploading ? `Uploading ${uploading.done.toLocaleString()} of ${uploading.total.toLocaleString()}…` : 'Upload'}
              </button>
            </div>
          </section>

          <section className="border border-[var(--gray-a5)] rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--gray-a2)] text-xs text-[var(--gray-11)]">
                <tr>
                  <th className="text-left font-medium px-4 py-2">Name</th>
                  <th className="text-right font-medium px-4 py-2">Entries</th>
                  <th className="text-left font-medium px-4 py-2">Updated</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--gray-a4)]">
                {loading ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-[var(--gray-10)]">Loading…</td></tr>
                ) : lists.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-6 text-center text-[var(--gray-10)]">No suppression lists yet.</td></tr>
                ) : lists.map((l) => (
                  <tr key={l.id}>
                    <td className="px-4 py-2">
                      {editing?.id === l.id ? (
                        <div className="flex gap-2">
                          <input className={FIELD} value={editing.name} maxLength={120} onChange={(e) => setEditing({ id: l.id, name: e.target.value })} />
                          <button type="button" className={PRIMARY} onClick={() => void rename()}>Save</button>
                          <button type="button" className={BUTTON} onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      ) : <span className="text-[var(--gray-12)]">{l.name}</span>}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-[var(--gray-12)]">{l.entry_count.toLocaleString()}</td>
                    <td className="px-4 py-2 text-[var(--gray-11)]">{new Date(l.updated_at).toLocaleDateString()}</td>
                    <td className="px-4 py-2 text-right whitespace-nowrap space-x-2">
                      {editing?.id !== l.id && (
                        <>
                          <button type="button" className={BUTTON} onClick={() => setEditing({ id: l.id, name: l.name })}>Rename</button>
                          <button type="button" className={BUTTON} onClick={() => void remove(l)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </WorkspaceLayout>
    </Page>
  );
}
