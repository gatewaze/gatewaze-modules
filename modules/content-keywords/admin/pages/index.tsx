import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Table, THead, TBody, Tr, Th, Td } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { keywordRulesService, type KeywordRule, type AdapterRow, type RecomputeJob } from '../utils/keywordRulesService';
import { RuleEditorDrawer } from '../components/RuleEditorDrawer';

const inputClass =
  'w-full px-3 py-1.5 border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent-8)]';

export default function KeywordRulesPage() {
  const [rules, setRules] = useState<KeywordRule[]>([]);
  const [adapters, setAdapters] = useState<AdapterRow[]>([]);
  const [recomputeJobs, setRecomputeJobs] = useState<RecomputeJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterContentType, setFilterContentType] = useState('');
  const [filterActive, setFilterActive] = useState<'true' | 'false' | 'all'>('all');
  const [editingRule, setEditingRule] = useState<KeywordRule | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [r, a, j] = await Promise.all([
        keywordRulesService.listRules({
          content_type: filterContentType || undefined,
          is_active: filterActive,
          limit: 100,
        }),
        keywordRulesService.listAdapters(),
        keywordRulesService.listRecomputes(),
      ]);
      setRules(r.data);
      setAdapters(a);
      setRecomputeJobs(j.slice(0, 5));
    } finally {
      setLoading(false);
    }
  }, [filterContentType, filterActive]);

  useEffect(() => { load(); }, [load]);

  const onSaved = useCallback(() => {
    setEditingRule(null);
    setCreatingNew(false);
    load();
  }, [load]);

  const toggleActive = useCallback(async (rule: KeywordRule) => {
    await keywordRulesService.setActive(rule.id, !rule.is_active);
    load();
  }, [load]);

  const requestRecomputeAll = useCallback(async () => {
    const types = adapters.map(a => a.content_type);
    if (types.length === 0) return;
    try {
      await keywordRulesService.requestRecompute(types, { force: false });
      load();
    } catch (err: any) {
      // Surface a stuck-job offer when the API returns recompute_in_progress.
      const msg = String(err?.message ?? err);
      const stuckMatch = msg.match(/recompute_in_progress:?\s*([0-9a-f-]{8,})/i);
      if (stuckMatch) {
        if (confirm(`Another recompute is already pending/running (${stuckMatch[1].slice(0, 8)}…). Cancel it and start a new one?`)) {
          try {
            await keywordRulesService.deleteRecompute(stuckMatch[1]);
            await keywordRulesService.requestRecompute(types, { force: false });
            load();
            return;
          } catch (delErr: any) {
            alert(`Cancel failed: ${delErr.message ?? delErr}`);
            return;
          }
        }
        return;
      }
      alert(`Recompute failed: ${msg}`);
    }
  }, [adapters, load]);

  const cancelJob = useCallback(async (job: RecomputeJob) => {
    if (!confirm(`Delete recompute job ${job.id.slice(0, 8)}…? Status: ${job.status}`)) return;
    try {
      await keywordRulesService.deleteRecompute(job.id, {
        // Force when the job is in a terminal status so we can clean up
        // history rows the UI is showing.
        force: ['complete', 'complete_with_errors', 'failed', 'cancelled'].includes(job.status),
      });
      load();
    } catch (err: any) {
      alert(`Delete failed: ${err.message ?? err}`);
    }
  }, [load]);

  const clearStuck = useCallback(async () => {
    try {
      const result = await keywordRulesService.clearStuckRecomputes();
      if (result.cleared === 0) {
        alert('No stuck jobs to clear.');
      } else {
        alert(`Cleared ${result.cleared} stuck job(s).`);
      }
      load();
    } catch (err: any) {
      alert(`Clear failed: ${err.message ?? err}`);
    }
  }, [load]);

  const ruleBadge = (rule: KeywordRule) =>
    rule.is_active
      ? <Badge variant="soft" color="green">Active</Badge>
      : <Badge variant="soft" color="gray">Inactive</Badge>;

  const patternTypeBadge = (t: KeywordRule['pattern_type']) => {
    const colors = { substring: 'blue', word: 'cyan', regex: 'orange' } as const;
    return <Badge variant="soft" color={colors[t]}>{t}</Badge>;
  };

  return (
    <Page title="Content Keywords">
      <div className="p-6">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold mb-1">Content Keywords</h1>
            <p className="text-sm text-[var(--gray-11)]">
              Centrally-managed keyword rules. Edits apply retroactively across all governed content types.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={requestRecomputeAll} variant="soft">Recompute all</Button>
            <Button onClick={() => setCreatingNew(true)}>+ New rule</Button>
          </div>
        </div>

        {/* Adapter cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
          {adapters.map(a => (
            <Card key={a.content_type} className="p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-medium">{a.display_label}</h3>
                <code className="text-xs text-[var(--gray-10)]">{a.content_type}</code>
              </div>
              <div className="text-sm text-[var(--gray-11)] space-y-1">
                <div>Total: {a.current_total_count ?? '—'}</div>
                <div>Visible: {a.current_visible_count ?? '—'}</div>
                <div>Stale: {a.stale_state_count ?? 0}</div>
                <div className="text-xs">Default: {a.default_visible_when_no_rules ? 'visible' : 'hidden'}</div>
              </div>
            </Card>
          ))}
        </div>

        {/* Recent recomputes */}
        {recomputeJobs.length > 0 && (
          <Card className="p-4 mb-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium">Recent recompute jobs</h3>
              {recomputeJobs.some(j => j.status === 'pending' || j.status === 'running') && (
                <Button size="1" variant="soft" color="amber" onClick={clearStuck}>
                  Clear stuck (&gt;10 min)
                </Button>
              )}
            </div>
            <div className="text-sm space-y-1">
              {recomputeJobs.map(j => (
                <div key={j.id} className="flex items-center justify-between gap-4 py-1 border-b border-[var(--gray-a4)] last:border-0">
                  <code className="text-xs flex-shrink-0">{j.id.slice(0, 8)}</code>
                  <span className="flex-1 truncate">{(j.content_types ?? []).join(', ')}</span>
                  <span className="flex-shrink-0">
                    <Badge variant="soft" color={j.status === 'complete' ? 'green' : j.status === 'failed' ? 'red' : 'amber'}>
                      {j.status}
                    </Badge>
                  </span>
                  <span className="text-[var(--gray-10)] flex-shrink-0 w-20 text-right">{j.rows_processed} rows</span>
                  <button
                    onClick={() => cancelJob(j)}
                    className="flex-shrink-0 text-xs text-[var(--gray-10)] hover:text-red-500 transition-colors px-1.5 py-0.5 rounded hover:bg-red-500/10"
                    title={['pending', 'running'].includes(j.status) ? 'Cancel job' : 'Delete history row'}
                  >
                    {['pending', 'running'].includes(j.status) ? 'Cancel' : 'Delete'}
                  </button>
                </div>
              ))}
            </div>
          </Card>
        )}

        {/* Filters */}
        <div className="flex gap-2 mb-4">
          <select className={inputClass} value={filterContentType} onChange={e => setFilterContentType(e.target.value)} style={{ maxWidth: 240 }}>
            <option value="">All content types</option>
            {adapters.map(a => <option key={a.content_type} value={a.content_type}>{a.display_label}</option>)}
          </select>
          <select className={inputClass} value={filterActive} onChange={e => setFilterActive(e.target.value as any)} style={{ maxWidth: 200 }}>
            <option value="all">Active + inactive</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </select>
        </div>

        {/* Rules table */}
        <Card>
          {loading ? <div className="p-8 text-center text-sm text-[var(--gray-11)]">Loading…</div> : (
            <Table>
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Pattern</Th>
                  <Th>Type</Th>
                  <Th>Content types</Th>
                  <Th>Sources</Th>
                  <Th>Fields</Th>
                  <Th>Status</Th>
                  <Th>Actions</Th>
                </Tr>
              </THead>
              <TBody>
                {rules.map(r => (
                  <Tr key={r.id} className="cursor-pointer hover:bg-[var(--gray-a3)]" onClick={() => setEditingRule(r)}>
                    <Td><span className="font-medium">{r.name}</span></Td>
                    <Td><code className="text-xs">{r.pattern}</code></Td>
                    <Td>{patternTypeBadge(r.pattern_type)}</Td>
                    <Td className="text-xs">{r.content_types.join(', ')}</Td>
                    <Td className="text-xs">{r.sources?.join(', ') ?? '—'}</Td>
                    <Td className="text-xs">{r.fields.join(', ')}</Td>
                    <Td>{ruleBadge(r)}</Td>
                    <Td onClick={e => e.stopPropagation()}>
                      <Button size="sm" variant="ghost" onClick={() => toggleActive(r)}>
                        {r.is_active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </Td>
                  </Tr>
                ))}
                {rules.length === 0 && (
                  <Tr><Td colSpan={8} className="text-center text-sm text-[var(--gray-11)] py-8">
                    No rules. Create one to start filtering content visibility.
                  </Td></Tr>
                )}
              </TBody>
            </Table>
          )}
        </Card>
      </div>

      {(editingRule || creatingNew) && (
        <RuleEditorDrawer
          rule={editingRule}
          adapters={adapters}
          onClose={() => { setEditingRule(null); setCreatingNew(false); }}
          onSaved={onSaved}
        />
      )}
    </Page>
  );
}
