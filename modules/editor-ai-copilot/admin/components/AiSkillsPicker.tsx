/**
 * Per-host skill picker — contributed via the platform's slot system.
 *
 * Per spec-ai-skills.md §8.2. Mounts in both
 *   - newsletter-detail:settings slot (host_kind = newsletter)
 *   - site-detail:settings slot      (host_kind = site)
 *
 * Slot props: `{ id: string, hostKind: 'newsletter' | 'site' }` —
 * passed by the host module via <ModuleSlot props={...} />. We render
 * a two-column "Active / Available" picker; clicking + moves a skill
 * into the active list, × moves it back; up/down arrows reorder
 * priority. Save is immediate (no save button) per the spec — every
 * change PATCHes the host row.
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

const TABLE_BY_HOST: Record<HostKind, string> = {
  newsletter: 'newsletters_template_collections',
  site: 'sites',
};

export default function AiSkillsPicker(props: SlotProps) {
  const hostKind: HostKind = props.hostKind ?? 'newsletter';
  const hostId = props.id;

  const [activeIds, setActiveIds] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState<SkillFull | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const hostTable = TABLE_BY_HOST[hostKind];
    const [hostRes, skillsRes] = await Promise.all([
      supabase.from(hostTable).select('active_skill_ids').eq('id', hostId).maybeSingle(),
      SkillsService.listSkills({ applies_to: [hostKind] }),
    ]);
    setLoading(false);
    if (hostRes.error) {
      toast.error(`Failed to load host: ${hostRes.error.message}`);
      return;
    }
    setActiveIds(((hostRes.data as { active_skill_ids?: string[] } | null)?.active_skill_ids ?? []));
    if (!skillsRes.ok) {
      toast.error(`Failed to load skills: ${skillsRes.error.message}`);
      return;
    }
    setSkills(skillsRes.value);
  }, [hostKind, hostId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Persist a new active_skill_ids array to the host row.
  const persist = useCallback(
    async (next: string[]) => {
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

  // Available = skills NOT in activeIds, filtered to those that apply to this host.
  const available = useMemo(() => {
    const set = new Set(activeIds);
    return skills
      .filter((s) => !set.has(s.id))
      .filter((s) => s.applies_to.length === 0 || s.applies_to.includes(hostKind));
  }, [skills, activeIds, hostKind]);

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
        Selected skills apply to every AI generation in this {hostKind}. First skill = highest priority.
        Manage which repos are available under <em>Admin → AI Skill Sources</em>.
      </p>

      {loading && <div className="flex justify-center py-4"><LoadingSpinner /></div>}

      {!loading && (
        <div className="grid gap-4">
          <section>
            <h4 className="text-xs font-medium uppercase tracking-wide text-[var(--gray-9)] mb-1">
              Active ({active.length})
            </h4>
            {active.length === 0 && (
              <div className="text-xs text-[var(--gray-9)] italic">No skills selected.</div>
            )}
            {active.map((s, idx) => (
              <div key={s.id} className="flex items-center gap-2 py-1 border-b border-[var(--gray-6)] last:border-b-0">
                <div className="flex-1 min-w-0">
                  <button type="button" onClick={() => void handlePreview(s.id)} className="text-left hover:underline">
                    <div className="text-sm font-medium truncate">{s.name}</div>
                  </button>
                  <div className="text-xs text-[var(--gray-9)] truncate">{s.source_label} · {s.path}</div>
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
                No additional skills available. Register a skill source under <em>Admin → AI Skill Sources</em>.
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
                  <div className="text-xs text-[var(--gray-9)] truncate">{s.source_label} · {s.path}</div>
                </div>
              </div>
            ))}
          </section>
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
      <Card className="w-full max-w-2xl max-h-[80vh] overflow-auto p-6 bg-[var(--gray-1)]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-3">
          <div>
            <h3 className="font-semibold">{skill.name}</h3>
            <p className="text-xs text-[var(--gray-9)]">{skill.path}</p>
          </div>
          <Button onClick={onClose}><XMarkIcon className="w-4 h-4" /></Button>
        </div>
        {skill.description && <p className="text-sm text-[var(--gray-9)] mb-4">{skill.description}</p>}
        <pre className="text-xs whitespace-pre-wrap font-mono bg-[var(--gray-3)] p-3 rounded">{skill.body}</pre>
      </Card>
    </div>
  );
}
