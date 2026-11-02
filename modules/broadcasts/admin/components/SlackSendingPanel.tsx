import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card } from '@/components/ui';
import {
  createSlackBroadcastSend, getSlackStatus, listSlackRecipients, listSlackSends, sendSlackTest, setSlackSendStatus,
  slackRecipientCount, slackSendCounts, updateBroadcast,
  type Broadcast, type SlackRecipientRow, type SlackSendCounts, type SlackSendRow, type SlackSender, type SlackStatus,
} from '../lib/broadcastService';

// Matches the worker's pace (workers/dispatch-slack.ts, SLACK_BROADCAST_INTERVAL_MS).
export const SLACK_SECONDS_PER_MESSAGE = 3;
const PAGE_SIZE = 25;
const ACTIVE = new Set(['scheduled', 'sending', 'cancelling', 'paused']);

const inputCls = 'rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm disabled:opacity-60';

export function formatDuration(people: number, secondsEach = SLACK_SECONDS_PER_MESSAGE): string {
  const minutes = Math.ceil((people * secondsEach) / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hour${h === 1 ? '' : 's'} ${m} min` : `${h} hour${h === 1 ? '' : 's'}`;
}

/** Why the chosen sender cannot send yet, or null when it can. */
export function senderProblem(sender: SlackSender, status: SlackStatus | null): string | null {
  if (!status) return null;
  if (sender === 'welcome_sender') {
    return status.welcome_sender?.connected ? null : 'No account is connected for welcome DMs. Connect one on the Slack welcome DM page.';
  }
  const bot = status.bot;
  if (!bot?.configured) return 'No Slack bot token is configured. Add SLACK_BOT_TOKEN in the Slack module settings.';
  if (!bot.ok) return `Slack refused the bot token (${bot.error ?? 'unknown error'}).`;
  if (bot.missing_scopes?.length) return `The Slack bot is missing the ${bot.missing_scopes.join(' and ')} scope${bot.missing_scopes.length === 1 ? '' : 's'}. Add them to the Slack app and reinstall it.`;
  return null;
}

const STATUS_COLOURS: Record<string, string> = {
  sent: 'text-[var(--green-11)] bg-[var(--green-a3)]',
  failed: 'text-[var(--red-11)] bg-[var(--red-a3)]',
  sending: 'text-[var(--blue-11)] bg-[var(--blue-a3)]',
  paused: 'text-[var(--amber-11)] bg-[var(--amber-a3)]',
};
function StatusPill({ status }: { status: string }) {
  const label = status === 'cancelling' ? 'stopping' : status;
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_COLOURS[status] ?? 'text-[var(--gray-11)] bg-[var(--gray-a3)]'}`}>{label}</span>;
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '';
}

