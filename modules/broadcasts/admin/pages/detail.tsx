import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { Card, Button, Badge, WorkspaceLayout } from '@/components/ui';
import { Page } from '@/components/shared/Page';
import { supabase } from '@/lib/supabase';
import { createSegmentService, type Segment } from '@/lib/segments';
import SegmentCopilot from '../components/SegmentCopilot';
import {
  getBroadcast, updateBroadcast, scheduleBroadcast, sendNow, sendTest,
  cancelBroadcast, getTimezoneBreakdown,
  type BroadcastSend, type DeliveryStrategy, type TimezoneBreakdownRow,
} from '../lib/broadcastService';

const TABS = [
  { id: 'compose', label: 'Compose' },
  { id: 'audience', label: 'Audience' },
  { id: 'schedule', label: 'Schedule' },
  { id: 'review', label: 'Review & Send' },
];

export default function BroadcastDetailPage() {
  const { id, tab } = useParams<{ id: string; tab?: string }>();
  const navigate = useNavigate();
  const activeTab = tab && TABS.some((t) => t.id === tab) ? tab : 'compose';

  const [c, setC] = useState<BroadcastSend | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await getBroadcast(id);
      if (!data) { toast.error('Broadcast not found'); navigate('/broadcasts'); return; }
      setC(data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load broadcast');
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => { load(); }, [load]);

  const patch = (p: Partial<BroadcastSend>) => setC((prev) => (prev ? { ...prev, ...p } : prev));

  async function save(extra?: Partial<BroadcastSend>) {
    if (!c) return;
    setSaving(true);
    try {
      const updated = await updateBroadcast(c.id, {
        name: c.name, subject: c.subject, preheader: c.preheader,
        from_address: c.from_address, from_name: c.from_name, reply_to: c.reply_to,
        rendered_html: c.rendered_html, suppression_topic: c.suppression_topic,
        ...extra,
      });
      setC(updated);
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  if (loading || !c) {
    return (
      <Page title="Broadcast">
        <WorkspaceLayout title="Broadcasts">
          <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" /></div>
        </WorkspaceLayout>
      </Page>
    );
  }

  const editable = c.status === 'draft' || c.status === 'scheduled';

  return (
    <Page title={`Broadcast: ${c.name}`}>
      <WorkspaceLayout
        title={`Broadcasts: ${c.name}`}
        tabs={TABS}
        activeTabId={activeTab}
        onTabChange={(t) => navigate(`/broadcasts/${c.id}/${t}`)}
        actions={<Badge color={c.status === 'sent' ? 'green' : c.status === 'failed' ? 'red' : c.status === 'sending' ? 'amber' : 'gray'}>{c.status}</Badge>}
      >
        {activeTab === 'compose' && (
          <Card className="p-6 max-w-2xl space-y-4">
            <Field label="Name"><input className={inputCls} value={c.name} disabled={!editable} onChange={(e) => patch({ name: e.target.value })} /></Field>
            <Field label="Subject"><input className={inputCls} value={c.subject ?? ''} disabled={!editable} onChange={(e) => patch({ subject: e.target.value })} /></Field>
            <Field label="Preheader"><input className={inputCls} value={c.preheader ?? ''} disabled={!editable} onChange={(e) => patch({ preheader: e.target.value })} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From address"><input className={inputCls} value={c.from_address ?? ''} disabled={!editable} onChange={(e) => patch({ from_address: e.target.value })} /></Field>
              <Field label="From name"><input className={inputCls} value={c.from_name ?? ''} disabled={!editable} onChange={(e) => patch({ from_name: e.target.value })} /></Field>
            </div>
            <Field label="Reply-to"><input className={inputCls} value={c.reply_to ?? ''} disabled={!editable} onChange={(e) => patch({ reply_to: e.target.value })} /></Field>
            <Field label="Body (HTML)">
              <textarea className={`${inputCls} font-mono`} rows={12} value={c.rendered_html ?? ''} disabled={!editable}
                onChange={(e) => patch({ rendered_html: e.target.value })}
                placeholder={'<html><body>Hi {{first_name}}, …</body></html>'} />
              <p className="text-xs text-[var(--gray-10)] mt-1">Merge fields: {'{{first_name}}'} {'{{name}}'} {'{{company}}'} {'{{job_title}}'} · {'{{unsubscribe_url}}'} is injected automatically.</p>
            </Field>
            {editable && <div className="flex justify-end"><Button variant="solid" onClick={() => save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button></div>}
          </Card>
        )}

        {activeTab === 'audience' && <AudienceTab c={c} editable={editable} onAttach={(segId) => save({ audience_type: 'segment', segment_id: segId })} />}

        {activeTab === 'schedule' && <ScheduleTab c={c} editable={editable} onPatch={patch} onSave={save} saving={saving} />}

        {activeTab === 'review' && <ReviewTab c={c} reload={load} />}
      </WorkspaceLayout>
    </Page>
  );
}

const inputCls = 'w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-60';
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-sm font-medium text-[var(--gray-12)] mb-1">{label}</label>{children}</div>;
}

// --- Audience ---------------------------------------------------------------
function AudienceTab({ c, editable, onAttach }: { c: BroadcastSend; editable: boolean; onAttach: (segmentId: string) => void }) {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [current, setCurrent] = useState<Segment | null>(null);

  useEffect(() => {
    const svc = createSegmentService(supabase);
    svc.listSegments({ status: 'active', page_size: 100 }).then((r) => setSegments(r.data)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!c.segment_id) { setCurrent(null); return; }
    createSegmentService(supabase).getSegment(c.segment_id).then(setCurrent).catch(() => {});
  }, [c.segment_id]);

  return (
    <div className="space-y-4 max-w-2xl">
      {current && (
        <Card className="p-4 flex items-center justify-between">
          <div>
            <div className="text-xs uppercase text-[var(--gray-10)]">Attached audience</div>
            <div className="font-medium text-[var(--gray-12)]">{current.name}</div>
            <div className="text-sm text-[var(--gray-11)]">≈ {current.cached_count.toLocaleString()} people{current.last_calculated_at ? ` · calculated ${new Date(current.last_calculated_at).toLocaleString()}` : ''}</div>
          </div>
        </Card>
      )}

      {editable && <SegmentCopilot brand={c.brand} onAttach={(segId) => onAttach(segId)} />}

      {editable && segments.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-medium text-[var(--gray-12)] mb-2">…or pick an existing segment</div>
          <div className="space-y-1 max-h-72 overflow-auto">
            {segments.map((s) => (
              <button key={s.id} onClick={() => onAttach(s.id)}
                className={`w-full text-left px-3 py-2 rounded-md text-sm hover:bg-[var(--gray-3)] ${c.segment_id === s.id ? 'bg-[var(--accent-3)] text-[var(--accent-11)]' : 'text-[var(--gray-12)]'}`}>
                {s.name} <span className="text-[var(--gray-10)]">· {s.cached_count.toLocaleString()}</span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

// --- Schedule ---------------------------------------------------------------
function ScheduleTab({ c, editable, onPatch, onSave, saving }: {
  c: BroadcastSend; editable: boolean; onPatch: (p: Partial<BroadcastSend>) => void; onSave: (extra?: Partial<BroadcastSend>) => void; saving: boolean;
}) {
  return (
    <Card className="p-6 max-w-2xl space-y-4">
      <Field label="Delivery">
        <select className={inputCls} value={c.delivery_strategy} disabled={!editable} onChange={(e) => onPatch({ delivery_strategy: e.target.value as DeliveryStrategy })}>
          <option value="global">Send to everyone at once</option>
          <option value="tz_local">Local time per recipient (e.g. 9am in their timezone)</option>
        </select>
      </Field>
      {c.delivery_strategy === 'tz_local' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Local send time (HH:MM)"><input className={inputCls} value={c.target_local ?? '09:00'} disabled={!editable} onChange={(e) => onPatch({ target_local: e.target.value })} /></Field>
          <Field label="Fallback timezone (IANA)"><input className={inputCls} value={c.default_timezone ?? 'UTC'} disabled={!editable} onChange={(e) => onPatch({ default_timezone: e.target.value })} placeholder="UTC" /></Field>
        </div>
      )}
      <Field label="When">
        <select className={inputCls} value={c.schedule_type} disabled={!editable} onChange={(e) => onPatch({ schedule_type: e.target.value as 'immediate' | 'scheduled' })}>
          <option value="immediate">As soon as I send it</option>
          <option value="scheduled">At a scheduled time</option>
        </select>
      </Field>
      {c.schedule_type === 'scheduled' && (
        <Field label="Scheduled time">
          <input type="datetime-local" className={inputCls} disabled={!editable}
            value={c.scheduled_at ? toLocalInput(c.scheduled_at) : ''}
            onChange={(e) => onPatch({ scheduled_at: e.target.value ? new Date(e.target.value).toISOString() : null })} />
        </Field>
      )}
      {editable && <div className="flex justify-end"><Button variant="solid" onClick={() => onSave()} disabled={saving}>{saving ? 'Saving…' : 'Save schedule'}</Button></div>}
    </Card>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// --- Review & Send ----------------------------------------------------------
function ReviewTab({ c, reload }: { c: BroadcastSend; reload: () => void }) {
  const [testEmail, setTestEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [breakdown, setBreakdown] = useState<TimezoneBreakdownRow[]>([]);

  useEffect(() => {
    if (c.status === 'sending' || c.status === 'sent') getTimezoneBreakdown(c.id).then(setBreakdown).catch(() => {});
  }, [c.id, c.status]);

  const ready = !!c.rendered_html && !!c.subject && (c.audience_type === 'list' ? c.list_ids.length > 0 : !!c.segment_id);

  async function doTest() {
    if (!testEmail.trim()) return;
    setBusy(true);
    const r = await sendTest(c.id, testEmail.trim());
    setBusy(false);
    r.success ? toast.success(`Test sent to ${testEmail}`) : toast.error(r.error || 'Test failed');
  }
  async function doSendNow() {
    if (!confirm(`Send "${c.name}" now? This cannot be undone.`)) return;
    setBusy(true);
    const r = await sendNow(c.id);
    setBusy(false);
    if (r.success) { toast.success('Sending started'); reload(); } else toast.error(r.error || 'Send failed');
  }
  async function doSchedule() {
    setBusy(true);
    try {
      await scheduleBroadcast(c.id, {
        schedule_type: c.schedule_type, delivery_strategy: c.delivery_strategy,
        scheduled_at: c.scheduled_at, default_timezone: c.default_timezone, target_local: c.target_local,
      });
      toast.success('Broadcast scheduled'); reload();
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Schedule failed'); }
    finally { setBusy(false); }
  }
  async function doCancel() {
    if (!confirm('Stop this send?')) return;
    await cancelBroadcast(c.id); toast.success('Stopping…'); reload();
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <Card className="p-4 space-y-2">
        <Row label="Subject" value={c.subject || '—'} />
        <Row label="From" value={[c.from_name, c.from_address].filter(Boolean).join(' ') || '—'} />
        <Row label="Audience" value={c.audience_type === 'segment' ? (c.segment_id ? 'Segment attached' : 'No segment') : `${c.list_ids.length} list(s)`} />
        <Row label="Delivery" value={c.delivery_strategy === 'tz_local' ? `Local ${c.target_local ?? '09:00'} (fallback ${c.default_timezone ?? 'UTC'})` : 'Everyone at once'} />
        <Row label="Recipients" value={c.total_recipients ? c.total_recipients.toLocaleString() : '— (computed at send)'} />
        {c.status === 'sent' && <Row label="Result" value={`${c.sent_count.toLocaleString()} sent · ${c.failed_count} failed`} />}
      </Card>

      {breakdown.length > 0 && (
        <Card className="p-4">
          <div className="text-sm font-medium text-[var(--gray-12)] mb-2">Per-timezone</div>
          <div className="space-y-1 text-sm">
            {breakdown.map((b) => (
              <div key={b.timezone} className="flex justify-between text-[var(--gray-11)]">
                <span>{b.timezone}</span>
                <span>{b.recipients} · sent {b.sent} · pending {b.pending} · failed {b.failed}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4 space-y-3">
        <div className="text-sm font-medium text-[var(--gray-12)]">Send a test</div>
        <div className="flex gap-2">
          <input className={inputCls} value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@example.com" />
          <Button variant="soft" onClick={doTest} disabled={busy || !testEmail.trim()}>Send test</Button>
        </div>
      </Card>

      {(c.status === 'draft') && (
        <div className="flex justify-end gap-2">
          {!ready && <span className="text-sm text-[var(--amber-11)] self-center">Add a subject, body, and audience first.</span>}
          {c.schedule_type === 'scheduled'
            ? <Button variant="solid" onClick={doSchedule} disabled={busy || !ready}>Schedule</Button>
            : <Button variant="solid" onClick={doSendNow} disabled={busy || !ready}>Send now</Button>}
        </div>
      )}
      {(c.status === 'sending' || c.status === 'scheduled') && (
        <div className="flex justify-end"><Button variant="soft" color="red" onClick={doCancel}>Stop</Button></div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between text-sm"><span className="text-[var(--gray-10)]">{label}</span><span className="text-[var(--gray-12)] text-right">{value}</span></div>;
}
