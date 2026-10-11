/**
 * BroadcastTemplateTab — super-admin only. Two things:
 *
 *   1. Which wrapper THIS broadcast renders in: the built-in plain email
 *      (default — reads like a hand-written message) or the wrapper from the
 *      shared broadcast template repo. Stored in `broadcasts.template`.
 *   2. The shared broadcast template library: one git repo for all
 *      broadcasts (a `templates_libraries` row with host_kind='broadcasts'),
 *      managed with the same panel a newsletter publication uses. Its
 *      `wrappers/default.html` is what option 2 above renders with, and its
 *      blocks join the Content step's palette.
 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { TemplateSourcesPanel } from '../../../newsletters/admin/components/templates/TemplateSourcesPanel';
import { updateBroadcast, type Broadcast, type BroadcastTemplate } from '../lib/broadcastService';

/** The one shared broadcast library (created by migration 028). */
export async function getBroadcastTemplateLibraryId(): Promise<string | null> {
  const { data } = await supabase
    .from('templates_libraries')
    .select('id')
    .eq('host_kind', 'broadcasts')
    .is('host_id', null)
    .maybeSingle<{ id: string }>();
  return data?.id ?? null;
}

const OPTIONS: Array<{ value: BroadcastTemplate; label: string; description: string }> = [
  { value: 'plain', label: 'Plain email', description: 'Reads like a message typed in Gmail: no header, no column, the reader’s own font and colours, a single unsubscribe link as plain text.' },
  { value: 'repo', label: 'Broadcast template repo', description: 'The wrapper (header, footer, column) from the shared broadcast template repo below.' },
];

export function BroadcastTemplateTab({ b, editable, onSaved }: { b: Broadcast; editable: boolean; onSaved: (b: Broadcast) => void }) {
  const [libraryId, setLibraryId] = useState<string | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getBroadcastTemplateLibraryId().then((id) => { if (!cancelled) setLibraryId(id); });
    return () => { cancelled = true; };
  }, []);

  const pick = async (value: BroadcastTemplate) => {
    if (value === b.template || saving || !editable) return;
    setSaving(true);
    try {
      const fresh = await updateBroadcast(b.id, { template: value } as Partial<Broadcast>);
      onSaved(fresh);
      toast.success(value === 'plain' ? 'This broadcast will send as a plain email' : 'This broadcast will use the template repo wrapper');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to change template');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-8">
      <section>
        <div className="mb-3">
          <h2 className="text-lg font-semibold text-[var(--gray-12)]">Email wrapper</h2>
          <p className="text-xs text-[var(--gray-9)] mt-0.5">How this broadcast is dressed when it sends. Content is re-rendered with the chosen wrapper when it is next saved (Send saves first).</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {OPTIONS.map((o) => {
            const active = (b.template ?? 'plain') === o.value;
            const unavailable = o.value === 'repo' && libraryId === null;
            return (
              <button
                key={o.value}
                type="button"
                disabled={saving || !editable || unavailable}
                onClick={() => pick(o.value)}
                className={`text-left rounded-lg border px-4 py-3 transition-colors disabled:opacity-60 ${active ? 'border-[var(--accent-8)] bg-[var(--accent-a2)]' : 'border-[var(--gray-a4)] hover:bg-[var(--gray-a3)]'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-[var(--gray-12)]">{o.label}</span>
                  {active && <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--accent-11)]">Current</span>}
                </div>
                <p className="mt-1 text-xs text-[var(--gray-10)]">{o.description}</p>
              </button>
            );
          })}
        </div>
      </section>

      {libraryId === undefined ? null : libraryId === null ? (
        <p className="text-sm text-[var(--gray-9)]">The shared broadcast template library has not been created yet (migration 028).</p>
      ) : (
        <TemplateSourcesPanel libraryId={libraryId} hostKind="broadcasts" />
      )}
    </div>
  );
}

export default BroadcastTemplateTab;
