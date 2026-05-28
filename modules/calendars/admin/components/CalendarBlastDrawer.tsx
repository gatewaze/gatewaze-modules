import { useEffect, useState } from 'react';
import {
  XMarkIcon,
  EnvelopeIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ClockIcon,
} from '@heroicons/react/24/outline';
import { Badge, Button } from '@/components/ui';
import LoadingSpinner from '@/components/shared/LoadingSpinner';
import {
  CalendarBlastService,
  BlastDetail,
  BlastRecipientLog,
} from '../services/calendarBlastService';

/**
 * Per-blast detail drawer — opens when an admin clicks a row in the
 * messaging history. Per spec-calendars-microsites §9.3:
 *
 *   "Each row links to a detail drawer with per-recipient delivery
 *    (pulled from email_batch_jobs → bulk-emailing per-recipient log)."
 *
 * For email channel: pulls per-recipient rows from `email_send_log`
 * filtered by `metadata->>batch_job_id = blast.email_batch_job_id`.
 *
 * For SMS/WhatsApp: shows the blast row + recipient_count summary; the
 * twilio-sms / whatsapp modules don't yet expose a queryable per-recipient
 * log table. v2 wires that in.
 */
interface Props {
  blastId: string | null;
  onClose: () => void;
}

function recipientStatusBadge(status: string): { color: string; icon: typeof CheckCircleIcon | null; label: string } {
  switch (status) {
    case 'sent':
    case 'delivered':
      return { color: 'green', icon: CheckCircleIcon, label: status };
    case 'queued':
    case 'sending':
      return { color: 'amber', icon: ClockIcon, label: status };
    case 'failed':
    case 'bounced':
    case 'rejected':
      return { color: 'red', icon: ExclamationCircleIcon, label: status };
    default:
      return { color: 'gray', icon: null, label: status };
  }
}

function summariseRecipients(recipients: BlastRecipientLog[]): { sent: number; failed: number; pending: number } {
  let sent = 0;
  let failed = 0;
  let pending = 0;
  for (const r of recipients) {
    if (r.status === 'sent' || r.status === 'delivered') sent++;
    else if (r.status === 'failed' || r.status === 'bounced' || r.status === 'rejected') failed++;
    else pending++;
  }
  return { sent, failed, pending };
}

