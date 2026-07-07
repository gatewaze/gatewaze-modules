import { useState, useEffect, useCallback } from 'react';
import { RepliesWorkspace, type WorkspaceReply } from '@/components/replies/RepliesWorkspace';
import type { SentReplyMessage } from '@/components/emails/ReplyComposer';
import { resolvePeopleByEmail } from '@/lib/resolvePeopleByEmail';
import { supabase } from '@/lib/supabase';

interface BroadcastRepliesTabProps {
  broadcastId: string;
}

const REPLY_COLS =
  'id, from_email, from_name, subject, body_text, body_html, is_read, is_starred, is_archived, is_auto_reply, auto_reply_reason, forwarded_to, forwarded_at, created_at';

export function BroadcastRepliesTab({ broadcastId }: BroadcastRepliesTabProps) {
  const [replies, setReplies] = useState<WorkspaceReply[]>([]);
  const [sent, setSent] = useState<(SentReplyMessage & { reply_id: string })[]>([]);
  const [personByEmail, setPersonByEmail] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [repliesRes, sentRes] = await Promise.all([
      supabase
        .from('broadcast_replies')
        .select(REPLY_COLS)
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: false }),
      supabase
        .from('broadcast_reply_messages')
        .select('id, reply_id, from_address, to_address, subject, body_html, body_text, attachments, created_at')
        .eq('broadcast_id', broadcastId)
        .order('created_at', { ascending: true }),
    ]);
    const rows = (repliesRes.data as WorkspaceReply[]) || [];
    setReplies(rows);
    setSent((sentRes.data as (SentReplyMessage & { reply_id: string })[]) || []);
    setPersonByEmail(await resolvePeopleByEmail(rows.map((r) => r.from_email)));
    setLoading(false);
  }, [broadcastId]);

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
      kind="broadcast"
      replies={replies}
      sent={sent}
      personByEmail={personByEmail}
      onReload={load}
      emptyHint="Replies to this broadcast will appear here"
    />
  );
}
