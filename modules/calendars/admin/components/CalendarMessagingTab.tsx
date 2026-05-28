import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  EnvelopeIcon,
  ChatBubbleLeftRightIcon,
  PhoneIcon,
  PaperAirplaneIcon,
  ClockIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  CalendarDaysIcon,
  DocumentDuplicateIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import {
  Button,
  Card,
  Input,
  Badge,
  ConfirmModal,
} from '@/components/ui';
import { RichTextEditor } from '@/components/ui/RichTextEditor';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import { useHasModule } from '@/hooks/useModuleFeature';
import { useAuthContext } from '@/app/contexts/auth/context';
import { supabase } from '@/lib/supabase';
import { Calendar } from '../services/calendarService';
import {
  CalendarBlastService,
  CalendarBlast,
  AudienceFilter,
  BlastChannel,
  CalendarTemplate,
} from '../services/calendarBlastService';
import { CalendarAudienceFilter } from './CalendarAudienceFilter';
import { CalendarBlastDrawer } from './CalendarBlastDrawer';

interface Props {
  calendar: Calendar;
}

interface CalendarEventOption {
  id: string;
  event_id: string;
  event_title: string;
}

const CHANNEL_OPTIONS: Array<{
  value: BlastChannel;
  label: string;
  icon: typeof EnvelopeIcon;
  moduleId?: string;
}> = [
  { value: 'email',    label: 'Email',    icon: EnvelopeIcon },
  { value: 'sms',      label: 'SMS',      icon: PhoneIcon,           moduleId: 'twilio-sms' },
  { value: 'whatsapp', label: 'WhatsApp', icon: ChatBubbleLeftRightIcon, moduleId: 'whatsapp' },
];

/** Strip HTML tags for SMS/WhatsApp where character count matters. Naive
 *  but good enough — the user can edit afterwards. */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; label: string; icon?: typeof CheckCircleIcon }> = {
    draft:     { color: 'gray',   label: 'Draft' },
    scheduled: { color: 'blue',   label: 'Scheduled', icon: ClockIcon },
    sending:   { color: 'amber',  label: 'Sending',   icon: ClockIcon },
    sent:      { color: 'green',  label: 'Sent',      icon: CheckCircleIcon },
    failed:    { color: 'red',    label: 'Failed',    icon: ExclamationCircleIcon },
    cancelled: { color: 'gray',   label: 'Cancelled' },
  };
  const cfg = map[status] || { color: 'gray', label: status };
  const Icon = cfg.icon;
  return (
    <Badge color={cfg.color as any}>
      {Icon && <Icon className="size-3 mr-1 inline-block" />}
      {cfg.label}
    </Badge>
  );
}

