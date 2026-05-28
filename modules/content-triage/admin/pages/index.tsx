import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { TriageService, TriageItem, STATUS_OPTIONS } from '../utils/triageService';
import { TriageDrawer } from '../components/TriageDrawer';

const inputClass =
  'w-full px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

export default function TriageQueuePage() {
  const [items, setItems] = useState<TriageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<string>('pending');
  const [assignedTo, setAssignedTo] = useState<string>('');    // '', 'me', 'unassigned'
  const [contentType, setContentType] = useState<string>('');
  const [source, setSource] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stats, setStats] = useState<Record<string, number>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await TriageService.list({
        status: status || undefined,
        assignedTo: assignedTo || undefined,
        contentType: contentType || undefined,
        source: source || undefined,
        limit: 100,
      });
      setItems(res.items);
    } finally {
      setLoading(false);
    }
  }, [status, assignedTo, contentType, source]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    TriageService.stats().then((s) => setStats(s.byStatus)).catch(() => {});
  }, []);

  const statusBadge = (s: TriageItem['status']) => {
    const opt = STATUS_OPTIONS.find((o) => o.value === s) ?? STATUS_OPTIONS[0];
    return <Badge variant="soft" color={opt.color as any}>{opt.label}</Badge>;
  };

  const pendingCount = stats.pending ?? 0;

  const onActioned = useCallback((_id: string) => {
    setSelectedId(null);
    load();
    TriageService.stats().then((s) => setStats(s.byStatus)).catch(() => {});
  }, [load]);

  const sourceLabel = useMemo(() => (row: TriageItem) =>
    row.source + (row.source_ref ? ` · ${row.source_ref}` : ''), []);

  return (
    <Page title="Content Triage">
      <div className="p-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-[var(--gray-12)]">Content Triage</h1>
            <p className="text-[var(--gray-11)] mt-1">
              Human review gate for scraped and submitted content. {pendingCount} pending.
            </p>
          </div>
          <div className="flex gap-2">
            {STATUS_OPTIONS.map((o) => (
              <Card key={o.value} variant="surface" className="px-3 py-1">
                <span className="text-xs text-[var(--gray-10)]">{o.label}: </span>
                <span className="font-semibold">{stats[o.value] ?? 0}</span>
              </Card>
            ))}
          </div>
        </div>

        <div className="flex gap-3 mb-4">
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputClass} max-w-xs`}>
            <option value="">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className={`${inputClass} max-w-xs`}>
            <option value="">All assignees</option>
            <option value="me">Assigned to me</option>
            <option value="unassigned">Unassigned</option>
          </select>
          <input
            type="text"
            value={contentType}
            onChange={(e) => setContentType(e.target.value)}
            placeholder="content type (e.g. event)"
            className={`${inputClass} max-w-xs`}
          />
          <input
            type="text"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="source (e.g. scraper)"
            className={`${inputClass} max-w-xs`}
          />
          <Button variant="outline" onClick={load}>Refresh</Button>
        </div>

        <Card variant="surface" className="p-0 overflow-hidden">
          <Table>
            <THead>
              <Tr>
                <Th>Type</Th>
                <Th>Source</Th>
                <Th>Priority</Th>
                <Th>Suggested</Th>
                <Th>Status</Th>
                <Th>Assigned</Th>
                <Th>Age</Th>
              </Tr>
            </THead>
            <TBody>
              {loading && (
                <Tr><Td colSpan={7} className="text-center py-6 text-[var(--gray-10)]">Loading…</Td></Tr>
              )}
              {!loading && items.length === 0 && (
                <Tr><Td colSpan={7} className="text-center py-6 text-[var(--gray-10)]">
                  No items match. Try a different filter, or wait for scrapers to submit content.
                </Td></Tr>
              )}
              {items.map((i) => (
                <Tr key={i.id} className="cursor-pointer hover:bg-[var(--gray-a2)]" onClick={() => setSelectedId(i.id)}>
                  <Td><span className="font-medium">{i.content_type}</span></Td>
                  <Td className="text-sm text-[var(--gray-11)]">{sourceLabel(i)}</Td>
                  <Td>{i.priority}{i.is_featured ? ' ★' : ''}</Td>
                  <Td className="text-xs">
                    {i.suggested_categories.length > 0
                      ? <><span className="text-[var(--gray-10)]">{i.suggested_from}:</span> {i.suggested_categories.join(', ')}</>
                      : <span className="text-[var(--gray-9)]">—</span>}
                  </Td>
                  <Td>{statusBadge(i.status)}</Td>
                  <Td className="text-xs">{i.assigned_to ? 'user' : i.team_name ? `team: ${i.team_name}` : <span className="text-[var(--gray-9)]">—</span>}</Td>
                  <Td className="text-xs text-[var(--gray-10)]">{new Date(i.created_at).toLocaleString()}</Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>

        {selectedId && (
          <TriageDrawer itemId={selectedId} onClose={() => setSelectedId(null)} onActioned={onActioned} />
        )}
      </div>
    </Page>
  );
}
