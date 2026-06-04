/**
 * Per-host skill picker — contributed via the platform's slot system.
 *
 * Per spec-ai-skills.md §8.2. Mounts in both
 *   - newsletter-detail:settings slot (host_kind = newsletter)
 *   - site-detail:settings slot      (host_kind = site)
 *
 * Slot props: `{ id: string, hostKind: 'newsletter' | 'site' }` —
 * passed by the host module via <ModuleSlot props={...} />.
 *
 * Inherit / Override model (migration 005):
 *   - `active_skill_ids = NULL` → INHERIT the use case's default brand
 *     skill (configured under Admin → AI → Use cases). The default row
 *     is shown read-only.
 *   - `active_skill_ids = []`   → explicit opt-out (no skills).
 *   - `active_skill_ids = [...]`→ override with this ordered list.
 *
 * The two-column Active / Available picker is shown only in Override
 * mode; clicking + moves a skill into the active list, × moves it back;
 * up/down arrows reorder priority. Every change PATCHes the host row.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { Card, Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { ChevronUpIcon, ChevronDownIcon, XMarkIcon, PlusIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { SkillsService, type SkillListItem, type SkillFull } from '../services/skillsService';

interface SlotProps {
  /** Host id — newsletter collection id, or site id. */
  id: string;
  /** Discriminator from the host module's <ModuleSlot props={…} />. */
  hostKind?: 'newsletter' | 'site';
}

type HostKind = 'newsletter' | 'site';
type Mode = 'inherit' | 'override';

const TABLE_BY_HOST: Record<HostKind, string> = {
  newsletter: 'newsletters_template_collections',
  site: 'sites',
};

// Mirror of editor-ai-copilot/lib/use-case.ts. Inlined to avoid an
// admin→lib cross-boundary import (admin is bundled by the consuming
// admin app, lib by the API).
const USE_CASE_BY_HOST: Record<HostKind, string> = {
  newsletter: 'newsletter-editor',
  site: 'site-editor',
};

