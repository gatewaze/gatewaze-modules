/**
 * View Online — newsletter Settings card.
 *
 * Chooses where the email header's "View Online" link points for this
 * newsletter:
 *   - 'portal'   → the portal web-version URL (we host it; nicer URLs +
 *                  analytics). Default.
 *   - 'external' → the static site built from the publish branch
 *                  (GitHub Pages / Netlify / Cloudflare Pages), using the
 *                  external base URL. Editions live at
 *                  `<base>/editions/<edition_date>.html`, matching what
 *                  publish-to-git writes.
 *
 * The link is resolved at send time in EditionSendingTab from these two
 * columns on newsletters_template_collections.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';

type Target = 'portal' | 'external';

const FIELD =
  'w-full px-3 py-2 text-sm rounded-md border border-[var(--gray-a6)] bg-[var(--color-surface,#fff)] text-[var(--gray-12)] outline-none focus:border-[var(--accent-8)]';

export function ViewOnlineSettings({ collectionId }: { collectionId: string }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [target, setTarget] = useState<Target>('portal');
  const [externalBase, setExternalBase] = useState('');

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('newsletters_template_collections')
      .select('view_online_target, view_online_external_base_url')
      .eq('id', collectionId)
      .maybeSingle();
    const row = data as { view_online_target: string | null; view_online_external_base_url: string | null } | null;
    setTarget(row?.view_online_target === 'external' ? 'external' : 'portal');
    setExternalBase(row?.view_online_external_base_url ?? '');
    setLoading(false);
  }, [collectionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (target === 'external' && !externalBase.trim()) {
      toast.error('Enter the base URL of your published site');
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('newsletters_template_collections')
        .update({
          view_online_target: target,
          view_online_external_base_url:
            target === 'external' ? externalBase.trim().replace(/\/+$/, '') : externalBase.trim() || null,
        })
        .eq('id', collectionId);
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success('View Online settings saved');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--accent-9)]" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="border border-[var(--gray-a5)] rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--gray-a5)] bg-[var(--gray-a2)]">
        <h3 className="text-sm font-semibold text-[var(--gray-12)]">View Online</h3>
        <p className="text-xs text-[var(--gray-11)] mt-0.5">
          Where the email&apos;s &ldquo;View Online&rdquo; link sends readers.
        </p>
      </div>

      <div className="p-4 space-y-3">
        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="view_online_target"
            className="mt-1"
            checked={target === 'portal'}
            onChange={() => setTarget('portal')}
          />
          <span>
            <span className="block text-sm font-medium text-[var(--gray-12)]">Portal (recommended)</span>
            <span className="block text-xs text-[var(--gray-10)]">
              Hosted by us with clean URLs and open/click analytics.
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 cursor-pointer">
          <input
            type="radio"
            name="view_online_target"
            className="mt-1"
            checked={target === 'external'}
            onChange={() => setTarget('external')}
          />
          <span>
            <span className="block text-sm font-medium text-[var(--gray-12)]">External static site</span>
            <span className="block text-xs text-[var(--gray-10)]">
              The site built from your <code>publish</code> branch (GitHub Pages, Netlify, Cloudflare Pages…).
            </span>
          </span>
        </label>

        {target === 'external' && (
          <div className="pl-6">
            <input
              className={FIELD}
              value={externalBase}
              onChange={(e) => setExternalBase(e.target.value)}
              placeholder="https://newsletter.example.org"
            />
            <p className="text-xs text-[var(--gray-10)] mt-1">
              Editions resolve to <code>{(externalBase.trim().replace(/\/+$/, '') || 'https://your-site') + '/editions/<date>.html'}</code>.
            </p>
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={saving}
            className="px-3 py-2 text-sm font-medium rounded-md bg-[var(--accent-9)] text-[var(--accent-contrast,#fff)] disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </form>
  );
}