export function CalendarMessagingTab({ calendar }: Props) {
  const { user } = useAuthContext();
  const smsEnabled = useHasModule('twilio-sms');
  const whatsappEnabled = useHasModule('whatsapp');

  const [channel, setChannel] = useState<BlastChannel>('email');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [filter, setFilter] = useState<AudienceFilter>({ membership_status: ['active'] });
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [linkedEvents, setLinkedEvents] = useState<CalendarEventOption[]>([]);
  const [history, setHistory] = useState<CalendarBlast[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduledAt, setScheduledAt] = useState<string>(() => {
    // Default = an hour from now, in local datetime-input format (yyyy-MM-ddTHH:mm)
    const d = new Date(Date.now() + 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [templates, setTemplates] = useState<CalendarTemplate[]>([]);
  const [drawerBlastId, setDrawerBlastId] = useState<string | null>(null);

  // Load linked events for the audience picker
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('calendars_events')
        .select('events!inner(id, event_id, event_title)')
        .eq('calendar_id', calendar.id);
      if (cancelled) return;
      if (error) {
        console.error('Failed to load linked events:', error);
        return;
      }
      const opts: CalendarEventOption[] = (data || [])
        .map((row: any) => row.events)
        .filter(Boolean)
        .map((ev: any) => ({
          id: ev.id,
          event_id: ev.event_id,
          event_title: ev.event_title,
        }));
      setLinkedEvents(opts);
    })();
    return () => {
      cancelled = true;
    };
  }, [calendar.id]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    const result = await CalendarBlastService.listBlasts(calendar.id, { limit: 25 });
    if (result.success && result.data) {
      setHistory(result.data.blasts);
    } else {
      toast.error(result.error || 'Failed to load blast history');
    }
    setHistoryLoading(false);
  }, [calendar.id]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // Load templates available to the calendar composer (scope IN ('calendar','global')).
  // Per spec §9.5 — only fired once per mount; templates rarely change.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await CalendarBlastService.listCalendarTemplates();
      if (cancelled) return;
      if (result.success && result.data) {
        setTemplates(result.data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleApplyTemplate = (templateId: string) => {
    if (!templateId) return;
    const template = templates.find((t) => t.id === templateId);
    if (!template) return;
    // Email channel: load subject + html_body. SMS/WhatsApp: load text_body
    // (or html stripped) since char-count matters there.
    setSubject(template.subject);
    if (channel === 'email') {
      setBody(template.html_body || template.text_body || '');
    } else {
      setBody(template.text_body || stripHtml(template.html_body || ''));
    }
    toast.success(`Loaded template "${template.name}"`);
  };

  const channelDisabled = useMemo(() => {
    return {
      email: false,
      sms: !smsEnabled,
      whatsapp: !whatsappEnabled,
    };
  }, [smsEnabled, whatsappEnabled]);

  const composeIsValid = (channel === 'email' ? subject.trim().length > 0 : true) && body.trim().length > 0;
  const canSend = !sending && previewCount !== null && previewCount > 0 && composeIsValid;
  const canSaveDraft = !sending && !savingDraft && composeIsValid;
  const canSchedule = canSend && !scheduling;

  const resetCompose = () => {
    setSubject('');
    setBody('');
  };

  const handleSaveDraft = async () => {
    if (!user?.id) {
      toast.error('Not authenticated');
      return;
    }
    setSavingDraft(true);
    try {
      const create = await CalendarBlastService.createBlast(
        {
          calendar_id: calendar.id,
          channel,
          subject,
          body_template: body,
          audience_filter: filter,
        },
        user.id,
      );
      if (!create.success) {
        toast.error(create.error || 'Failed to save draft');
        return;
      }
      toast.success('Draft saved');
      resetCompose();
      await loadHistory();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save draft');
    } finally {
      setSavingDraft(false);
    }
  };

  const handleConfirmSchedule = async () => {
    if (!user?.id) {
      toast.error('Not authenticated');
      return;
    }
    // datetime-local emits "yyyy-MM-ddTHH:mm" in the browser's local TZ.
    // Convert to an ISO timestamp the worker can compare against now() UTC.
    const scheduledIso = new Date(scheduledAt).toISOString();
    if (Number.isNaN(Date.parse(scheduledIso)) || new Date(scheduledIso).getTime() <= Date.now()) {
      toast.error('Schedule time must be in the future');
      return;
    }
    setScheduling(true);
    setScheduleOpen(false);
    try {
      const create = await CalendarBlastService.createBlast(
        {
          calendar_id: calendar.id,
          channel,
          subject,
          body_template: body,
          audience_filter: filter,
          schedule_at: scheduledIso,
        },
        user.id,
      );
      if (!create.success) {
        toast.error(create.error || 'Failed to schedule blast');
        return;
      }
      toast.success(`Blast scheduled for ${new Date(scheduledIso).toLocaleString()}`);
      resetCompose();
      await loadHistory();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to schedule blast');
    } finally {
      setScheduling(false);
    }
  };

  const handleCancelBlast = async (blastId: string) => {
    const result = await CalendarBlastService.cancelBlast(blastId);
    if (!result.success) {
      toast.error(result.error || 'Failed to cancel blast');
      return;
    }
    toast.success('Blast cancelled');
    await loadHistory();
  };

  const handleConfirmSend = async () => {
    if (!user?.id) {
      toast.error('Not authenticated');
      return;
    }
    setSending(true);
    setConfirmOpen(false);
    try {
      const create = await CalendarBlastService.createBlast(
        {
          calendar_id: calendar.id,
          channel,
          subject,
          body_template: body,
          audience_filter: filter,
        },
        user.id
      );
      if (!create.success || !create.data) {
        toast.error(create.error || 'Failed to create blast');
        setSending(false);
        return;
      }
      const send = await CalendarBlastService.sendBlast(create.data.id);
      if (!send.success) {
        toast.error(send.error || 'Failed to send blast');
        setSending(false);
        return;
      }
      toast.success(`Blast queued for ${previewCount} recipients`);
      setSubject('');
      setBody('');
      await loadHistory();
    } catch (err: any) {
      toast.error(err.message || 'Unexpected error');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Composer card */}
      <Card className="p-6">
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">Send a message</h2>

        {/* Channel selector */}
        <div className="flex gap-2 mb-4">
          {CHANNEL_OPTIONS.map((opt) => {
            const disabled = channelDisabled[opt.value];
            const Icon = opt.icon;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => !disabled && setChannel(opt.value)}
                disabled={disabled}
                title={disabled ? `Install the ${opt.moduleId} module to use this channel` : undefined}
                className={`flex items-center gap-2 px-4 py-2 rounded-md border text-sm font-medium transition-colors ${
                  channel === opt.value
                    ? 'bg-[var(--accent-9)] text-white border-[var(--accent-9)]'
                    : disabled
                      ? 'bg-[var(--gray-2)] text-[var(--gray-9)] border-[var(--gray-6)] cursor-not-allowed'
                      : 'bg-[var(--gray-2)] text-[var(--gray-11)] border-[var(--gray-6)] hover:border-[var(--gray-8)]'
                }`}
              >
                <Icon className="size-4" />
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Audience filter */}
          <CalendarAudienceFilter
            calendarId={calendar.id}
            channel={channel}
            value={filter}
            onChange={(f, count) => {
              setFilter(f);
              setPreviewCount(count);
            }}
            availableEvents={linkedEvents}
          />

          {/* Composer */}
          <Card className="p-4 space-y-3">
            <h3 className="text-sm font-semibold text-[var(--gray-12)]">Message</h3>
            {templates.length > 0 && (
              <div>
                <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">
                  Load from template
                </label>
                <select
                  value=""
                  onChange={(e) => {
                    handleApplyTemplate(e.target.value);
                    e.target.value = '';
                  }}
                  className="w-full bg-[var(--gray-2)] border border-[var(--gray-6)] rounded px-3 py-2 text-sm"
                >
                  <option value="">— select a template —</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.template_scope === 'global' ? ' (global)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {channel === 'email' && (
              <div>
                <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">
                  Subject
                </label>
                <Input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="What's this about?"
                />
              </div>
            )}
            <div>
              <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">
                {channel === 'email' ? 'Body' : 'Message'}
              </label>
              {channel === 'email' ? (
                // Per spec §9.3: email composer uses RichTextEditor; SMS/
                // WhatsApp keep the plain textarea (char count matters).
                <RichTextEditor
                  content={body}
                  onChange={(html: string) => setBody(html)}
                  placeholder={'Hi {{member_name}},\n\n…'}
                />
              ) : (
                <>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={6}
                    placeholder={
                      channel === 'sms'
                        ? 'Short and sweet — SMS char limit applies.'
                        : 'Your WhatsApp message…'
                    }
                    className="w-full bg-[var(--gray-2)] border border-[var(--gray-6)] rounded px-3 py-2 text-sm font-mono"
                  />
                  <div className="text-[10px] text-[var(--gray-10)] mt-1">{body.length} chars</div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 flex-wrap">
              <Button
                type="button"
                variant="outline"
                onClick={handleSaveDraft}
                disabled={!canSaveDraft}
              >
                <DocumentDuplicateIcon className="size-4 mr-1" />
                {savingDraft ? 'Saving…' : 'Save as draft'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => setScheduleOpen(true)}
                disabled={!canSchedule}
                title={previewCount === 0 ? 'No recipients match the audience filter' : undefined}
              >
                <CalendarDaysIcon className="size-4 mr-1" />
                {scheduling ? 'Scheduling…' : 'Schedule'}
              </Button>
              <Button
                type="button"
                onClick={() => setConfirmOpen(true)}
                disabled={!canSend}
              >
                <PaperAirplaneIcon className="size-4 mr-1" />
                {sending ? 'Sending…' : 'Send now'}
              </Button>
            </div>
          </Card>
        </div>
      </Card>

      {/* History */}
      <Card className="p-6">
        <h2 className="text-lg font-semibold text-[var(--gray-12)] mb-4">History</h2>
        {historyLoading ? (
          <LoadingSpinner />
        ) : history.length === 0 ? (
          <p className="text-sm text-[var(--gray-10)]">No blasts sent yet.</p>
        ) : (
          <div className="space-y-2">
            {history.map((blast) => {
              const isCancellable = blast.status === 'draft' || blast.status === 'scheduled' || blast.status === 'sending';
              return (
                <div
                  key={blast.id}
                  className="flex items-center justify-between border border-[var(--gray-6)] rounded-md px-4 py-3 gap-3 hover:bg-[var(--gray-2)] transition-colors cursor-pointer"
                  onClick={() => setDrawerBlastId(blast.id)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <StatusBadge status={blast.status} />
                      <span className="text-xs text-[var(--gray-10)] uppercase">{blast.channel}</span>
                    </div>
                    <div className="text-sm font-medium text-[var(--gray-12)] mt-1 truncate">
                      {blast.subject || <span className="italic text-[var(--gray-10)]">no subject</span>}
                    </div>
                    <div className="text-xs text-[var(--gray-10)] mt-0.5">
                      {blast.recipient_count} recipients ·{' '}
                      {blast.sent_at
                        ? `sent ${new Date(blast.sent_at).toLocaleString()}`
                        : blast.scheduled_at
                          ? `scheduled for ${new Date(blast.scheduled_at).toLocaleString()}`
                          : `created ${new Date(blast.created_at).toLocaleString()}`}
                    </div>
                  </div>
                  {isCancellable && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleCancelBlast(blast.id);
                      }}
                      title="Cancel this blast"
                    >
                      <XCircleIcon className="size-4 mr-1" />
                      Cancel
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <ConfirmModal
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleConfirmSend}
        title={`Send ${channel} blast?`}
        message={
          previewCount !== null
            ? `This will send to ${previewCount.toLocaleString()} ${previewCount === 1 ? 'recipient' : 'recipients'}. Continue?`
            : 'Audience preview not yet loaded.'
        }
        confirmText="Send blast"
      />

      {/* Per-blast detail drawer — clicking a row opens it. */}
      <CalendarBlastDrawer blastId={drawerBlastId} onClose={() => setDrawerBlastId(null)} />

      {/* Schedule modal — datetime picker + confirm. */}
      {scheduleOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setScheduleOpen(false)}
        >
          <div
            className="bg-[var(--color-background)] border border-[var(--gray-6)] rounded-lg p-6 max-w-md w-full mx-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold text-[var(--gray-12)] mb-2">
              Schedule {channel} blast
            </h3>
            <p className="text-xs text-[var(--gray-10)] mb-4">
              The dispatcher cron picks up scheduled blasts every minute.
              {previewCount !== null && (
                <> Audience: {previewCount.toLocaleString()} {previewCount === 1 ? 'recipient' : 'recipients'}.</>
              )}
            </p>
            <label className="block text-xs font-medium text-[var(--gray-11)] mb-1">
              Send at (your local time)
            </label>
            <input
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              min={(() => {
                const d = new Date(Date.now() + 60 * 1000);
                const pad = (n: number) => String(n).padStart(2, '0');
                return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
              })()}
              className="w-full bg-[var(--gray-2)] border border-[var(--gray-6)] rounded px-3 py-2 text-sm"
            />
            <div className="flex justify-end gap-2 mt-4">
              <Button type="button" variant="outline" onClick={() => setScheduleOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={handleConfirmSchedule} disabled={scheduling}>
                {scheduling ? 'Scheduling…' : 'Schedule blast'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