export function CalendarBlastDrawer({ blastId, onClose }: Props) {
  const [detail, setDetail] = useState<BlastDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!blastId) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      const result = await CalendarBlastService.getBlastDetail(blastId);
      if (cancelled) return;
      if (result.success && result.data) {
        setDetail(result.data);
      } else {
        setError(result.error ?? 'Failed to load blast');
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [blastId]);

  if (!blastId) return null;

  const summary = detail ? summariseRecipients(detail.recipients) : { sent: 0, failed: 0, pending: 0 };

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-background)] border-l border-[var(--gray-6)] w-full max-w-2xl h-full overflow-y-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between p-4 border-b border-[var(--gray-6)] bg-[var(--color-background)]">
          <h2 className="text-base font-semibold text-[var(--gray-12)]">Blast detail</h2>
          <button
            onClick={onClose}
            className="text-[var(--gray-10)] hover:text-[var(--gray-12)]"
            aria-label="Close drawer"
          >
            <XMarkIcon className="size-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          {loading && <LoadingSpinner />}
          {error && (
            <div className="text-sm text-[var(--red-11)]">
              {error}
            </div>
          )}
          {detail && (
            <>
              {/* Blast metadata */}
              <section>
                <div className="flex items-center gap-2 mb-2">
                  <Badge>{detail.blast.channel}</Badge>
                  {/* Badge.color is a closed Radix-style union; the dynamic
                      ternary widens to string and TS rejects. eslint-disable
                      keeps the local cast scoped + documented. */}
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  <Badge color={(detail.blast.status === 'sent' ? 'green' : detail.blast.status === 'failed' ? 'red' : 'gray') as any}>
                    {detail.blast.status}
                  </Badge>
                </div>
                <h3 className="text-lg font-semibold text-[var(--gray-12)]">
                  {detail.blast.subject || <span className="italic text-[var(--gray-10)]">no subject</span>}
                </h3>
                <p className="text-xs text-[var(--gray-10)] mt-1">
                  {detail.blast.recipient_count.toLocaleString()} target recipients ·{' '}
                  {detail.blast.sent_at
                    ? `sent ${new Date(detail.blast.sent_at).toLocaleString()}`
                    : detail.blast.scheduled_at
                      ? `scheduled for ${new Date(detail.blast.scheduled_at).toLocaleString()}`
                      : `created ${new Date(detail.blast.created_at).toLocaleString()}`}
                </p>
              </section>

              {/* Body preview */}
              <section>
                <h4 className="text-xs font-semibold text-[var(--gray-11)] uppercase mb-2">Body</h4>
                {detail.blast.channel === 'email' ? (
                  <div
                    className="border border-[var(--gray-6)] rounded p-4 text-sm bg-[var(--gray-2)] max-h-80 overflow-y-auto prose prose-sm max-w-none"
                    dangerouslySetInnerHTML={{ __html: detail.blast.body_template ?? '' }}
                  />
                ) : (
                  <pre className="border border-[var(--gray-6)] rounded p-4 text-sm bg-[var(--gray-2)] max-h-80 overflow-y-auto whitespace-pre-wrap font-mono">
                    {detail.blast.body_template ?? ''}
                  </pre>
                )}
              </section>

              {/* Audience filter snapshot */}
              <section>
                <h4 className="text-xs font-semibold text-[var(--gray-11)] uppercase mb-2">Audience filter</h4>
                <pre className="border border-[var(--gray-6)] rounded p-4 text-xs bg-[var(--gray-2)] overflow-x-auto whitespace-pre-wrap font-mono">
                  {JSON.stringify(detail.blast.audience_filter, null, 2)}
                </pre>
              </section>

              {/* Per-recipient delivery */}
              <section>
                <h4 className="text-xs font-semibold text-[var(--gray-11)] uppercase mb-2">
                  Delivery {detail.recipients.length > 0 && `(${detail.recipients.length})`}
                </h4>
                {detail.blast.channel !== 'email' ? (
                  <p className="text-sm text-[var(--gray-10)] italic">
                    Per-recipient logs aren&rsquo;t available for {detail.blast.channel} blasts yet — the channel module doesn&rsquo;t expose a queryable delivery log.
                  </p>
                ) : detail.recipients.length === 0 ? (
                  <p className="text-sm text-[var(--gray-10)] italic">
                    No per-recipient logs yet — either the blast hasn&rsquo;t started sending, or email-batch-send hasn&rsquo;t written entries to email_send_log.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center gap-3 mb-3 text-xs">
                      <span className="text-[var(--green-11)]">{summary.sent} sent</span>
                      <span className="text-[var(--red-11)]">{summary.failed} failed</span>
                      <span className="text-[var(--amber-11)]">{summary.pending} pending</span>
                    </div>
                    <ul className="space-y-1">
                      {detail.recipients.map((r) => {
                        const cfg = recipientStatusBadge(r.status);
                        const Icon = cfg.icon;
                        return (
                          <li
                            key={r.id}
                            className="flex items-center justify-between py-1.5 px-3 rounded bg-[var(--gray-2)] text-sm"
                          >
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <EnvelopeIcon className="size-4 text-[var(--gray-10)] shrink-0" />
                              <span className="truncate text-[var(--gray-12)]">{r.recipient_email}</span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              {r.failure_error && (
                                <span className="text-xs text-[var(--red-11)] max-w-[14rem] truncate" title={r.failure_error}>
                                  {r.failure_error}
                                </span>
                              )}
                              {/* Same Radix Badge.color narrowing as above. */}
                              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                              <Badge color={cfg.color as any}>
                                {Icon && <Icon className="size-3 mr-1 inline-block" />}
                                {cfg.label}
                              </Badge>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                )}
              </section>

              <div className="flex justify-end pt-4 border-t border-[var(--gray-6)]">
                <Button type="button" variant="outline" onClick={onClose}>
                  Close
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
