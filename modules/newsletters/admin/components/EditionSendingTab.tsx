import { useState, useEffect, useCallback, useRef } from 'react';
import {
  PaperAirplaneIcon,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  EnvelopeIcon,
  PauseIcon,
  PlayIcon,
  ArrowPathIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { getSupabaseConfig } from '@/config/brands';
import { getViewOnlineUrl } from '../utils/view-online-url';

interface SendRecord {
  id: string;
  status: string;
  subject: string | null;
  from_address: string | null;
  from_name: string | null;
  total_recipients: number | null;
  sent_count: number | null;
  failed_count: number | null;
  started_at: string | null;
  completed_at: string | null;
  scheduled_at: string | null;
  delivery_strategy: string | null;
  created_at: string;
}

interface SendLogEntry {
  id: string;
  recipient_email: string;
  status: string;
  sent_at: string | null;
  delivered_at: string | null;
  first_opened_at: string | null;
  first_clicked_at: string | null;
  bounced_at: string | null;
  failure_error: string | null;
  created_at: string;
}

interface TimezoneBreakdownRow {
  timezone: string;
  recipients: number;
  sent: number;
  failed: number;
  pending: number;
  skipped: number;
  send_at: string;
}

interface CollectionInfo {
  from_name?: string | null;
  from_email?: string | null;
  list_id?: string | null;
  list_name?: string | null;
  subscriber_count?: number;
  view_online_target?: string | null;
  view_online_external_base_url?: string | null;
}

interface EditionSendingTabProps {
  editionId: string;
  editionDate?: string;
  subject: string;
  collection: CollectionInfo | null;
  newsletterSlug?: string;
  /**
   * Edition publish status. Sending is gated on `'published'` — a draft edition
   * has no public View Online page yet, so its emails' "View Online" link would
   * 404. Operators must publish before they can send/schedule.
   */
  editionStatus?: string;
  /**
   * Async renderer that produces the final email-safe HTML for the
   * edition. Called at send time (not eagerly) so the heavy
   * `@react-email/render` pass only runs when the operator commits to
   * a send, not on every edition-page render.
   *
   * Replaces the previous `renderedHtml: string` prop, which was
   * computed eagerly via `generateNewsletterHtml` — that path only
   * understood Mustache block templates and produced empty content
   * for blocks authored in the Puck / react-email registry, so sends
   * went out with a blank body.
   */
  getRenderedHtml?: () => Promise<string>;
}

const STATUS_CONFIG: Record<string, { color: string; label: string }> = {
  queued: { color: 'gray', label: 'Queued' },
  sent: { color: 'blue', label: 'Sent' },
  delivered: { color: 'green', label: 'Delivered' },
  send_failed: { color: 'red', label: 'Failed' },
  permanently_failed: { color: 'red', label: 'Failed' },
  bounced: { color: 'orange', label: 'Bounced' },
  opened: { color: 'green', label: 'Opened' },
  clicked: { color: 'green', label: 'Clicked' },
};

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// IANA zone list for the timezone picker. Intl.supportedValuesOf is
// available in current Chromium/Firefox/Safari; fall back to a small
// curated list on older runtimes so the dropdown is never empty.
const TIMEZONES: string[] = (() => {
  try {
    const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (typeof sv === 'function') return sv('timeZone');
  } catch { /* fall through to fallback */ }
  return [
    'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Madrid',
    'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
    'America/Sao_Paulo', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo',
    'Australia/Sydney',
  ];
})();

function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/**
 * Human "time from now" countdown, Customer.io-style: "in 2d 3h",
 * "in 5m 12s", or "due now" once the target has passed. Seconds are
 * only shown when under an hour out, to avoid a noisy long-range ticker.
 */
function formatCountdown(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  if (diff <= 0) return 'due now';
  const total = Math.floor(diff / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours}h ${mins}m`;
  if (mins > 0) return `in ${mins}m ${secs}s`;
  return `in ${secs}s`;
}

/** Status badge label/color for one timezone row in the dispatch breakdown. */
function tzRowStatus(r: TimezoneBreakdownRow, nowMs: number): { label: string; color: string } {
  if (r.pending === 0) {
    if (r.sent > 0) return { label: 'Sent', color: 'green' };
    if (r.skipped > 0) return { label: 'Cancelled', color: 'gray' };
    if (r.failed > 0) return { label: 'Failed', color: 'red' };
    return { label: '—', color: 'gray' };
  }
  if (r.sent > 0) return { label: 'Sending', color: 'blue' };
  const ts = new Date(r.send_at).getTime();
  // Due but not yet claimed — the 60s drip will pick it up imminently.
  if (nowMs >= ts) return { label: 'Sending', color: 'blue' };
  // Not due yet — count down to this zone's dispatch (e.g. "Sends in 2h 5m").
  return { label: `Sends ${formatCountdown(ts, nowMs)}`, color: 'amber' };
}

const SEND_LOG_PAGE_SIZE = 50;

export function EditionSendingTab({ editionId, editionDate, subject, collection, newsletterSlug, editionStatus, getRenderedHtml }: EditionSendingTabProps) {
  // Only a published edition can be sent — its View Online page must exist.
  const canSend = editionStatus === 'published';
  const [sends, setSends] = useState<SendRecord[]>([]);
  const [sendLog, setSendLog] = useState<SendLogEntry[]>([]);
  const [sendLogPage, setSendLogPage] = useState(0);
  const [sendLogTotal, setSendLogTotal] = useState(0);
  const [openedCount, setOpenedCount] = useState(0);
  const [selectedSendId, setSelectedSendId] = useState<string | null>(null);
  // Per-timezone dispatch breakdown for staggered sends, keyed by send id.
  // Persists with the recipient queue, so it stays meaningful after a send
  // completes. Empty for global (all-at-once) sends.
  const [tzBreakdown, setTzBreakdown] = useState<Record<string, TimezoneBreakdownRow[]>>({});
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [scheduleType, setScheduleType] = useState<'immediate' | 'scheduled'>('immediate');
  const [scheduledAt, setScheduledAt] = useState('');
  // Per-recipient delivery timing (spec-newsletter-personalised-delivery Part A).
  const [deliveryStrategy, setDeliveryStrategy] = useState<'global' | 'tz_local' | 'personalised'>('global');
  const [targetLocal, setTargetLocal] = useState('09:00');
  const [defaultTimezone, setDefaultTimezone] = useState<string>(() => browserTimezone());
  // Prior sends whose successfully-sent recipients should be excluded from this
  // new send (re-send corrected content without double-sending).
  const [excludeSentSendIds, setExcludeSentSendIds] = useState<string[]>([]);
  // Ticking clock for the send countdown; only runs while there's a
  // future scheduled time to count down to (form preview or a queued send).
  const [now, setNow] = useState(() => Date.now());

  // Form preview target (what the operator is currently picking) and any
  // already-queued scheduled send drive the live countdown.
  const formTargetMs = scheduleType === 'scheduled' && scheduledAt ? new Date(scheduledAt).getTime() : NaN;
  const hasActiveRow = sends.some((s) => s.status === 'scheduled' || s.status === 'sending' || s.status === 'cancelling');
  const needCountdown = (Number.isFinite(formTargetMs) && formTargetMs > now) || hasActiveRow;
  useEffect(() => {
    if (!needCountdown) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [needCountdown]);

  const loadSends = useCallback(async () => {
    if (editionId === 'new') { setLoading(false); return; }
    const { data } = await supabase
      .from('newsletter_sends')
      .select('*')
      .eq('edition_id', editionId)
      .order('created_at', { ascending: false });
    setSends(data || []);
    // Auto-select the latest send for the log view
    if (data && data.length > 0 && !selectedSendId) {
      setSelectedSendId(data[0].id);
    }
    setLoading(false);
  }, [editionId]);

  useEffect(() => { loadSends(); }, [loadSends]);

  // Load send log for the selected send
  // Paginated: a send can have tens of thousands of recipients (e.g. imported
  // Customer.io history), so load one page at a time + an exact total rather
  // than the whole log.
  const loadSendLog = useCallback(async () => {
    if (!selectedSendId) { setSendLog([]); setSendLogTotal(0); return; }
    const from = sendLogPage * SEND_LOG_PAGE_SIZE;
    const { data, count } = await supabase
      .from('email_send_log')
      .select('id, recipient_email, status, sent_at, delivered_at, first_opened_at, first_clicked_at, bounced_at, failure_error, created_at', { count: 'exact' })
      .eq('newsletter_send_id', selectedSendId)
      .order('created_at', { ascending: true })
      .range(from, from + SEND_LOG_PAGE_SIZE - 1);
    setSendLog(data || []);
    if (count != null) setSendLogTotal(count);
  }, [selectedSendId, sendLogPage]);

  // "Opened" stat is a server-side count (not a filter over the loaded page).
  const loadOpenedCount = useCallback(async () => {
    if (!selectedSendId) { setOpenedCount(0); return; }
    const { count } = await supabase
      .from('email_send_log')
      .select('id', { count: 'exact', head: true })
      .eq('newsletter_send_id', selectedSendId)
      .not('first_opened_at', 'is', null);
    setOpenedCount(count || 0);
  }, [selectedSendId]);

  // Per-timezone dispatch breakdown (staggered sends). Returns [] for global
  // sends (no recipient queue). Stored by send id so each row/table is its own.
  const loadBreakdown = useCallback(async (sendId: string) => {
    const { data } = await supabase.rpc('newsletter_send_timezone_breakdown', { p_send_id: sendId });
    setTzBreakdown((prev) => ({ ...prev, [sendId]: (data as TimezoneBreakdownRow[] | null) ?? [] }));
  }, []);

  useEffect(() => { loadSendLog(); }, [loadSendLog]);
  useEffect(() => { loadOpenedCount(); }, [loadOpenedCount]);
  useEffect(() => { if (selectedSendId) loadBreakdown(selectedSendId); }, [selectedSendId, loadBreakdown]);
  // Load the breakdown for any in-flight send too, so its history-row summary
  // ("N pending across timezones, next at …") has data even when not selected.
  useEffect(() => {
    for (const s of sends) {
      if ((s.status === 'sending' || s.status === 'cancelling') && !tzBreakdown[s.id]) loadBreakdown(s.id);
    }
  }, [sends, tzBreakdown, loadBreakdown]);
  // Reset to the first page when the selected send changes.
  useEffect(() => { setSendLogPage(0); }, [selectedSendId]);

  // Debounced refresh for realtime ticks (live sends fire many row updates).
  const refreshRef = useRef<() => void>(() => {});
  refreshRef.current = () => { loadSendLog(); loadOpenedCount(); if (selectedSendId) loadBreakdown(selectedSendId); };
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => refreshRef.current(), 400);
  }, []);

  // Live updates via Supabase Realtime — replaces the previous polling
  // loop. Subscribes to:
  //   • newsletter_sends rows for this edition (status / counters change
  //     as the send worker progresses)
  //   • email_send_log rows for the currently-selected send (per-recipient
  //     state transitions driven by the email-webhook function:
  //     delivered → opened → clicked, bounced, failed)
  // Both tables were added to the supabase_realtime publication in
  // newsletters migration 030 (newsletter sends + send-log realtime).
  // RLS still applies; the operator's session is exactly the same one
  // the SELECTs above use, so visibility matches.
  //
  // Sends-channel handler applies the change in place so we don't lose
  // selectedSendId on every tick. Log handler appends INSERTs and
  // patches UPDATEs by id (sendgrid webhook updates the same row
  // multiple times as state advances).
  const editionIdRef = useRef(editionId);
  editionIdRef.current = editionId;
  useEffect(() => {
    if (editionId === 'new') return;
    const channel = supabase
      .channel(`newsletter-sends:${editionId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'newsletter_sends', filter: `edition_id=eq.${editionId}` },
        (payload) => {
          if (editionIdRef.current !== editionId) return;
          if (payload.eventType === 'INSERT') {
            const row = payload.new as SendRecord;
            setSends((prev) => (prev.some((s) => s.id === row.id) ? prev : [row, ...prev]));
            // Auto-select the new send if nothing's selected yet.
            setSelectedSendId((cur) => cur ?? row.id);
          } else if (payload.eventType === 'UPDATE') {
            const row = payload.new as SendRecord;
            setSends((prev) => prev.map((s) => (s.id === row.id ? { ...s, ...row } : s)));
          } else if (payload.eventType === 'DELETE') {
            const row = payload.old as { id: string };
            setSends((prev) => prev.filter((s) => s.id !== row.id));
          }
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [editionId]);

  useEffect(() => {
    if (!selectedSendId) return;
    const channel = supabase
      .channel(`email-send-log:${selectedSendId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'email_send_log', filter: `newsletter_send_id=eq.${selectedSendId}` },
        () => {
          // Paginated view: refresh the current page + counts (debounced)
          // rather than mutating a full in-memory array.
          scheduleRefresh();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [selectedSendId]);

  // Render the edition to final email HTML with the web-version link
  // substituted. Shared by the initial send and the "Update content" action,
  // so both produce identical output. getViewOnlineUrl is the single source of
  // truth for the View Online target (same helper the editor preview uses).
  const buildFinalHtml = useCallback(async (): Promise<{ html: string | null; webVersionUrl: string; portalBaseUrl: string }> => {
    const portalProtocol = typeof window !== 'undefined' ? window.location.protocol : 'https:';
    const portalHost = typeof window !== 'undefined'
      ? window.location.hostname.replace('-admin.', '-app.').replace(/^admin\./, '')
      : 'localhost';
    // Portal origin (admin.aaif.live → aaif.live) — used for the Subscription
    // Centre link in the email footer (edge fn appends /subscriptions?token=).
    const portalBaseUrl = `${portalProtocol}//${portalHost}`;
    const webVersionUrl =
      getViewOnlineUrl(
        { slug: newsletterSlug, view_online_target: collection?.view_online_target, view_online_external_base_url: collection?.view_online_external_base_url },
        { edition_date: editionDate, subject },
      ) ?? `${portalBaseUrl}/newsletters`;
    let html = getRenderedHtml ? await getRenderedHtml() : null;
    if (html) {
      html = html
        .replace(/\{\{web_version\}\}/g, webVersionUrl)
        .replace(/\{%\s*view_in_browser_url\s*%\}/g, webVersionUrl);
    }
    return { html, webVersionUrl, portalBaseUrl };
  }, [newsletterSlug, collection?.view_online_target, collection?.view_online_external_base_url, editionDate, subject, getRenderedHtml]);

  const handleSend = async () => {
    if (editionId === 'new') {
      toast.error('Save the edition first');
      return;
    }
    if (!canSend) {
      toast.error('Publish this edition before sending — the "View Online" link needs a live page.');
      return;
    }

    setSending(true);
    try {
      const { html: finalHtml, webVersionUrl, portalBaseUrl } = await buildFinalHtml();

      const { data, error } = await supabase
        .from('newsletter_sends')
        .insert({
          edition_id: editionId,
          status: scheduleType === 'scheduled' ? 'scheduled' : 'sending',
          subject: subject || null,
          from_address: collection?.from_email || null,
          from_name: collection?.from_name || null,
          list_ids: collection?.list_id ? [collection.list_id] : [],
          schedule_type: scheduleType,
          // The datetime-local input yields a zoneless wall-clock string
          // (e.g. "2026-06-17T08:50"). Persisting it raw into the timestamptz
          // column makes Postgres read it as UTC, so a BST operator's 08:50
          // was stored as 09:50 local. new Date(...) interprets it in the
          // browser's zone and toISOString() gives the correct UTC instant.
          scheduled_at: scheduleType === 'scheduled' && scheduledAt ? new Date(scheduledAt).toISOString() : null,
          // Per-recipient delivery strategies only apply to a scheduled
          // send: the immediate path fires newsletter-send straight away
          // and dispatches every recipient at once, so a "Recipient local
          // time" / "Personalised send-time" choice would be silently
          // ignored. Coerce to 'global' on save so the recorded row
          // matches what actually happens. The UI also hides the
          // dropdown for Immediately to stop the operator picking it.
          delivery_strategy: scheduleType === 'immediate' ? 'global' : deliveryStrategy,
          target_local: scheduleType === 'immediate' || deliveryStrategy === 'global' ? null : targetLocal,
          default_timezone: scheduleType === 'immediate' || deliveryStrategy === 'global' ? null : (defaultTimezone || null),
          adapter_id: 'html',
          rendered_html: finalHtml,
          exclude_sent_send_ids: excludeSentSendIds.length > 0 ? excludeSentSendIds : null,
          metadata: { web_version_url: webVersionUrl, portal_base_url: portalBaseUrl },
        })
        .select()
        .single();

      if (error) throw error;

      setSelectedSendId(data.id);

      if (scheduleType === 'immediate') {
        const { url } = getSupabaseConfig();
        const { data: { session } } = await supabase.auth.getSession();
        if (session) {
          const sendResponse = await fetch(`${url}/functions/v1/newsletter-send`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ send_id: data.id }),
          });

          if (!sendResponse.ok) {
            const sendErr = await sendResponse.json().catch(() => ({}));
            console.error('Newsletter send error:', sendErr);
            await supabase.from('newsletter_sends').update({ status: 'failed' }).eq('id', data.id);
            throw new Error(sendErr.error || `Send failed (${sendResponse.status})`);
          }
        } else {
          throw new Error('Authentication required');
        }
      }

      // Immediate sends are async now (fanout → worker drip); the Send button's
      // spinner + the realtime progress below convey "in progress", so no
      // fire-and-forget "started" toast. Scheduled sends still confirm.
      if (scheduleType === 'scheduled') toast.success('Send scheduled');
      setExcludeSentSendIds([]);
      await loadSends();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create send');
    } finally {
      setSending(false);
    }
  };

  // Cancel a scheduled send (never dispatched) or request a stop on one that
  // is already sending. A scheduled row goes straight to 'cancelled' so the
  // dispatcher (which only claims status='scheduled') skips it. A sending row
  // goes to 'cancelling' — the newsletter-send edge fn re-checks status before
  // each batch and stops cleanly, recording what was already delivered.
  const handleCancel = async (send: SendRecord) => {
    // A send that's already dispatching (or paused mid-drip) goes to
    // 'cancelling' so the dispatcher drains pending recipients to 'skipped'
    // and finalises it 'cancelled'. A not-yet-started scheduled send goes
    // straight to 'cancelled'.
    const isActive = send.status === 'sending' || send.status === 'paused';
    const ok = window.confirm(
      isActive
        ? 'Stop this send now? Recipients already processed will still receive it; the rest will be skipped.'
        : 'Cancel this scheduled send? It will not go out.',
    );
    if (!ok) return;
    const { error } = await supabase
      .from('newsletter_sends')
      .update({ status: isActive ? 'cancelling' : 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', send.id);
    if (error) {
      toast.error(error.message || 'Failed to cancel send');
      return;
    }
    toast.success(isActive ? 'Stopping send…' : 'Scheduled send cancelled');
    await loadSends();
  };

  // Re-render the edition and overwrite the send's stored HTML so recipients
  // not yet dispatched get the corrected content (already-sent ones keep what
  // they received). The staggered drip re-reads rendered_html each tick, and a
  // scheduled send re-reads it at dispatch — so this is offered for those, not
  // for a global all-at-once send (which captures HTML once at dispatch).
  const handleApplyLatestContent = async (send: SendRecord) => {
    if (!window.confirm('Update this send to the latest edition content? Only recipients who have not been sent yet will get the new version.')) return;
    try {
      const { html } = await buildFinalHtml();
      if (!html) { toast.error('Nothing to render yet'); return; }
      const { error } = await supabase
        .from('newsletter_sends')
        .update({ rendered_html: html, subject: subject || null, updated_at: new Date().toISOString() })
        .eq('id', send.id);
      if (error) throw error;
      toast.success('Content updated for remaining recipients');
      await loadSends();
    } catch (err: any) {
      toast.error(err.message || 'Failed to update content');
    }
  };

  // Pause / resume an in-flight staggered send. Pausing flips it to 'paused' so
  // the dispatcher stops claiming its recipients (the claim RPC only takes
  // 'sending' sends); resuming flips it back and the drip continues from where
  // it left off — useful while you fix and re-apply the content.
  const handlePause = async (send: SendRecord) => {
    const { error } = await supabase
      .from('newsletter_sends')
      .update({ status: 'paused', updated_at: new Date().toISOString() })
      .eq('id', send.id);
    if (error) { toast.error(error.message || 'Failed to pause'); return; }
    toast.success('Send paused');
    await loadSends();
  };

  const handleResume = async (send: SendRecord) => {
    const { error } = await supabase
      .from('newsletter_sends')
      .update({ status: 'sending', updated_at: new Date().toISOString() })
      .eq('id', send.id);
    if (error) { toast.error(error.message || 'Failed to resume'); return; }
    toast.success('Send resumed');
    await loadSends();
  };

  const latestSend = sends[0];
  const isActive = latestSend?.status === 'sending' || latestSend?.status === 'scheduled' || latestSend?.status === 'cancelling';
  // Spinner while actually dispatching: the fetch is in flight, or the worker
  // engine is dripping (status 'sending'), or a stop is propagating. Scheduled
  // (future) sends don't spin. Drives the Send button's progress affordance now
  // that immediate sends are async (fanout returns fast; the worker drips).
  const sendSpinning = sending || latestSend?.status === 'sending' || latestSend?.status === 'cancelling';
  const isComplete = latestSend?.status === 'sent';
  const isFailed = latestSend?.status === 'failed';

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
      </div>
    );
  }

  const selectedSend = sends.find(s => s.id === selectedSendId);

  return (
    <div className="flex gap-6">
      {/* Left Column — Send controls & history */}
      <div className="w-[400px] flex-shrink-0 space-y-4">
        {/* Send configuration */}
        <Card variant="surface" className="p-5">
          <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-4 flex items-center gap-2">
            <PaperAirplaneIcon className="w-4 h-4" />
            Send Newsletter
          </h2>

          <div className="space-y-4">
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-[var(--gray-9)] mb-0.5">From</label>
                <p className="text-sm text-[var(--gray-12)]">
                  {collection?.from_name || 'Not configured'} {collection?.from_email ? `<${collection.from_email}>` : ''}
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--gray-9)] mb-0.5">Recipients</label>
                <p className="text-sm text-[var(--gray-12)]">
                  {collection?.list_name || 'No list linked'}
                  {collection?.subscriber_count != null && (
                    <span className="text-[var(--gray-9)]"> ({collection.subscriber_count})</span>
                  )}
                </p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--gray-9)] mb-2">Schedule</label>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input type="radio" checked={scheduleType === 'immediate'} onChange={() => setScheduleType('immediate')} />
                  Immediately
                </label>
                <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input type="radio" checked={scheduleType === 'scheduled'} onChange={() => setScheduleType('scheduled')} />
                  Later
                </label>
              </div>
              {scheduleType === 'scheduled' && (
                <>
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(e) => setScheduledAt(e.target.value)}
                    className="mt-2 w-full px-3 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)]"
                  />
                  {Number.isFinite(formTargetMs) && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-[var(--gray-11)]">
                      <ClockIcon className="w-3.5 h-3.5 text-[var(--accent-9)]" />
                      <span>
                        Sends <span className="font-semibold text-[var(--gray-12)]">{formatCountdown(formTargetMs, now)}</span>
                      </span>
                    </p>
                  )}
                </>
              )}
            </div>

            {/* Delivery timing only makes sense for a scheduled send. The
                immediate path fires the send straight away and dispatches
                every recipient at once, so per-recipient timing here would
                be silently ignored. Showing it next to "Immediately" read
                as contradictory — operators set it expecting it to apply.
                Hide for Immediately; show for Later. */}
            {scheduleType === 'scheduled' && (
              <div>
                <label className="block text-xs font-medium text-[var(--gray-9)] mb-2">Delivery timing</label>
                <select
                  value={deliveryStrategy}
                  onChange={(e) => setDeliveryStrategy(e.target.value as 'global' | 'tz_local' | 'personalised')}
                  className="w-full px-3 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)]"
                >
                  <option value="global">Everyone at once</option>
                  <option value="tz_local">Recipient local time</option>
                  <option value="personalised">Personalised send-time</option>
                </select>
                {deliveryStrategy !== 'global' && (
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="text-xs text-[var(--gray-9)]">
                      Local time
                      <input
                        type="time"
                        value={targetLocal}
                        onChange={(e) => setTargetLocal(e.target.value)}
                        className="mt-1 w-full px-3 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)]"
                      />
                    </label>
                    <label className="text-xs text-[var(--gray-9)]">
                      Default timezone
                      <select
                        value={defaultTimezone}
                        onChange={(e) => setDefaultTimezone(e.target.value)}
                        className="mt-1 w-full px-3 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)]"
                      >
                        {TIMEZONES.map((tz) => (
                          <option key={tz} value={tz}>{tz}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
                {deliveryStrategy === 'personalised' && (
                  <p className="mt-1 text-xs text-[var(--gray-8)]">Uses each recipient&apos;s modelled open time where known, otherwise falls back to their local time.</p>
                )}
              </div>
            )}

            {(() => {
              const priorSent = sends.filter((s) => (s.sent_count || 0) > 0);
              if (priorSent.length === 0) return null;
              return (
                <div>
                  <label className="block text-xs font-medium text-[var(--gray-9)] mb-1">Exclude already-sent recipients</label>
                  <p className="text-xs text-[var(--gray-8)] mb-2">Skip anyone successfully sent in a previous send — re-send corrected content to the rest without double-sending.</p>
                  <div className="space-y-1.5">
                    {priorSent.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input
                          type="checkbox"
                          checked={excludeSentSendIds.includes(s.id)}
                          onChange={(e) => setExcludeSentSendIds((prev) => e.target.checked ? [...prev, s.id] : prev.filter((id) => id !== s.id))}
                        />
                        <span className="text-[var(--gray-11)]">
                          {s.sent_count} sent · {formatTime(s.completed_at || s.created_at)}{s.status !== 'sent' ? ` · ${s.status}` : ''}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })()}

            {!canSend && editionId !== 'new' && (
              <div className="rounded-md border border-[var(--amber-a6)] bg-[var(--amber-a2)] px-3 py-2 text-xs text-[var(--amber-11)]">
                This edition is a draft. <span className="font-medium">Publish it</span> before sending — the email&apos;s &ldquo;View Online&rdquo; link points at the published page.
              </div>
            )}

            <Button variant="solid" onClick={handleSend} disabled={sending || editionId === 'new' || isActive || !canSend}>
              {sendSpinning ? (
                <svg className="w-4 h-4 mr-1 animate-spin" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <PaperAirplaneIcon className="w-4 h-4 mr-1" />
              )}
              {sending ? 'Sending...' : isActive ? 'Send in progress...' : !canSend ? 'Publish to send' : scheduleType === 'scheduled' ? 'Schedule Send' : 'Send Now'}
            </Button>
          </div>
        </Card>

        {/* Per-send progress / countdown / stop now live inline in Send
            History below, so they always refer to the send you're looking at
            (not just the latest one). */}

        {/* Send history */}
        {sends.length > 0 && (
          <Card variant="surface" className="p-5">
            <h2 className="text-sm font-semibold text-[var(--gray-12)] mb-2">Send History</h2>
            <div className="space-y-1">
              {sends.map(send => {
                const statusCfg = send.status === 'sent'
                  ? { color: 'green', icon: CheckCircleIcon }
                  : send.status === 'failed'
                    ? { color: 'red', icon: XCircleIcon }
                    : send.status === 'cancelled' || send.status === 'cancelling'
                      ? { color: 'gray', icon: XCircleIcon }
                      : send.status === 'paused'
                        ? { color: 'amber', icon: PauseIcon }
                        : send.status === 'sending'
                          ? { color: 'blue', icon: ClockIcon }
                          : { color: 'gray', icon: ClockIcon };
                const Icon = statusCfg.icon;
                const isSelected = send.id === selectedSendId;

                const strategy = send.delivery_strategy || 'global';
                const isStaggered = strategy !== 'global';
                const isSendingRow = send.status === 'sending' || send.status === 'cancelling' || send.status === 'paused';
                // "Update content" only has an effect where HTML is re-read
                // after creation: a scheduled send (read at dispatch) or an
                // in-flight staggered send (the drip re-reads each tick). A
                // global all-at-once send captures HTML once, so it's omitted.
                const canUpdateContent = send.status === 'scheduled'
                  || (isStaggered && (send.status === 'sending' || send.status === 'paused' || send.status === 'cancelling'));
                const pct = (send.total_recipients || 0) > 0
                  ? Math.round(((send.sent_count || 0) / (send.total_recipients || 1)) * 100)
                  : 0;

                return (
                  <div
                    key={send.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedSendId(send.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedSendId(send.id); } }}
                    className={`w-full text-left px-3 py-2.5 rounded-md transition-colors cursor-pointer ${
                      isSelected
                        ? 'bg-[var(--accent-a3)] border border-[var(--accent-a6)]'
                        : 'hover:bg-[var(--gray-a3)] border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <Icon className={`w-4 h-4 flex-shrink-0 ${
                        send.status === 'sent' ? 'text-green-600' :
                        send.status === 'failed' ? 'text-red-600' :
                        send.status === 'sending' ? 'text-[var(--accent-9)] animate-pulse' :
                        'text-[var(--gray-9)]'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <Badge variant="soft" color={statusCfg.color as any} size="1">
                            {send.status === 'cancelling' ? 'stopping' : send.status}
                          </Badge>
                          <span className="text-xs text-[var(--gray-9)]">
                            {formatTime(send.created_at)}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-[var(--gray-11)]">
                          <span>{send.sent_count || 0} sent</span>
                          {(send.failed_count || 0) > 0 && (
                            <span className="text-red-600">{send.failed_count} failed</span>
                          )}
                          <span>{send.total_recipients || 0} recipients</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        {canUpdateContent && (
                          <Button variant="soft" color="gray" size="1" title="Update to latest edition content" onClick={(e) => { e.stopPropagation(); handleApplyLatestContent(send); }}>
                            <ArrowPathIcon className="w-4 h-4" />
                          </Button>
                        )}
                        {isStaggered && send.status === 'sending' && (
                          <Button variant="soft" color="gray" size="1" title="Pause" onClick={(e) => { e.stopPropagation(); handlePause(send); }}>
                            <PauseIcon className="w-4 h-4" />
                          </Button>
                        )}
                        {send.status === 'paused' && (
                          <Button variant="soft" color="green" size="1" onClick={(e) => { e.stopPropagation(); handleResume(send); }}>
                            <PlayIcon className="w-4 h-4 mr-1" />
                            Resume
                          </Button>
                        )}
                        {send.status === 'scheduled' && (
                          <Button variant="soft" color="red" size="1" onClick={(e) => { e.stopPropagation(); handleCancel(send); }}>
                            <XCircleIcon className="w-4 h-4 mr-1" />
                            Cancel
                          </Button>
                        )}
                        {(send.status === 'sending' || send.status === 'paused') && (
                          <Button variant="soft" color="red" size="1" onClick={(e) => { e.stopPropagation(); handleCancel(send); }}>
                            <XCircleIcon className="w-4 h-4 mr-1" />
                            Stop
                          </Button>
                        )}
                      </div>
                    </div>

                    {send.status === 'scheduled' && send.scheduled_at && (
                      <p className="mt-2 ml-7 text-xs text-[var(--gray-11)]">
                        Sends <span className="font-semibold text-[var(--gray-12)]">{formatCountdown(new Date(send.scheduled_at).getTime(), now)}</span>
                        <span className="text-[var(--gray-9)]"> · {formatTime(send.scheduled_at)}</span>
                      </p>
                    )}

                    {isSendingRow && (send.total_recipients || 0) > 0 && (
                      <div className="mt-2 ml-7">
                        <div className="flex justify-between text-xs text-[var(--gray-11)] mb-1">
                          <span>{send.status === 'cancelling' ? 'Stopping…' : send.status === 'paused' ? 'Paused' : 'Progress'}</span>
                          <span>{send.sent_count || 0} / {send.total_recipients} · {pct}%</span>
                        </div>
                        <div className="w-full bg-[var(--gray-a4)] rounded-full h-1.5">
                          <div
                            className="bg-[var(--accent-9)] h-1.5 rounded-full transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        {(() => {
                          const bd = tzBreakdown[send.id];
                          const pendingCount = Math.max(0, (send.total_recipients || 0) - (send.sent_count || 0) - (send.failed_count || 0));
                          if (pendingCount === 0) return null;
                          const nextRow = bd?.find((r) => r.pending > 0);
                          const nextAt = nextRow ? new Date(nextRow.send_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : null;
                          return (
                            <p className="mt-1.5 text-[11px] text-[var(--gray-9)]">
                              {pendingCount} pending{bd && bd.length > 1 ? ` across ${bd.length} timezones` : ''}{nextAt ? ` · next at ${nextAt}` : ''}
                            </p>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        )}
      </div>

      {/* Right Column — Delivery log */}
      <div className="flex-1 min-w-0">
        {/* Per-timezone dispatch breakdown (staggered sends). Persists after
            completion since it reads the recipient queue. Hidden for global
            sends, which have no per-recipient timing rows. */}
        {selectedSendId && (tzBreakdown[selectedSendId]?.length ?? 0) > 0 && (
          <Card variant="surface" className="p-5 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-[var(--gray-12)] flex items-center gap-2">
                <ClockIcon className="w-4 h-4" />
                Delivery by timezone
              </h2>
              <span className="text-xs text-[var(--gray-9)]">{tzBreakdown[selectedSendId].length} zones</span>
            </div>
            <div className="border border-[var(--gray-a4)] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--gray-a2)] border-b border-[var(--gray-a4)]">
                    <th className="text-left px-3 py-2 text-xs font-medium text-[var(--gray-9)]">Timezone</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[var(--gray-9)]">Recipients</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[var(--gray-9)]">Local time</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[var(--gray-9)]">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tzBreakdown[selectedSendId].map((r) => {
                    const st = tzRowStatus(r, now);
                    // The recipients' *current* local time (live clock), not
                    // the dispatch time — the countdown in Status conveys when.
                    let localTime = '—';
                    try {
                      localTime = new Date(now).toLocaleTimeString('en-GB', { timeZone: r.timezone, hour: '2-digit', minute: '2-digit' });
                    } catch { /* invalid zone — leave as — */ }
                    return (
                      <tr key={r.timezone} className="border-b border-[var(--gray-a3)] last:border-0">
                        <td className="px-3 py-2 text-[var(--gray-12)]">{r.timezone}</td>
                        <td className="px-3 py-2 text-[var(--gray-11)] tabular-nums">{r.recipients}</td>
                        <td className="px-3 py-2 text-[var(--gray-11)] tabular-nums">{localTime}</td>
                        <td className="px-3 py-2">
                          <Badge variant="soft" color={st.color as any} size="1">{st.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <Card variant="surface" className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-[var(--gray-12)] flex items-center gap-2">
              <EnvelopeIcon className="w-4 h-4" />
              Delivery Log
              {selectedSend && (
                <Badge variant="soft" color={
                  selectedSend.status === 'sent' ? 'green' :
                  selectedSend.status === 'failed' ? 'red' :
                  selectedSend.status === 'sending' ? 'blue' : 'gray'
                } size="1">
                  {selectedSend.status}
                </Badge>
              )}
            </h2>
            {selectedSend && (
              <span className="text-xs text-[var(--gray-9)]">
                {formatTime(selectedSend.created_at)}
              </span>
            )}
          </div>

          {/* Stats summary */}
          {selectedSend && (
            <div className="flex gap-3 mb-4">
              <StatCard label="Recipients" value={selectedSend.total_recipients || 0} />
              <StatCard label="Sent" value={selectedSend.sent_count || 0} color="blue" />
              <StatCard label="Failed" value={selectedSend.failed_count || 0} color={(selectedSend.failed_count || 0) > 0 ? 'red' : undefined} />
              <StatCard
                label="Opened"
                value={openedCount}
                color="green"
              />
            </div>
          )}

          {/* Recipient table */}
          {sendLogTotal > 0 ? (
           <>
            <div className="border border-[var(--gray-a4)] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[var(--gray-a2)] border-b border-[var(--gray-a4)]">
                    <th className="text-left px-3 py-2 text-xs font-medium text-[var(--gray-9)]">Recipient</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[var(--gray-9)]">Status</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[var(--gray-9)]">Sent</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[var(--gray-9)]">Delivered</th>
                    <th className="text-left px-3 py-2 text-xs font-medium text-[var(--gray-9)]">Opened</th>
                  </tr>
                </thead>
                <tbody>
                  {sendLog.map((entry) => {
                    const cfg = STATUS_CONFIG[entry.status] || { color: 'gray', label: entry.status };
                    return (
                      <tr key={entry.id} className="border-b border-[var(--gray-a3)] last:border-0 hover:bg-[var(--gray-a2)]">
                        <td className="px-3 py-2 text-[var(--gray-12)] truncate max-w-[200px]">
                          {entry.recipient_email}
                        </td>
                        <td className="px-3 py-2">
                          <Badge variant="soft" color={cfg.color as any} size="1">
                            {cfg.label}
                          </Badge>
                          {entry.failure_error && (
                            <span className="block text-xs text-red-600 mt-0.5 truncate max-w-[150px]" title={entry.failure_error}>
                              {entry.failure_error}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-[var(--gray-11)]">
                          {formatTime(entry.sent_at)}
                        </td>
                        <td className="px-3 py-2 text-xs text-[var(--gray-11)]">
                          {entry.delivered_at ? formatTime(entry.delivered_at) : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs text-[var(--gray-11)]">
                          {entry.first_opened_at ? formatTime(entry.first_opened_at) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {sendLogTotal > SEND_LOG_PAGE_SIZE && (
              <div className="flex items-center justify-between mt-3 text-xs text-[var(--gray-10)]">
                <span>
                  {sendLogPage * SEND_LOG_PAGE_SIZE + 1}–{Math.min((sendLogPage + 1) * SEND_LOG_PAGE_SIZE, sendLogTotal)} of {sendLogTotal.toLocaleString()}
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outlined"
                    size="1"
                    disabled={sendLogPage === 0}
                    onClick={() => setSendLogPage((p) => Math.max(0, p - 1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outlined"
                    size="1"
                    disabled={(sendLogPage + 1) * SEND_LOG_PAGE_SIZE >= sendLogTotal}
                    onClick={() => setSendLogPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            )}
           </>
          ) : selectedSendId ? (
            <div className="text-center py-12 text-[var(--gray-9)]">
              <EnvelopeIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">No delivery records yet</p>
              {isActive && <p className="text-xs mt-1">Records will appear as emails are sent</p>}
            </div>
          ) : (
            <div className="text-center py-12 text-[var(--gray-9)]">
              <EnvelopeIcon className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-sm">Select a send to view delivery details</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="flex-1 text-center p-2.5 bg-[var(--gray-a2)] rounded-lg">
      <p className={`text-xl font-bold ${
        color === 'red' ? 'text-red-600' :
        color === 'green' ? 'text-green-600' :
        color === 'blue' ? 'text-blue-600' :
        'text-[var(--gray-12)]'
      }`}>
        {value.toLocaleString()}
      </p>
      <p className="text-xs text-[var(--gray-9)] mt-0.5">{label}</p>
    </div>
  );
}
