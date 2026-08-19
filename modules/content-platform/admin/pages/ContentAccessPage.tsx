import { useEffect, useMemo, useState } from 'react';
import { Card, Button, Select, Input, Badge } from '@/components/ui';
import {
  contentAccessService,
  type ContentAccessPolicy,
  type AccessTier,
} from '@/components/content-access/contentAccessService';

// Central management view for the content_access_policies registry — every gate
// (per-item and per-type) in one place. The inline controls in each editor write
// the same rows; this page lists/edits/removes them and adds type-wide defaults.

const CONTENT_TYPES: { value: string; label: string }[] = [
  { value: 'newsletter_edition', label: 'Newsletter edition' },
  { value: 'blog_post', label: 'Blog post' },
  { value: 'resource', label: 'Resource item' },
  { value: 'podcast_episode', label: 'Podcast episode' },
  { value: 'event', label: 'Event (registration)' },
];

function ruleSummary(p: ContentAccessPolicy, tierLabel: (rank: number) => string): string {
  if (p.gated_actions?.includes('register')) {
    return `Registration: members only${p.min_tier_rank ? ` (${tierLabel(p.min_tier_rank)})` : ''}`;
  }
  if (p.embargo_days) {
    return `Members-only for ${p.embargo_days} day(s)${p.min_tier_rank ? ` (${tierLabel(p.min_tier_rank)})` : ''}, then public`;
  }
  if (p.audience === 'members') {
    return `Members only${p.min_tier_rank ? ` (${tierLabel(p.min_tier_rank)})` : ' (any member)'}`;
  }
  return 'Public';
}

export default function ContentAccessPage() {
  const [policies, setPolicies] = useState<ContentAccessPolicy[]>([]);
  const [tiers, setTiers] = useState<AccessTier[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // add-rule form
  const [addType, setAddType] = useState('newsletter_edition');
  const [addScope, setAddScope] = useState<'type' | 'item'>('item');
  const [addEntityId, setAddEntityId] = useState('');
  const [addTierRank, setAddTierRank] = useState(0);

  const tierLabel = useMemo(() => {
    const byRank = new Map(tiers.map((t) => [t.rank, t.display_label]));
    return (rank: number) => byRank.get(rank) ?? `tier ≥ ${rank}`;
  }, [tiers]);

  const tierOptions = useMemo(
    () => [{ value: 0, label: 'Any member' }, ...tiers.map((t) => ({ value: t.rank, label: `${t.display_label} or higher` }))],
    [tiers],
  );

  async function refresh() {
    setLoading(true); setErr(null);
    try {
      const [pol, t] = await Promise.all([contentAccessService.listPolicies(), contentAccessService.listTiers()]);
      setPolicies(pol); setTiers(t);
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  async function remove(p: ContentAccessPolicy) {
    setBusy(true);
    try { await contentAccessService.clearPolicy(p.content_type, p.entity_id); await refresh(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  async function add() {
    setBusy(true); setErr(null);
    try {
      const entity_id = addScope === 'item' ? addEntityId.trim() : null;
      if (addScope === 'item' && !entity_id) { setErr('Enter an item id, or choose "All of this type".'); setBusy(false); return; }
      const isEvent = addType === 'event';
      await contentAccessService.setPolicy({
        content_type: addType,
        entity_id,
        audience: isEvent ? 'public' : 'members',
        min_tier_rank: addTierRank,
        gated_actions: isEvent ? ['register'] : [],
        note: 'Added from Content Access page',
      });
      setAddEntityId('');
      await refresh();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold text-[var(--gray-12)]">Content Access</h1>
        <p className="text-sm text-[var(--gray-a10)] mt-1">
          Every member-gating rule in one place. Rules apply to a single item (per-item override) or to a whole
          content type (default). Editors also set these inline on each piece of content.
        </p>
      </div>

      {err && <p className="text-sm text-[var(--red-9)]">{err}</p>}

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-3">Add a rule</h2>
        <div className="flex flex-wrap items-end gap-3">
          <Select label="Content type" value={addType} data={CONTENT_TYPES}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAddType(e.target.value)} />
          <Select label="Applies to" value={addScope} data={[{ value: 'item', label: 'A specific item' }, { value: 'type', label: 'All of this type' }]}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAddScope(e.target.value as 'type' | 'item')} />
          {addScope === 'item' && (
            <Input label="Item id (uuid)" value={addEntityId} placeholder="00000000-0000-…"
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAddEntityId(e.target.value)} />
          )}
          <Select label="Minimum tier" value={addTierRank} data={tierOptions}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setAddTierRank(Number(e.target.value))} />
          <Button onClick={() => void add()} disabled={busy}>
            {addType === 'event' ? 'Gate registration' : 'Make members-only'}
          </Button>
        </div>
        <p className="text-xs text-[var(--gray-a10)] mt-2">
          Events keep public visibility and gate the <b>register</b> action; other types gate visibility.
        </p>
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-3">Active rules ({policies.length})</h2>
        {loading ? (
          <p className="text-sm text-[var(--gray-a10)]">Loading…</p>
        ) : policies.length === 0 ? (
          <p className="text-sm text-[var(--gray-a10)]">No gating rules yet — all content is public.</p>
        ) : (
          <div className="divide-y divide-[var(--gray-a4)]">
            {policies.map((p) => (
              <div key={p.id} className="flex items-center justify-between py-2 gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge>{CONTENT_TYPES.find((t) => t.value === p.content_type)?.label ?? p.content_type}</Badge>
                    <span className="text-xs text-[var(--gray-a10)] truncate">
                      {p.entity_id ? `item ${p.entity_id.slice(0, 8)}…` : 'All of this type'}
                    </span>
                  </div>
                  <div className="text-sm text-[var(--gray-12)] mt-0.5">{ruleSummary(p, tierLabel)}</div>
                  {p.note && <div className="text-xs text-[var(--gray-a9)]">{p.note}</div>}
                </div>
                <Button variant="soft" color="red" onClick={() => void remove(p)} disabled={busy}>Remove</Button>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
