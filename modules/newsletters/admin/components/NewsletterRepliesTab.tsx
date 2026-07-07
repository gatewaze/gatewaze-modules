import { useState, useEffect, useCallback, useMemo } from 'react';
import { RepliesWorkspace, type WorkspaceReply } from '@/components/replies/RepliesWorkspace';
import type { SentReplyMessage } from '@/components/emails/ReplyComposer';
import { resolvePeopleByEmail } from '@/lib/resolvePeopleByEmail';
import { supabase } from '@/lib/supabase';

interface NewsletterRepliesTabProps {
  newsletterId: string;
}

interface LoadedReply extends WorkspaceReply {
  edition_id: string | null;
  edition?: { title: string | null; edition_date: string } | null;
}

const REPLY_COLS =
  'id, from_email, from_name, subject, body_text, body_html, is_read, is_starred, is_archived, is_auto_reply, auto_reply_reason, forwarded_to, forwarded_at, created_at, edition_id';

// Reply-bleed across collections: when two collections share the same Reply-To
// (e.g. demetrios@aaif.live used by several newsletters), the inbound parser
// stores one row per matching collection — so a Reply-To-routed reply appears in
// every such collection's tab. Until that's deduped at insertion time, scope
// what this tab shows to replies whose subject references an edition of THIS
// collection. Subjects shorter than this aren't matched against, to avoid a
// one-word edition title hiding nothing.
const MIN_TITLE_MATCH_LENGTH = 4;

function normaliseForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

export function NewsletterRepliesTab({ newsletterId }: NewsletterRepliesTabProps) {
  const [replies, setReplies] = useState<LoadedReply[]>([]);
  const [editionTitles, setEditionTitles] = useState<string[]>([]);
  const [sent, setSent] = useState<(SentReplyMessage & { reply_id: string })[]>([]);
  const [personByEmail, setPersonByEmail] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [repliesRes, editionsRes, sentRes] = await Promise.all([
      supabase
        .from('newsletter_replies')
        .select(`${REPLY_COLS}, edition:newsletters_editions(title, edition_date)`)
        .eq('collection_id', newsletterId)
        .order('created_at', { ascending: false }),
      supabase
        .from('newsletters_editions')
        .select('title')
        .eq('collection_id', newsletterId)
        .not('title', 'is', null),
      supabase
        .from('newsletter_reply_messages')
        .select('id, reply_id, from_address, to_address, subject, body_html, body_text, attachments, created_at')
        .eq('collection_id', newsletterId)
        .order('created_at', { ascending: true }),
    ]);
    const rows = (repliesRes.data as LoadedReply[]) || [];
    setReplies(rows);
    setEditionTitles(
      ((editionsRes.data || []) as Array<{ title: string | null }>)
        .map((e) => e.title || '')
        .filter((t) => t.length >= MIN_TITLE_MATCH_LENGTH),
    );
    setSent((sentRes.data as (SentReplyMessage & { reply_id: string })[]) || []);
    setPersonByEmail(await resolvePeopleByEmail(rows.map((r) => r.from_email)));
    setLoading(false);
  }, [newsletterId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  // Scope to this collection's replies, then attach the edition as a badge.
  const scoped = useMemo<WorkspaceReply[]>(() => {
    const needles = editionTitles.map(normaliseForMatch);
    const inCollection = (r: LoadedReply) => {
      if (needles.length === 0) return true;
      if (r.edition_id) return true; // linked by In-Reply-To → trust it
      if (!r.subject) return false;
      const hay = normaliseForMatch(r.subject);
      return needles.some((n) => hay.includes(n));
    };
    return replies
      .filter(inCollection)
      .map((r) => ({ ...r, badge: r.edition?.title || r.edition?.edition_date || null }));
  }, [replies, editionTitles]);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
      </div>
    );
  }

  return (
    <RepliesWorkspace
      kind="newsletter"
      replies={scoped}
      sent={sent}
      personByEmail={personByEmail}
      onReload={load}
      emptyHint="Replies to your newsletter sending address will appear here"
    />
  );
}
