import { useState, useEffect, useCallback } from 'react';
import {
  PaperAirplaneIcon,
  ClockIcon,
  CheckCircleIcon,
  XCircleIcon,
  EnvelopeIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Button, Badge } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { getSupabaseConfig } from '@/config/brands';

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

interface CollectionInfo {
  from_name?: string | null;
  from_email?: string | null;
  list_id?: string | null;
  list_name?: string | null;
  subscriber_count?: number;
}

interface EditionSendingTabProps {
  editionId: string;
  editionDate?: string;
  subject: string;
  collection: CollectionInfo | null;
  newsletterSlug?: string;
  renderedHtml?: string;
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

export function EditionSendingTab({ editionId, editionDate, subject, collection, newsletterSlug, renderedHtml }: EditionSendingTabProps) {
  const [sends, setSends] = useState<SendRecord[]>([]);
  const [sendLog, setSendLog] = useState<SendLogEntry[]>([]);
  const [selectedSendId, setSelectedSendId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [scheduleType, setScheduleType] = useState<'immediate' | 'scheduled'>('immediate');
  const [scheduledAt, setScheduledAt] = useState('');

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
  const loadSendLog = useCallback(async () => {
    if (!selectedSendId) { setSendLog([]); return; }
    const { data } = await supabase
      .from('email_send_log')
      .select('id, recipient_email, status, sent_at, delivered_at, first_opened_at, first_clicked_at, bounced_at, failure_error, created_at')
      .eq('newsletter_send_id', selectedSendId)
      .order('created_at', { ascending: true });
    setSendLog(data || []);
  }, [selectedSendId]);

  useEffect(() => { loadSendLog(); }, [loadSendLog]);

  // Poll sends and delivery log
  // Fast polling (3s) during active sends, slower (15s) for completed sends to catch webhook updates
  useEffect(() => {
    if (!selectedSendId && sends.length === 0) return;
    const isActiveSend = sends.some(s => s.status === 'sending' || s.status === 'scheduled');
    const pollInterval = isActiveSend ? 3000 : 15000;
    const interval = setInterval(() => { loadSends(); loadSendLog(); }, pollInterval);
    return () => clearInterval(interval);
  }, [sends, selectedSendId, loadSends, loadSendLog]);

  const handleSend = async () => {
    if (editionId === 'new') {
      toast.error('Save the edition first');
      return;
    }

    setSending(true);
    try {
      const portalDomain = window.location.hostname.replace('-admin.', '-app.').replace('admin.', 'app.');
      const portalProtocol = window.location.protocol;
      const webVersionUrl = newsletterSlug && editionDate
        ? `${portalProtocol}//${portalDomain}/newsletters/${newsletterSlug}--${editionDate}`
        : `${portalProtocol}//${portalDomain}/newsletters`;

      let finalHtml = renderedHtml || null;
      if (finalHtml) {
        finalHtml = finalHtml
          .replace(/\{\{web_version\}\}/g, webVersionUrl)
          .replace(/\{%\s*view_in_browser_url\s*%\}/g, webVersionUrl);
      }

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
          scheduled_at: scheduleType === 'scheduled' ? scheduledAt : null,
          adapter_id: 'html',
          rendered_html: finalHtml,
          metadata: { web_version_url: webVersionUrl },
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

      toast.success(scheduleType === 'scheduled' ? 'Send scheduled' : 'Sending started');
      await loadSends();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create send');
    } finally {
      setSending(false);
    }
  };

  const latestSend = sends[0];
  const isActive = latestSend?.status === 'sending' || latestSend?.status === 'scheduled';
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
                <input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="mt-2 w-full px-3 py-1.5 text-sm border border-[var(--gray-a6)] rounded-md bg-[var(--color-surface)]"
                />
              )}
            </div>

            <Button variant="solid" onClick={handleSend} disabled={sending || editionId === 'new' || isActive}>
              <PaperAirplaneIcon className="w-4 h-4 mr-1" />
              {sending ? 'Sending...' : isActive ? 'Send in progress...' : scheduleType === 'scheduled' ? 'Schedule Send' : 'Send Now'}
            </Button>
          </div>
        </Card>

        {/* Send progress (when active) */}
        {isActive && latestSend && (
          <Card variant="surface" className="p-5">
            <div className="flex items-center gap-2 mb-3">
              <ClockIcon className="w-4 h-4 text-[var(--accent-9)] animate-pulse" />
              <h2 className="text-sm font-semibold text-[var(--gray-12)]">
                {latestSend.status === 'scheduled' ? 'Scheduled' : 'Sending...'}
              </h2>
            </div>
            {latestSend.total_recipients != null && latestSend.total_recipients > 0 && (
              <div>
                <div className="flex justify-between text-xs text-[var(--gray-11)] mb-1">
                  <span>Progress</span>
                  <span>{latestSend.sent_count || 0} / {latestSend.total_recipients}</span>
                </div>
                <div className="w-full bg-[var(--gray-a4)] rounded-full h-1.5">
                  <div
                    className="bg-[var(--accent-9)] h-1.5 rounded-full transition-all duration-500"
                    style={{ width: `${((latestSend.sent_count || 0) / latestSend.total_recipients) * 100}%` }}
                  />
                </div>
              </div>
            )}
          </Card>
        )}

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
                    : send.status === 'sending'
                      ? { color: 'blue', icon: ClockIcon }
                      : { color: 'gray', icon: ClockIcon };
                const Icon = statusCfg.icon;
                const isSelected = send.id === selectedSendId;

                return (
                  <button
                    key={send.id}
                    onClick={() => setSelectedSendId(send.id)}
                    className={`w-full text-left flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors ${
                      isSelected
                        ? 'bg-[var(--accent-a3)] border border-[var(--accent-a6)]'
                        : 'hover:bg-[var(--gray-a3)] border border-transparent'
                    }`}
                  >
                    <Icon className={`w-4 h-4 flex-shrink-0 ${
                      send.status === 'sent' ? 'text-green-600' :
                      send.status === 'failed' ? 'text-red-600' :
                      send.status === 'sending' ? 'text-[var(--accent-9)] animate-pulse' :
                      'text-[var(--gray-9)]'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <Badge variant="soft" color={statusCfg.color as any} size="1">
                          {send.status}
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
                  </button>
                );
              })}
            </div>
          </Card>
        )}
      </div>

      {/* Right Column — Delivery log */}
      <div className="flex-1 min-w-0">
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
                value={sendLog.filter(l => l.first_opened_at).length}
                color="green"
              />
            </div>
          )}

          {/* Recipient table */}
          {sendLog.length > 0 ? (
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