export default function AiSkillsPicker(props: SlotProps) {
  const hostKind: HostKind = props.hostKind ?? 'newsletter';
  const hostId = props.id;

  // `null` activeIds = inherit; an array (possibly empty) = override.
  const [mode, setMode] = useState<Mode>('inherit');
  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [defaultSkill, setDefaultSkill] = useState<SkillListItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState<SkillFull | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const hostTable = TABLE_BY_HOST[hostKind];
    const [hostRes, skillsRes, defaultRes] = await Promise.all([
      supabase.from(hostTable).select('active_skill_ids').eq('id', hostId).maybeSingle(),
      SkillsService.listSkills(),
      SkillsService.readUseCaseDefaultSkill(USE_CASE_BY_HOST[hostKind]),
    ]);
    setLoading(false);
    if (hostRes.error) {
      toast.error(`Failed to load host: ${hostRes.error.message}`);
      return;
    }
    const stored = (hostRes.data as { active_skill_ids?: string[] | null } | null)?.active_skill_ids;
    if (stored == null) {
      setMode('inherit');
      setActiveIds([]);
    } else {
      setMode('override');
      setActiveIds(stored);
    }
    if (!skillsRes.ok) {
      toast.error(`Failed to load skills: ${skillsRes.error.message}`);
      return;
    }
    setSkills(skillsRes.value);
    setDefaultSkill(defaultRes.ok ? defaultRes.value : null);
  }, [hostKind, hostId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Persist the host row. `null` = inherit; an array = override.
  const persist = useCallback(
    async (next: string[] | null) => {
      setSaving(true);
      const hostTable = TABLE_BY_HOST[hostKind];
      const { error } = await supabase.from(hostTable).update({ active_skill_ids: next }).eq('id', hostId);
      setSaving(false);
      if (error) {
        toast.error(`Save failed: ${error.message}`);
        return false;
      }
      return true;
    },
    [hostKind, hostId],
  );

  // Active list = skills present in activeIds (in priority order).
  const active = useMemo(() => {
    const byId = new Map(skills.map((s) => [s.id, s]));
    return activeIds.map((id) => byId.get(id)).filter((s): s is SkillListItem => s != null);
  }, [skills, activeIds]);

  // Available = skills NOT in activeIds.
  const available = useMemo(() => {
    const set = new Set(activeIds);
    return skills.filter((s) => !set.has(s.id));
  }, [skills, activeIds]);

  async function switchMode(next: Mode): Promise<void> {
    if (next === mode) return;
    if (next === 'inherit') {
      if (await persist(null)) {
        setMode('inherit');
        setActiveIds([]);
      }
    } else {
      // Entering override starts from the default skill (if any) so the
      // operator tweaks from a sensible base rather than an empty list.
      const seed = defaultSkill ? [defaultSkill.id] : [];
      if (await persist(seed)) {
        setMode('override');
        setActiveIds(seed);
      }
    }
  }

  async function handleAdd(skillId: string): Promise<void> {
    const next = [...activeIds, skillId];
    if (await persist(next)) setActiveIds(next);
  }
  async function handleRemove(skillId: string): Promise<void> {
    const next = activeIds.filter((id) => id !== skillId);
    if (await persist(next)) setActiveIds(next);
  }
  async function handleMove(skillId: string, delta: -1 | 1): Promise<void> {
    const idx = activeIds.indexOf(skillId);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= activeIds.length) return;
    const next = [...activeIds];
    [next[idx], next[target]] = [next[target]!, next[idx]!];
    if (await persist(next)) setActiveIds(next);
  }
  async function handlePreview(skillId: string): Promise<void> {
    const r = await SkillsService.readSkill(skillId);
    if (!r.ok) {
      toast.error(`Preview failed: ${r.error.message}`);
      return;
    }
    setPreviewing(r.value);
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="font-semibold flex items-center gap-2 text-sm">
          <SparklesIcon className="w-4 h-4" /> AI Skills
        </h3>
        {saving && <span className="text-xs text-[var(--gray-9)]">Saving…</span>}
      </div>
      <p className="text-xs text-[var(--gray-9)] mb-3">
        Skills inject brand voice + structure rules into every AI generation in this {hostKind}.
        Manage which repos are available under <em>Admin → AI → Skill Sources</em>; set the
        per-{hostKind} default under <em>Admin → AI → Use cases</em>.
      </p>

      {loading && <div className="flex justify-center py-4"><LoadingSpinner /></div>}

      {!loading && (
        <div className="grid gap-4">
          <section>
            <div role="radiogroup" className="flex flex-col gap-1.5 text-sm">
              <label className="inline-flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  className="mt-0.5"
                  name={`skills-mode-${hostId}`}
                  checked={mode === 'inherit'}
                  disabled={saving}
                  onChange={() => void switchMode('inherit')}
                />
                <span>
                  <span className="font-medium">Use default</span>
                  <span className="text-xs text-[var(--gray-9)]">
                    {' — '}
                    {defaultSkill
                      ? <>inherits <code className="font-mono">{defaultSkill.name}</code> from the {hostKind} use case</>
                      : <>no default skill is configured for the {hostKind} use case</>}
                  </span>
                </span>
              </label>
              <label className="inline-flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  className="mt-0.5"
                  name={`skills-mode-${hostId}`}
                  checked={mode === 'override'}
                  disabled={saving}
                  onChange={() => void switchMode('override')}
                />
                <span>
                  <span className="font-medium">Override</span>
                  <span className="text-xs text-[var(--gray-9)]"> — pick skills for this {hostKind} (empty = no skills)</span>
                </span>
              </label>
            </div>
          </section>

          {mode === 'override' && (
            <>
              <section>
                <h4 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-9)] mb-1">
                  Active ({active.length})
                </h4>
                {active.length === 0 && (
                  <div className="text-xs text-[var(--gray-9)] italic">No skills selected — this {hostKind} will run with no brand skills.</div>
                )}
                {active.map((s, idx) => (
                  <div key={s.id} className="flex items-center gap-2 py-1 border-b border-[var(--gray-6)] last:border-b-0">
                    <div className="flex-1 min-w-0">
                      <button type="button" onClick={() => void handlePreview(s.id)} className="text-left hover:underline">
                        <div className="text-sm font-medium truncate">{s.name}</div>
                      </button>
                      <div className="text-xs text-[var(--gray-9)] truncate">{s.source_label} · {s.dir_path}</div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <Button onClick={() => void handleMove(s.id, -1)} disabled={idx === 0}>
                        <ChevronUpIcon className="w-3 h-3" />
                      </Button>
                      <Button onClick={() => void handleMove(s.id, 1)} disabled={idx === active.length - 1}>
                        <ChevronDownIcon className="w-3 h-3" />
                      </Button>
                      <Button onClick={() => void handleRemove(s.id)}>
                        <XMarkIcon className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </section>

              <section>
                <h4 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-9)] mb-1">
                  Available ({available.length})
                </h4>
                {available.length === 0 && (
                  <div className="text-xs text-[var(--gray-9)] italic">
                    No additional skills available. Register a skill source under <em>Admin → AI → Skill Sources</em>.
                  </div>
                )}
                {available.map((s) => (
                  <div key={s.id} className="flex items-center gap-2 py-1 border-b border-[var(--gray-6)] last:border-b-0">
                    <Button onClick={() => void handleAdd(s.id)}>
                      <PlusIcon className="w-3 h-3" />
                    </Button>
                    <div className="flex-1 min-w-0">
                      <button type="button" onClick={() => void handlePreview(s.id)} className="text-left hover:underline">
                        <div className="text-sm font-medium truncate">{s.name}</div>
                      </button>
                      <div className="text-xs text-[var(--gray-9)] truncate">{s.source_label} · {s.dir_path}</div>
                    </div>
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      )}

      {previewing && (
        <PreviewDrawer skill={previewing} onClose={() => setPreviewing(null)} />
      )}
    </Card>
  );
}

function PreviewDrawer({ skill, onClose }: { skill: SkillFull; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <Card className="w-full max-w-2xl max-h-[80vh] overflow-auto p-6 bg-[var(--gray-1)]" onClick={(e: { stopPropagation: () => void }) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold">{skill.name}</h3>
            <p className="text-xs text-[var(--gray-9)]">{skill.dir_path}</p>
          </div>
          <Button onClick={onClose}><XMarkIcon className="w-4 h-4" /></Button>
        </div>
        {skill.description && <p className="text-sm text-[var(--gray-9)] mb-4">{skill.description}</p>}
        <pre className="text-xs whitespace-pre-wrap font-mono bg-[var(--gray-3)] p-3 rounded">{skill.body}</pre>
      </Card>
    </div>
  );
}
