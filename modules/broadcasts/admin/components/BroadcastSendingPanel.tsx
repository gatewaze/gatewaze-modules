import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import {
  updateBroadcast, scheduleBroadcast, sendNow, sendTest, cancelBroadcast,
  getTimezoneBreakdown, type BroadcastSend, type DeliveryStrategy, type TimezoneBreakdownRow,
} from '../lib/broadcastService';

const inputCls = 'w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-60';
const TIMEZONES = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="block text-xs font-medium text-[var(--gray-12)] mb-1">{label}</label>{children}</div>;
}

/**
 * Broadcast sending — mirrors the newsletter edition Sending experience: the
 * envelope fields (subject/preheader/from/reply-to), schedule + delivery
 * strategy (global / recipient-local-time), a test send, and LIVE progress via
 * a Supabase realtime subscription on the broadcast row + per-timezone
 * breakdown.
 *
 * NOTE: full newsletter-style "send multiple times" (an edition → many sends
 * with exclude-already-sent) needs a parent-broadcast / child-send-jobs schema
 * split; today a broadcast is a single send. The resend affordance is stubbed
 * pending that split (see spec Phase 1.x / build report).
 */
export default function BroadcastSendingPanel({ broadcast, reload }: { broadcast: BroadcastSend; reload: () => void }) {
  const [b, setB] = useState<BroadcastSend>(broadcast);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [breakdown, setBreakdown] = useState<TimezoneBreakdownRow[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setB(broadcast); }, [broadcast]);

  const editable = b.status === 'draft';
  const inFlight = b.status === 'sending' || b.status === 'scheduled';
  const patch = (p: Partial<BroadcastSend>) => setB((prev) => ({ ...prev, ...p }));

  // Live progress: subscribe to this broadcast row + its delivery log.
  useEffect(() => {
    const reloadBreakdown = () => { getTimezoneBreakdown(b.id).then(setBreakdown).catch(() => {}); };
    if (b.status === 'sending' || b.status === 'sent') reloadBreakdown();
    const ch = supabase
      .channel(`broadcast:${b.id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'broadcast_sends', filter: `id=eq.${b.id}` },
        (payload) => {
          setB((prev) => ({ ...prev, ...(payload.new as Partial<BroadcastSend>) }));
          if (refreshTimer.current) clearTimeout(refreshTimer.current);
          refreshTimer.current = setTimeout(reloadBreakdown, 500);
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); if (refreshTimer.current) clearTimeout(refreshTimer.current); };
  }, [b.id, b.status]);

  async function saveEnvelope() {
    setSaving(true);
    try {
      const nb = await updateBroadcast(b.id, {
        subject: b.subject, preheader: b.preheader, from_address: b.from_address,
        from_name: b.from_name, reply_to: b.reply_to,
      });
      setB(nb); toast.success('Saved');
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Save failed'); }
    finally { setSaving(false); }
  }

  const ready = !!b.rendered_html && !!b.subject && !!b.segment_id;

  async function doTest() {
    if (!testEmail.trim()) return;
    setBusy(true);
    const r = await sendTest(b.id, testEmail.trim());
    setBusy(false);
    r.success ? toast.success(`Test sent to ${testEmail}`) : toast.error(r.error || 'Test failed');
  }
  async function doSend() {
    if (b.schedule_type === 'scheduled') {
      setBusy(true);
      try {
        await scheduleBroadcast(b.id, { schedule_type: 'scheduled', delivery_strategy: b.delivery_strategy, scheduled_at: b.scheduled_at, default_timezone: b.default_timezone, target_local: b.target_local });
        toast.success('Broadcast scheduled'); reload();
      } catch (err) { toast.error(err instanceof Error ? err.message : 'Schedule failed'); }
      finally { setBusy(false); }
      return;
    }
    if (!confirm(`Send "${b.name}" now? This cannot be undone.`)) return;
    setBusy(true);
    // Persist schedule/delivery choices, then fire.
    await updateBroadcast(b.id, { delivery_strategy: b.delivery_strategy, default_timezone: b.default_timezone, target_local: b.target_local }).catch(() => {});
    const r = await sendNow(b.id);
    setBusy(false);
    if (r.success) { toast.success('Sending started'); reload(); } else toast.error(r.error || 'Send failed');
  }
  async function doStop() {
    if (!confirm('Stop this broadcast?')) return;
    await cancelBroadcast(b.id); toast.success('Stopping…'); reload();
  }

  const pct = b.total_recipients > 0 ? Math.round(((b.sent_count + b.failed_count) / b.total_recipients) * 100) : 0;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* Left: envelope + schedule + actions */}
      <div className="space-y-4">
        <Card className="p-4 space-y-3">
          <div className="text-sm font-medium text-[var(--gray-12)]">Email details</div>
          <Field label="Subject"><input className={inputCls} value={b.subject ?? ''} disabled={!editable} onChange={(e) => patch({ subject: e.target.value })} /></Field>
          <Field label="Preheader"><input className={inputCls} value={b.preheader ?? ''} disabled={!editable} onChange={(e) => patch({ preheader: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From address"><input className={inputCls} value={b.from_address ?? ''} disabled={!editable} onChange={(e) => patch({ from_address: e.target.value })} /></Field>
            <Field label="From name"><input className={inputCls} value={b.from_name ?? ''} disabled={!editable} onChange={(e) => patch({ from_name: e.target.value })} /></Field>
          </div>
          <Field label="Reply-to"><input className={inputCls} value={b.reply_to ?? ''} disabled={!editable} onChange={(e) => patch({ reply_to: e.target.value })} /></Field>
          {editable && <div className="flex justify-end"><Button variant="soft" onClick={saveEnvelope} disabled={saving}>{saving ? 'Saving…' : 'Save details'}</Button></div>}
        </Card>

        {editable && (
          <Card className="p-4 space-y-3">
            <div className="text-sm font-medium text-[var(--gray-12)]">Schedule</div>
            <Field label="Delivery">
              <select className={inputCls} value={b.delivery_strategy} onChange={(e) => patch({ delivery_strategy: e.target.value as DeliveryStrategy })}>
                <option value="global">Everyone at once</option>
                <option value="tz_local">Recipient local time</option>
              </select>
            </Field>
            {b.delivery_strategy === 'tz_local' && (
              <div className="grid grid-cols-2 gap-2">
                <Field label="Local time"><input type="time" className={inputCls} value={b.target_local ?? '09:00'} onChange={(e) => patch({ target_local: e.target.value })} /></Field>
                <Field label="Default timezone">
                  <select className={inputCls} value={b.default_timezone ?? 'UTC'} onChange={(e) => patch({ default_timezone: e.target.value })}>
                    {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                  </select>
                </Field>
              </div>
            )}
            <Field label="When">
              <select className={inputCls} value={b.schedule_type} onChange={(e) => patch({ schedule_type: e.target.value as 'immediate' | 'scheduled' })}>
                <option value="immediate">As soon as I send it</option>
                <option value="scheduled">At a scheduled time</option>
              </select>
            </Field>
            {b.schedule_type === 'scheduled' && (
              <Field label="Scheduled time">
                <input type="datetime-local" className={inputCls}
                  value={b.scheduled_at ? toLocalInput(b.scheduled_at) : ''}
                  onChange={(e) => patch({ scheduled_at: e.target.value ? new Date(e.target.value).toISOString() : null })} />
              </Field>
            )}
          </Card>
        )}

        <Card className="p-4 space-y-3">
          <div className="text-sm font-medium text-[var(--gray-12)]">Send a test</div>
          <div className="flex gap-2">
            <input className={inputCls} value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="you@example.com" />
            <Button variant="soft" onClick={doTest} disabled={busy || !testEmail.trim()}>Send test</Button>
          </div>
        </Card>

        {editable && (
          <div className="flex items-center justify-end gap-2">
            {!ready && <span className="text-xs text-[var(--amber-11)] self-center">Set audience, content, and a subject first.</span>}
            <Button variant="solid" onClick={doSend} disabled={busy || !ready}>{b.schedule_type === 'scheduled' ? 'Schedule' : 'Send now'}</Button>
          </div>
        )}
        {inFlight && <div className="flex justify-end"><Button variant="soft" color="red" onClick={doStop}>Stop</Button></div>}
      </div>

      {/* Right: live progress */}
      <div className="space-y-4">
        <Card className="p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium text-[var(--gray-12)]">Progress</div>
            <Badge color={b.status === 'sent' ? 'green' : b.status === 'failed' ? 'red' : b.status === 'sending' ? 'amber' : 'gray'}>{b.status}</Badge>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center my-3">
            <Stat label="Recipients" value={b.total_recipients} />
            <Stat label="Sent" value={b.sent_count} tone="green" />
            <Stat label="Failed" value={b.failed_count} tone="red" />
          </div>
          {(b.status === 'sending' || b.status === 'sent') && (
            <div className="w-full bg-[var(--gray-4)] rounded-full h-2 overflow-hidden">
              <div className="bg-[var(--accent-9)] h-2 transition-all" style={{ width: `${pct}%` }} />
            </div>
          )}
        </Card>

        {breakdown.length > 0 && (
          <Card className="p-4">
            <div className="text-sm font-medium text-[var(--gray-12)] mb-2">Per-timezone</div>
            <div className="space-y-1 text-sm">
              {breakdown.map((r) => (
                <div key={r.timezone} className="flex justify-between text-[var(--gray-11)]">
                  <span>{r.timezone}</span>
                  <span>{r.recipients} · sent {r.sent} · pending {r.pending} · failed {r.failed}</span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'green' | 'red' }) {
  const color = tone === 'green' ? 'var(--green-11)' : tone === 'red' ? 'var(--red-11)' : 'var(--gray-12)';
  return (
    <div>
      <div className="text-xl font-semibold" style={{ color }}>{(value ?? 0).toLocaleString()}</div>
      <div className="text-xs text-[var(--gray-10)]">{label}</div>
    </div>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