export function SlackSendingPanel({ b, onChanged }: { b: Broadcast; onChanged: (b: Broadcast) => void }) {
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [sends, setSends] = useState<SlackSendRow[]>([]);
  const [counts, setCounts] = useState<Record<string, SlackSendCounts>>({});
  const [exclude, setExclude] = useState<string[]>([]);
  const [deliverable, setDeliverable] = useState<number | null>(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testing, setTesting] = useState(false);
  const [openSend, setOpenSend] = useState<string | null>(null);

  useEffect(() => {
    getSlackStatus().then(setStatus).catch((e) => setStatusError(e instanceof Error ? e.message : 'Could not check Slack'));
  }, []);

  const loadSends = useCallback(async () => {
    const rows = await listSlackSends(b.id);
    setSends(rows);
    const entries = await Promise.all(rows.filter((s) => s.status !== 'scheduled').map(async (s) => [s.id, await slackSendCounts(s.id)] as const));
    setCounts(Object.fromEntries(entries));
  }, [b.id]);

  useEffect(() => { loadSends().catch(() => {}); }, [loadSends]);

  // Refresh while anything is in flight.
  const anyActive = sends.some((s) => ACTIVE.has(s.status));
  useEffect(() => {
    if (!anyActive) return;
    const t = setInterval(() => { loadSends().catch(() => {}); }, 10_000);
    return () => clearInterval(t);
  }, [anyActive, loadSends]);

  useEffect(() => {
    if (!b.segment_id) { setDeliverable(null); return; }
    let cancelled = false;
    slackRecipientCount(b.segment_id, exclude, b.include_prospects ?? false)
      .then((n) => { if (!cancelled) setDeliverable(n); })
      .catch(() => { if (!cancelled) setDeliverable(null); });
    return () => { cancelled = true; };
  }, [b.segment_id, b.include_prospects, exclude]);

  const problem = senderProblem(b.slack_sender ?? 'bot', status);
  const blockReason = !b.segment_id ? 'Set an audience first'
    : !(b.body_text ?? '').trim() ? 'Write the message first'
    : problem
    ?? (deliverable === 0 ? 'Nobody in this audience is linked to a Slack member' : null);
  const previousSends = useMemo(() => sends.filter((s) => s.status === 'sent' || s.status === 'cancelled' || s.status === 'failed' || s.status === 'sending' || s.status === 'paused'), [sends]);

  async function chooseSender(sender: SlackSender) {
    try {
      onChanged(await updateBroadcast(b.id, { slack_sender: sender } as Partial<Broadcast>));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to change the sender');
    }
  }

  async function send() {
    setCreating(true);
    try {
      const scheduledAt = scheduleAt ? new Date(scheduleAt).toISOString() : null;
      await createSlackBroadcastSend(b.id, { scheduledAt, excludeSentSendIds: exclude });
      toast.success(scheduledAt ? 'Slack send scheduled' : 'Slack send started; the first messages go out within a minute or two');
      setConfirming(false);
      setScheduleAt('');
      await loadSends();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create the send');
    } finally {
      setCreating(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      await sendSlackTest(b, testEmail.trim());
      toast.success(`Test sent to ${testEmail.trim()} in Slack`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setTesting(false);
    }
  }

  async function act(s: SlackSendRow, action: 'pause' | 'resume' | 'cancel') {
    if (action === 'cancel') {
      const live = s.status === 'sending' || s.status === 'paused';
      // Same confirmation as the email Sending panel: stopping can't be undone.
      if (!window.confirm(live ? 'Stop this send? People not yet messaged will not get it.' : 'Cancel this scheduled send?')) return;
    }
    try {
      await setSlackSendStatus(s.id, action, s.status);
      toast.success(action === 'pause' ? 'Send paused' : action === 'resume' ? 'Send resumed' : 'Send stopped');
      await loadSends();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update the send');
    }
  }

  const sender = b.slack_sender ?? 'bot';

  return (
    <div className="space-y-4">
      <Card className="p-4 space-y-3">
        <div className="text-sm font-medium text-[var(--gray-12)]">Send as</div>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Sender">
          {([
            { id: 'bot', label: 'Workspace bot', detail: status?.bot?.ok ? `${status.bot.name ?? 'Bot'}${status.bot.team ? ` in ${status.bot.team}` : ''}` : 'The Slack app’s bot user' },
            { id: 'welcome_sender', label: 'Welcome-DM account', detail: status?.welcome_sender?.connected ? `${status.welcome_sender.name ?? 'Connected account'}` : 'Not connected' },
          ] as const).map((o) => (
            <label key={o.id} className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm ${sender === o.id ? 'border-[var(--accent-9)] bg-[var(--accent-a2)]' : 'border-[var(--gray-6)]'}`}>
              <input type="radio" name="slack-sender" className="mt-0.5" checked={sender === o.id} onChange={() => chooseSender(o.id)} />
              <span>
                <span className="block font-medium text-[var(--gray-12)]">{o.label}</span>
                <span className="block text-xs text-[var(--gray-10)]">{o.detail}</span>
              </span>
            </label>
          ))}
        </div>
        {statusError && <p className="text-xs text-[var(--red-11)]">Could not check the Slack connection: {statusError}</p>}
        {problem && <p className="text-xs text-[var(--red-11)]">{problem}</p>}
        {sender === 'welcome_sender' && !problem && (
          <p className="text-xs text-[var(--amber-11)]">Every message will come from this person&apos;s own Slack account and appear in their DMs.</p>
        )}
      </Card>

      <Card className="p-4 space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-medium text-[var(--gray-12)]">New send</div>
          <div className="text-sm text-[var(--gray-11)]">
            {deliverable == null ? 'Counting recipients…'
              : `${deliverable.toLocaleString()} ${deliverable === 1 ? 'person' : 'people'} in Slack · about ${formatDuration(deliverable)}`}
          </div>
        </div>
        <p className="text-xs text-[var(--gray-10)]">
          Only people in the audience who are linked to a Slack member get the message, one every {SLACK_SECONDS_PER_MESSAGE} seconds.
          Email list subscriptions do not apply.
        </p>

        {previousSends.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-medium text-[var(--gray-11)]">Skip people already messaged by</div>
            {previousSends.map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-xs text-[var(--gray-12)]">
                <input
                  type="checkbox"
                  checked={exclude.includes(s.id)}
                  onChange={(e) => setExclude((cur) => e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id))}
                />
                The send started {when(s.started_at ?? s.created_at)} ({counts[s.id]?.sent?.toLocaleString() ?? 0} sent)
              </label>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-[var(--gray-11)]">
            <span className="block mb-1">Send at (leave empty to send now)</span>
            <input type="datetime-local" className={inputCls} value={scheduleAt} onChange={(e) => { setScheduleAt(e.target.value); setConfirming(false); }} />
          </label>
          {!confirming ? (
            <Button variant="solid" disabled={!!blockReason || creating} onClick={() => setConfirming(true)}>
              {scheduleAt ? 'Schedule' : 'Send now'}
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm text-[var(--gray-12)]">
                Message {deliverable?.toLocaleString() ?? '?'} people{scheduleAt ? ` at ${new Date(scheduleAt).toLocaleString()}` : ' now'}?
              </span>
              <Button variant="solid" disabled={creating} onClick={send}>{creating ? 'Starting…' : 'Confirm'}</Button>
              <Button variant="soft" disabled={creating} onClick={() => setConfirming(false)}>Back</Button>
            </div>
          )}
        </div>
        {blockReason && <p className="text-xs text-[var(--red-11)]">{blockReason}</p>}

        <div className="flex flex-wrap items-end gap-2 border-t border-[var(--gray-5)] pt-3">
          <label className="text-xs text-[var(--gray-11)]">
            <span className="block mb-1">Test: send to one person, by their email</span>
            <input type="email" className={`${inputCls} w-72`} value={testEmail} onChange={(e) => setTestEmail(e.target.value)} placeholder="name@example.com" />
          </label>
          <Button variant="soft" disabled={testing || !testEmail.trim() || !(b.body_text ?? '').trim() || !!problem} onClick={test}>{testing ? 'Sending…' : 'Send test'}</Button>
        </div>
      </Card>

      {sends.length > 0 && (
        <Card className="p-4 space-y-3">
          <div className="text-sm font-medium text-[var(--gray-12)]">Sends</div>
          {sends.map((s) => {
            const c = counts[s.id];
            const total = c ? c.pending + c.sending + c.sent + c.failed + c.skipped : 0;
            const done = c ? c.sent + c.failed + c.skipped : 0;
            return (
              <div key={s.id} className="rounded-md border border-[var(--gray-5)] p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    <StatusPill status={s.status} />
                    <span className="text-[var(--gray-11)]">
                      {s.status === 'scheduled' ? `Scheduled for ${when(s.scheduled_at)}` : `Started ${when(s.started_at ?? s.created_at)}`}
                      {s.metadata?.slack_sender === 'welcome_sender' ? ' · as the welcome-DM account' : ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {s.status === 'sending' && <Button variant="soft" onClick={() => act(s, 'pause')}>Pause</Button>}
                    {s.status === 'paused' && <Button variant="soft" onClick={() => act(s, 'resume')}>Resume</Button>}
                    {s.status === 'scheduled' && <Button variant="soft" onClick={() => act(s, 'cancel')}>Cancel</Button>}
                    {(s.status === 'sending' || s.status === 'paused') && <Button variant="soft" onClick={() => act(s, 'cancel')}>Stop</Button>}
                    {s.status !== 'scheduled' && (
                      <Button variant="soft" onClick={() => setOpenSend(openSend === s.id ? null : s.id)}>{openSend === s.id ? 'Hide people' : 'People'}</Button>
                    )}
                  </div>
                </div>
                {s.status === 'paused' && s.metadata?.paused_reason && <p className="text-xs text-[var(--amber-11)]">Paused: {s.metadata.paused_reason}</p>}
                {s.status === 'failed' && s.metadata?.error && <p className="text-xs text-[var(--red-11)]">{s.metadata.error}</p>}
                {c && total > 0 && (
                  <div className="space-y-1">
                    <div className="h-1.5 overflow-hidden rounded bg-[var(--gray-4)]">
                      <div className="h-full bg-[var(--accent-9)]" style={{ width: `${Math.round((done / total) * 100)}%` }} />
                    </div>
                    <div className="text-xs text-[var(--gray-11)]">
                      {c.sent.toLocaleString()} sent · {c.failed.toLocaleString()} failed · {(c.pending + c.sending).toLocaleString()} to go
                      {c.skipped ? ` · ${c.skipped.toLocaleString()} skipped` : ''}
                      {(c.pending + c.sending) > 0 && (s.status === 'sending') ? ` · about ${formatDuration(c.pending + c.sending)} left` : ''}
                    </div>
                  </div>
                )}
                {openSend === s.id && <SlackRecipientLog sendId={s.id} active={ACTIVE.has(s.status)} />}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

function SlackRecipientLog({ sendId, active }: { sendId: string; active: boolean }) {
  const [filter, setFilter] = useState<SlackRecipientRow['status'] | ''>('');
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<SlackRecipientRow[]>([]);
  const [total, setTotal] = useState(0);

  const load = useCallback(() => {
    listSlackRecipients(sendId, { status: filter || undefined, page, pageSize: PAGE_SIZE })
      .then((r) => { setRows(r.rows); setTotal(r.total); })
      .catch(() => { setRows([]); setTotal(0); });
  }, [sendId, filter, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [active, load]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  return (
    <div className="space-y-2 border-t border-[var(--gray-5)] pt-2">
      <div className="flex items-center gap-2 text-xs">
        <select className={inputCls} value={filter} onChange={(e) => { setFilter(e.target.value as SlackRecipientRow['status'] | ''); setPage(0); }}>
          <option value="">Everyone</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="pending">To go</option>
          <option value="skipped">Skipped</option>
        </select>
        <span className="text-[var(--gray-10)]">{total.toLocaleString()} {total === 1 ? 'person' : 'people'}</span>
      </div>
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--gray-10)]">
              <th className="px-2 py-1 font-medium">Email</th>
              <th className="px-2 py-1 font-medium">Status</th>
              <th className="px-2 py-1 font-medium">Detail</th>
              <th className="px-2 py-1 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-[var(--gray-4)]">
                <td className="px-2 py-1 text-[var(--gray-12)]">{r.email}</td>
                <td className="px-2 py-1"><StatusPill status={r.status} /></td>
                <td className="px-2 py-1 text-[var(--gray-11)]">{r.status === 'sent' ? '' : (r.last_error ?? '')}</td>
                <td className="px-2 py-1 text-[var(--gray-10)] whitespace-nowrap">{when(r.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center gap-2 text-xs">
          <Button variant="soft" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="text-[var(--gray-10)]">Page {page + 1} of {pages}</span>
          <Button variant="soft" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}
