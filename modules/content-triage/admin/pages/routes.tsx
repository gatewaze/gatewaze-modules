import { useCallback, useEffect, useState } from 'react';
import { TrashIcon } from '@heroicons/react/24/outline';
import { Badge, Button, Card, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { TriageService, TriageRoute } from '../utils/triageService';

const inputClass =
  'w-full px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

export default function TriageRoutesPage() {
  const [routes, setRoutes] = useState<TriageRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [draft, setDraft] = useState<Partial<TriageRoute>>({
    name: '', priority: 100, active: true, notify_channels: ['in_app'],
  });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await TriageService.routes();
      setRoutes(res.routes);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function toggleActive(r: TriageRoute) {
    await TriageService.updateRoute(r.id, { active: !r.active });
    load();
  }
  async function del(r: TriageRoute) {
    if (!confirm(`Delete route "${r.name}"?`)) return;
    await TriageService.deleteRoute(r.id);
    load();
  }
  async function create() {
    setError(null);
    try {
      await TriageService.createRoute(draft);
      setShowNew(false);
      setDraft({ name: '', priority: 100, active: true, notify_channels: ['in_app'] });
      load();
    } catch (e: any) { setError(e.message); }
  }

  return (
    <Page title="Triage Routes">
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Triage Routes</h1>
            <p className="text-sm text-[var(--gray-11)]">Auto-assignment rules. First match by priority wins.</p>
          </div>
          <Button onClick={() => setShowNew(true)}>New route</Button>
        </div>

        {error && (
          <div className="p-3 mb-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">{error}</div>
        )}

        {showNew && (
          <Card variant="surface" className="p-4 mb-4">
            <h3 className="font-semibold mb-2">New route</h3>
            <div className="grid grid-cols-2 gap-3">
              <label className="block"><span className="block text-xs mb-1">Name *</span>
                <input className={inputClass} value={draft.name ?? ''} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="block"><span className="block text-xs mb-1">Priority</span>
                <input type="number" className={inputClass} value={draft.priority ?? 100} onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })} />
              </label>
              <label className="block"><span className="block text-xs mb-1">Content type (blank = any)</span>
                <input className={inputClass} value={draft.content_type ?? ''} onChange={(e) => setDraft({ ...draft, content_type: e.target.value || null })} />
              </label>
              <label className="block"><span className="block text-xs mb-1">Source (blank = any)</span>
                <input className={inputClass} value={draft.source ?? ''} onChange={(e) => setDraft({ ...draft, source: e.target.value || null })} />
              </label>
              <label className="block"><span className="block text-xs mb-1">Category match (blank = any)</span>
                <input className={inputClass} value={draft.category ?? ''} onChange={(e) => setDraft({ ...draft, category: e.target.value || null })} />
              </label>
              <label className="block"><span className="block text-xs mb-1">Mode override</span>
                <select className={inputClass} value={draft.mode_override ?? ''} onChange={(e) => setDraft({ ...draft, mode_override: (e.target.value || null) as any })}>
                  <option value="">(don't override)</option>
                  <option value="auto_publish">auto_publish</option>
                  <option value="auto_approve">auto_approve</option>
                  <option value="review">review</option>
                </select>
              </label>
              <label className="block col-span-2"><span className="block text-xs mb-1">Assign to (user id)</span>
                <input className={inputClass} value={draft.assign_to ?? ''} onChange={(e) => setDraft({ ...draft, assign_to: e.target.value || null })} />
              </label>
              <label className="block col-span-2"><span className="block text-xs mb-1">Or team name</span>
                <input className={inputClass} value={draft.assign_to_team_name ?? ''} onChange={(e) => setDraft({ ...draft, assign_to_team_name: e.target.value || null })} />
              </label>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="solid" onClick={create}>Create</Button>
              <Button variant="outline" onClick={() => setShowNew(false)}>Cancel</Button>
            </div>
          </Card>
        )}

        <Card variant="surface" className="p-0 overflow-hidden">
          <Table>
            <THead>
              <Tr><Th>Name</Th><Th>Match</Th><Th>Mode</Th><Th>Assign</Th><Th>Priority</Th><Th>Active</Th><Th></Th></Tr>
            </THead>
            <TBody>
              {loading && <Tr><Td colSpan={7}>Loading…</Td></Tr>}
              {!loading && routes.length === 0 && (
                <Tr><Td colSpan={7} className="text-center py-6 text-[var(--gray-10)]">No routes yet.</Td></Tr>
              )}
              {routes.map((r) => (
                <Tr key={r.id}>
                  <Td><strong>{r.name}</strong>{r.description && <div className="text-xs text-[var(--gray-10)]">{r.description}</div>}</Td>
                  <Td className="text-xs">
                    {[r.content_type && `type=${r.content_type}`, r.source && `source=${r.source}`, r.category && `cat=${r.category}`].filter(Boolean).join(' · ') || <span className="text-[var(--gray-9)]">any</span>}
                  </Td>
                  <Td><Badge variant="soft">{r.mode_override ?? '—'}</Badge></Td>
                  <Td className="text-xs">{r.assign_to ? r.assign_to.slice(0, 8) + '…' : r.assign_to_team_name ? `team: ${r.assign_to_team_name}` : '—'}</Td>
                  <Td>{r.priority}</Td>
                  <Td><Button variant="ghost" size="1" onClick={() => toggleActive(r)}>{r.active ? 'on' : 'off'}</Button></Td>
                  <Td><button onClick={() => del(r)} className="text-red-600"><TrashIcon className="size-4" /></button></Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>
      </div>
    </Page>
  );
}
