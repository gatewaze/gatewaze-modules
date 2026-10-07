/**
 * BuiltInWrapperCard — which wrapper (header/footer chrome) a publication
 * renders its editions in.
 *
 * Storage: `newsletters_template_collections.metadata.builtin_wrapper`. Set to
 * a built-in key (today only `plain`, the plain-email wrapper), editions
 * render in that wrapper and the repo's `wrappers/default.html` is ignored;
 * unset, the repo wrapper applies as before. Same read-modify-write pattern
 * as DefaultEditionTemplateCard so other metadata keys survive.
 */
import { useEffect, useState, type FC } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import {
  BUILTIN_WRAPPERS,
  BUILTIN_WRAPPER_META_KEY,
  isBuiltinWrapperKey,
  type BuiltinWrapperKey,
} from '../../lib/plain-email/wrapper.js';

export interface BuiltInWrapperCardProps {
  newsletterId: string;
  /** Called after a successful change so the page can reload what it renders. */
  onChanged?: () => void;
}

type Choice = BuiltinWrapperKey | 'repo';

export const BuiltInWrapperCard: FC<BuiltInWrapperCardProps> = ({ newsletterId, onChanged }) => {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('newsletters_template_collections')
        .select('metadata')
        .eq('id', newsletterId)
        .maybeSingle<{ metadata: Record<string, unknown> | null }>();
      if (cancelled) return;
      const key = (data?.metadata ?? {})[BUILTIN_WRAPPER_META_KEY];
      setChoice(isBuiltinWrapperKey(key) ? key : 'repo');
    })();
    return () => { cancelled = true; };
  }, [newsletterId]);

  const pick = async (next: Choice) => {
    if (next === choice || saving) return;
    setSaving(true);
    try {
      const { data: prev } = await supabase
        .from('newsletters_template_collections')
        .select('metadata')
        .eq('id', newsletterId)
        .maybeSingle<{ metadata: Record<string, unknown> | null }>();
      const meta = { ...((prev?.metadata ?? {}) as Record<string, unknown>) };
      if (next === 'repo') delete meta[BUILTIN_WRAPPER_META_KEY];
      else meta[BUILTIN_WRAPPER_META_KEY] = next;
      const { error } = await supabase
        .from('newsletters_template_collections')
        .update({ metadata: meta })
        .eq('id', newsletterId);
      if (error) throw error;
      setChoice(next);
      toast.success(next === 'repo' ? 'Editions now use this newsletter’s repo wrapper' : `Editions now use the ${BUILTIN_WRAPPERS[next].label} wrapper`);
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to change wrapper');
    } finally {
      setSaving(false);
    }
  };

  const options: Array<{ value: Choice; label: string; description: string }> = [
    ...(Object.keys(BUILTIN_WRAPPERS) as BuiltinWrapperKey[]).map((k) => ({ value: k as Choice, label: BUILTIN_WRAPPERS[k].label, description: BUILTIN_WRAPPERS[k].description })),
    { value: 'repo', label: 'This newsletter’s template', description: 'The wrapper in this newsletter’s template repo (wrappers/default.html): branded header, footer and column.' },
  ];

  return (
    <section>
      <div className="mb-3">
        <h2 className="text-lg font-semibold text-[var(--gray-12)]">Email wrapper</h2>
        <p className="text-xs text-[var(--gray-9)] mt-0.5">The chrome every edition is sent in. Applies to the editor preview, the sent email and the web version.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {options.map((o) => {
          const active = choice === o.value;
          return (
            <button
              key={o.value}
              type="button"
              disabled={saving || choice === null}
              onClick={() => pick(o.value)}
              className={`text-left rounded-lg border px-4 py-3 transition-colors ${active ? 'border-[var(--accent-8)] bg-[var(--accent-a2)]' : 'border-[var(--gray-a4)] hover:bg-[var(--gray-a3)]'}`}
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
  );
};

export default BuiltInWrapperCard;
