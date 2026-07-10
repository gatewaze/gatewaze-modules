import React, { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { PlusIcon, PencilIcon, TrashIcon, BoltIcon, SignalIcon } from '@heroicons/react/24/outline';
import { Modal, Button, Input, Card, Badge, ConfirmModal, Select, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { SignalsService, SignalsRule, SignalsFire, SignalsRuleStats } from '../utils/signalsService';

// Signals admin: rules (create/edit/pause), the fires log, and per-rule
// telemetry. Rule definitions edit as JSON — the definition contract is the
// engine's (topics, content, audience, channel, frequency_cap); the manage
// API and MCP tools validate the same shape.

const DEFINITION_TEMPLATE = JSON.stringify({
  topics: ['voice-agents'],
  min_overlap: 1,
  min_weight: 1,
  content: { types: ['sr_item', 'event'], hrefs: [] },
  audience: { per_person: true, max: 200, segment_id: null },
  channel: { type: 'log', config: {} },
  frequency_cap: { per_person_days: 30 },
  interval_minutes: 1440,
}, null, 2);

const statusColor = (s: string) =>
  s === 'active' || s === 'dispatched' ? 'success'
  : s === 'failed' ? 'error'
  : s === 'paused' || s === 'suppressed' ? 'neutral'
  : 'warning';

const SignalsPage: React.FC = () => {
  const [tab, setTab] = useState<'rules' | 'fires' | 'stats'>('rules');
  const [rules, setRules] = useState<SignalsRule[]>([]);
  const [fires, setFires] = useState<SignalsFire[]>([]);
  const [stats, setStats] = useState<SignalsRuleStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<SignalsRule | null>(null);
  const [deleting, setDeleting] = useState<SignalsRule | null>(null);
  const [form, setForm] = useState({ name: '', description: '', definition: DEFINITION_TEMPLATE });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const [r, f, s] = await Promise.all([SignalsService.rules(), SignalsService.fires(), SignalsService.stats()]);
    if (r.success && r.data) setRules(r.data); else toast.error(r.error || 'Failed to load rules');
    if (f.success && f.data) setFires(f.data);
    if (s.success && s.data) setStats(s.data);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', description: '', definition: DEFINITION_TEMPLATE });
    setShowModal(true);
  };

  const openEdit = (rule: SignalsRule) => {
    setEditing(rule);
    setForm({ name: rule.name, description: rule.description ?? '', definition: JSON.stringify(rule.definition, null, 2) });
    setShowModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) { toast.error('Name is required'); return; }
    let definition: Record<string, any>;
    try { definition = JSON.parse(form.definition); }
    catch { toast.error('Definition is not valid JSON'); return; }
    setSaving(true);
    const input = { name: form.name.trim(), description: form.description.trim() || null, definition };
    const res = editing
      ? await SignalsService.updateRule(editing.id, input)
      : await SignalsService.createRule({ ...input, status: 'paused' });
    if (res.success) {
      toast.success(editing ? 'Rule updated' : 'Rule created (paused — activate when ready)');
      setShowModal(false);
      load();
    } else {
      toast.error(res.error || 'Failed to save rule');
    }
    setSaving(false);
  };

  const toggleStatus = async (rule: SignalsRule) => {
    const res = await SignalsService.updateRule(rule.id, { status: rule.status === 'active' ? 'paused' : 'active' });
    if (res.success) load(); else toast.error(res.error || 'Failed to update');
  };

  const markDue = async (rule: SignalsRule) => {
    const res = await SignalsService.markDue(rule.id);
    if (res.success) toast.success('Marked due — evaluates on the next worker tick (or POST /signals/rules/:id/evaluate)');
    else toast.error(res.error || 'Failed');
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    const res = await SignalsService.deleteRule(deleting.id);
    if (res.success) { toast.success('Rule deleted'); load(); } else toast.error(res.error || 'Failed to delete');
    setDeleting(null);
  };

  const ruleName = (id: string) => rules.find((r) => r.id === id)?.name ?? id.slice(0, 8);

  return (
    <Page title="Signals">
      <WorkspaceLayout
        title="Signals"
        actions={tab === 'rules' ? (
          <Button onClick={openCreate}><PlusIcon className="h-4 w-4 mr-1" /> New Rule</Button>
        ) : undefined}
      >
        <div className="flex gap-1 mb-4 border-b border-[var(--gray-a5)]">
          {(['rules', 'fires', 'stats'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium capitalize border-b-2 -mb-px ${
                tab === t ? 'border-[var(--accent-9)] text-[var(--gray-12)]' : 'border-transparent text-[var(--gray-11)] hover:text-[var(--gray-12)]'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="text-center py-12 text-gray-500">Loading...</div>
        ) : tab === 'rules' ? (
          rules.length === 0 ? (
            <Card className="text-center py-12">
              <SignalIcon className="w-12 h-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">No routing rules yet. Rules match content to people and dispatch the pairs to a channel.</p>
            </Card>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <Card key={rule.id} className="flex items-center gap-3 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-gray-900 dark:text-white truncate">{rule.name}</span>
                      <Badge color={statusColor(rule.status)}>{rule.status}</Badge>
                      <Badge color="neutral">{rule.definition?.channel?.type ?? 'log'}</Badge>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-xs text-[var(--gray-11)]">
                      <span className="font-mono truncate">{(rule.definition?.topics ?? []).join(', ') || '(explicit hrefs)'}</span>
                      {rule.last_evaluated_at && <span>· evaluated {new Date(rule.last_evaluated_at).toLocaleString()}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => toggleStatus(rule)}
                      className="px-2 py-1 text-xs rounded border border-[var(--gray-a5)] text-[var(--gray-11)] hover:bg-gray-100 dark:hover:bg-gray-800">
                      {rule.status === 'active' ? 'Pause' : 'Activate'}
                    </button>
                    <button onClick={() => markDue(rule)} title="Mark due for evaluation"
                      className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded">
                      <BoltIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </button>
                    <button onClick={() => openEdit(rule)} className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded">
                      <PencilIcon className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                    </button>
                    <button onClick={() => setDeleting(rule)} className="p-1.5 hover:bg-red-100 dark:hover:bg-red-900/20 rounded">
                      <TrashIcon className="w-4 h-4 text-red-600 dark:text-red-400" />
                    </button>
                  </div>
                </Card>
              ))}
            </div>
          )
        ) : tab === 'fires' ? (
          fires.length === 0 ? (
            <Card className="p-8 text-center text-[var(--gray-11)]">No fires yet. Activate a rule and evaluate it.</Card>
          ) : (
            <div className="space-y-1.5">
              {fires.map((fire) => (
                <Card key={fire.id} className="flex items-center gap-3 p-2.5 text-sm">
                  <Badge color={statusColor(fire.status)}>{fire.status}</Badge>
                  <span className="text-[var(--gray-11)] text-xs whitespace-nowrap">{new Date(fire.created_at).toLocaleString()}</span>
                  <span className="font-medium truncate">{fire.content_title}</span>
                  <span className="text-xs text-[var(--gray-a9)] font-mono truncate">{fire.content_href}</span>
                  <span className="ml-auto text-xs text-[var(--gray-11)] whitespace-nowrap">
                    {ruleName(fire.rule_id)} → {fire.channel}
                    {fire.person_id ? ` · person ${fire.person_id.slice(0, 8)}` : ''}
                  </span>
                  {fire.error && <span className="text-xs text-red-500 truncate max-w-[200px]" title={fire.error}>{fire.error}</span>}
                </Card>
              ))}
            </div>
          )
        ) : (
          <div className="space-y-2">
            {stats.map((s) => (
              <Card key={s.rule_id} className="p-3">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium">{s.name}</span>
                  <Badge color={statusColor(s.status)}>{s.status}</Badge>
                </div>
                <div className="grid grid-cols-6 gap-2 text-center text-sm">
                  {([['fires', s.fires], ['dispatched', s.dispatched], ['failed', s.failed], ['suppressed', s.suppressed], ['outcomes', s.outcomes], ['clicks', s.clicks]] as const).map(([label, value]) => (
                    <div key={label} className="rounded bg-[var(--gray-a2)] py-2">
                      <div className="text-lg font-semibold">{value}</div>
                      <div className="text-xs text-[var(--gray-11)]">{label}</div>
                    </div>
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
      </WorkspaceLayout>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Edit Rule' : 'New Rule'}>
        <div className="space-y-4">
          <Input label="Name" value={form.name} onChange={(e: any) => setForm({ ...form, name: e.target.value })} />
          <Input label="Description" value={form.description} onChange={(e: any) => setForm({ ...form, description: e.target.value })} />
          <div>
            <label className="block text-sm font-medium mb-1">Definition</label>
            <textarea
              className="w-full h-72 font-mono text-xs border rounded p-2 bg-gray-50 dark:bg-gray-800"
              value={form.definition}
              onChange={(e) => setForm({ ...form, definition: e.target.value })}
            />
            <p className="text-xs text-[var(--gray-11)] mt-1">
              topics match both content and audience interests; channel.type: log · webhook · portal_pin · broadcast_draft
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowModal(false)}>Cancel</Button>
            <Button onClick={save} disabled={saving}>{editing ? 'Save Changes' : 'Create Rule'}</Button>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete Rule"
        message={`Delete "${deleting?.name}" and its fire history?`}
        confirmText="Delete"
        confirmColor="red"
      />
    </Page>
  );
};

export default SignalsPage;
