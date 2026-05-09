/**
 * Newsletter-level "default edition template" picker. Per the design
 * note: most newsletters use the same layout edition-after-edition,
 * so the template choice belongs to the newsletter (collection),
 * not to each edition.
 *
 * Storage: `newsletters_template_collections.metadata.default_edition_template_slug`.
 * When a new edition is created (editions/[id].tsx in `isNew` mode),
 * it reads this slug and stamps the corresponding starter's blocks
 * into the fresh edition. Existing editions are unaffected — this
 * card is intentionally a future-default rather than a destructive
 * "apply to all editions" action.
 */
import { useEffect, useState, type FC } from 'react';
import { toast } from 'sonner';
import { Card, Button } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { ALL_STARTERS, type StarterTemplate } from './puck/starter-templates/index.js';

export interface DefaultEditionTemplateCardProps {
  newsletterId: string;
}

const META_KEY = 'default_edition_template_slug';

export const DefaultEditionTemplateCard: FC<DefaultEditionTemplateCardProps> = ({ newsletterId }) => {
  const [currentSlug, setCurrentSlug] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data } = await supabase
          .from('newsletters_template_collections')
          .select('metadata')
          .eq('id', newsletterId)
          .maybeSingle<{ metadata: Record<string, unknown> | null }>();
        if (cancelled) return;
        const slug = (data?.metadata ?? {})[META_KEY];
        setCurrentSlug(typeof slug === 'string' ? slug : null);
      } catch {
        if (!cancelled) setCurrentSlug(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [newsletterId]);

  const handlePick = async (starter: StarterTemplate | null) => {
    setSaving(true);
    try {
      // Read-modify-write so other metadata keys are preserved.
      const { data: prev } = await supabase
        .from('newsletters_template_collections')
        .select('metadata')
        .eq('id', newsletterId)
        .maybeSingle<{ metadata: Record<string, unknown> | null }>();
      const meta = (prev?.metadata ?? {}) as Record<string, unknown>;
      const next = { ...meta };
      if (starter) {
        next[META_KEY] = starter.slug;
      } else {
        delete next[META_KEY];
      }
      const { error } = await supabase
        .from('newsletters_template_collections')
        .update({ metadata: next })
        .eq('id', newsletterId);
      if (error) throw error;
      setCurrentSlug(starter ? starter.slug : null);
      toast.success(starter ? `Default template set to "${starter.label}"` : 'Default template cleared');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const current = currentSlug ? ALL_STARTERS.find((s) => s.slug === currentSlug) ?? null : null;

  return (
    <Card>
      <div className="p-5 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-[var(--gray-12)]">Default edition template</h3>
          <p className="text-sm text-[var(--gray-9)] mt-1">
            New editions of this newsletter start from the template you pick here. Existing
            editions aren&apos;t affected. Operators can still drag in additional blocks per
            edition; this just sets the starting layout.
          </p>
        </div>

        {loading ? (
          <div className="text-sm text-[var(--gray-9)]">Loading…</div>
        ) : (
          <>
            <div className="text-sm">
              <span className="text-[var(--gray-9)]">Currently: </span>
              {current ? (
                <strong className="text-[var(--gray-12)]">{current.label}</strong>
              ) : (
                <em className="text-[var(--gray-9)]">No default — new editions start empty.</em>
              )}
            </div>

            <div className="grid gap-2 max-h-[420px] overflow-y-auto pr-1">
              {ALL_STARTERS.map((s) => {
                const active = s.slug === currentSlug;
                return (
                  <button
                    key={s.slug}
                    type="button"
                    disabled={saving}
                    onClick={() => handlePick(active ? null : s)}
                    className={`text-left p-3 rounded-md border transition-colors ${
                      active
                        ? 'border-[var(--accent-9)] bg-[var(--accent-a3)]'
                        : 'border-[var(--gray-a5)] hover:border-[var(--gray-a7)] hover:bg-[var(--gray-a2)]'
                    } ${saving ? 'opacity-60 cursor-wait' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="font-medium text-sm text-[var(--gray-12)]">{s.label}</div>
                      <span className="text-[10px] uppercase tracking-wider text-[var(--gray-9)]">
                        {s.category}
                      </span>
                    </div>
                    <div className="text-xs text-[var(--gray-9)] mt-1">{s.description}</div>
                  </button>
                );
              })}
            </div>

            {current && (
              <div>
                <Button variant="outline" onClick={() => handlePick(null)} disabled={saving}>
                  Clear default
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
};

export default DefaultEditionTemplateCard;
