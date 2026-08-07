import { useState, useEffect, useCallback } from 'react';
import { RepliesWorkspace, type WorkspaceReply } from '@/components/replies/RepliesWorkspace';
import type { SentReplyMessage } from '@/components/emails/ReplyComposer';
import { resolvePeopleByEmail } from '@/lib/resolvePeopleByEmail';
import { supabase } from '@/lib/supabase';

/**
 * Replies to this event's comms — speaker approvals, confirmations,
 * presentation reminders, ad-hoc sends.
 *
 * Mirrors BroadcastRepliesTab: the workspace component owns the whole inbox UI
 * (folders, triage, thread, composer) and only needs the rows plus a `kind`.
 *
 * Unlike the newsletter tab there is no subject-matching heuristic — an event
 * reply is linked by batch_job_id → event_id at inbound-parse time, so the
 * event_id filter below is exact.
 */
interface EventRepliesTabProps {
  /** Event UUID. Event-detail tab slots receive event.id, not the short id. */
  eventId: string;
}

const REPLY_COLS =
  'id, from_email, from_name, subject, body_text, body_html, is_read, is_starred, is_archived, is_auto_reply, auto_reply_reason, forwarded_to, forwarded_at, created_at';

export function EventRepliesTab({ eventId }: EventRepliesTabProps) {
  const [replies, setReplies] = useState<WorkspaceReply[]>([]);
  const [sent, setSent] = useState<(SentReplyMessage & { reply_id: string })[]>([]);
  const [personByEmail, setPersonByEmail] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [repliesRes, sentRes] = await Promise.all([
      supabase
        .from('event_replies')
        .select(REPLY_COLS)
        .eq('event_id', eventId)
        .order('created_at', { ascending: false }),
      supabase
        .from('event_reply_messages')
        .select('id, reply_id, from_address, to_address, subject, body_html, body_text, attachments, created_at')
        .eq('event_id', eventId)
        .order('created_at', { ascending: true }),
    ]);
    const rows = (repliesRes.data as WorkspaceReply[]) || [];
    setReplies(rows);
    setSent((sentRes.data as (SentReplyMessage & { reply_id: string })[]) || []);
    setPersonByEmail(await resolvePeopleByEmail(rows.map((r) => r.from_email)));
    setLoading(false);
  }, [eventId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
      </div>
    );
  }

  return (
    <RepliesWorkspace
      kind="event"
      replies={replies}
      sent={sent}
      personByEmail={personByEmail}
      onReload={load}
      emptyHint="Replies to this event's emails will appear here"
    />
  );
}

export default EventRepliesTab;
