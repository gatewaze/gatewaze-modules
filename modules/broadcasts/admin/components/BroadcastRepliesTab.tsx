import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  EnvelopeIcon, EnvelopeOpenIcon, ChevronDownIcon, ChevronUpIcon, ArrowUturnRightIcon,
} from '@heroicons/react/24/outline';
import { toast } from 'sonner';
import { Card, Badge, Button } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { updateBroadcast, type Broadcast } from '../lib/broadcastService';

interface Reply {
  id: string;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  broadcast_send_id: string | null;
  is_read: boolean;
  is_auto_reply: boolean;
  auto_reply_reason: string | null;
  forwarded_to: string | null;
  forwarded_at: string | null;
  created_at: string;
  send?: { subject: string | null; created_at: string } | null;
}

interface BroadcastRepliesTabProps {
  broadcast: Broadcast;
  onUpdated: (b: Broadcast) => void;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const diffDays = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const inputCls = 'w-full rounded-md border border-[var(--gray-7)] bg-[var(--color-surface)] px-3 py-2 text-sm';

export function BroadcastRepliesTab({ broadcast, onUpdated }: BroadcastRepliesTabProps) {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAutoReplies, setShowAutoReplies] = useState(false);
  const [forwardTo, setForwardTo] = useState(broadcast.forward_replies_to ?? '');
  const [savingForward, setSavingForward] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('broadcast_replies')
      .select('*, send:broadcast_sends(subject, created_at)')
      .eq('broadcast_id', broadcast.id)
      .order('created_at', { ascending: false });
    setReplies((data as Reply[]) || []);
    setLoading(false);
  }, [broadcast.id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const autoReplyCount = useMemo(() => replies.filter((r) => r.is_auto_reply).length, [replies]);
  const visibleReplies = useMemo(
    () => (showAutoReplies ? replies : replies.filter((r) => !r.is_auto_reply)),
    [replies, showAutoReplies],
  );
  const unreadCount = visibleReplies.filter((r) => !r.is_read).length;

  const toggleExpand = async (reply: Reply) => {
    const isExpanding = expandedId !== reply.id;
    setExpandedId(isExpanding ? reply.id : null);
    if (isExpanding && !reply.is_read) {
      await supabase.from('broadcast_replies').update({ is_read: true }).eq('id', reply.id);
      setReplies((prev) => prev.map((r) => (r.id === reply.id ? { ...r, is_read: true } : r)));
    }
  };

  async function saveForward() {
    const val = forwardTo.trim() || null;
    if (val === (broadcast.forward_replies_to ?? null)) return;
    setSavingForward(true);
    try {
      const nb = await updateBroadcast(broadcast.id, { forward_replies_to: val } as Partial<Broadcast>);
      onUpdated(nb);
      toast.success(val ? `Replies will be forwarded to ${val}` : 'Reply forwarding turned off');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSavingForward(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-4">
      {/* Forward replies config (parity with newsletters) */}
      <Card className="p-4">
        <label className="block text-sm font-medium text-[var(--gray-12)] mb-1">Forward Replies To</label>
        <p className="text-xs text-[var(--gray-10)] mb-2">
          Human replies to this broadcast are also emailed to this address (auto-replies and bounces are not forwarded). Leave blank to only collect them here.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="email"
            className={inputCls}
            placeholder="team@example.com"
            value={forwardTo}
            onChange={(e) => setForwardTo(e.target.value)}
            onBlur={saveForward}
          />
          <Button variant="soft" onClick={saveForward} disabled={savingForward}>
            {savingForward ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </Card>

      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-[var(--gray-12)]">Replies</h2>
          {unreadCount > 0 && <Badge variant="solid" color="blue" size="1">{unreadCount} new</Badge>}
        </div>
        <div className="flex items-center gap-3">
          {autoReplyCount > 0 && (
            <button
              type="button"
              onClick={() => setShowAutoReplies((v) => !v)}
              className="text-xs text-[var(--gray-11)] hover:text-[var(--gray-12)] underline-offset-2 hover:underline"
            >
              {showAutoReplies ? `Hide ${autoReplyCount} auto-replies` : `Show ${autoReplyCount} auto-replies`}
            </button>
          )}
          <span className="text-sm text-[var(--gray-9)]">
            {visibleReplies.length} shown
            {!showAutoReplies && autoReplyCount > 0 ? ` · ${autoReplyCount} auto-replies hidden` : ''}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" /></div>
      ) : visibleReplies.length === 0 ? (
        <Card variant="surface" className="p-12 text-center">
          <EnvelopeIcon className="w-10 h-10 text-[var(--gray-8)] mx-auto mb-3" />
          <p className="text-[var(--gray-11)] mb-1">No replies yet</p>
          <p className="text-sm text-[var(--gray-9)]">Replies to this broadcast will appear here</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {visibleReplies.map((reply) => {
            const isExpanded = expandedId === reply.id;
            return (
              <Card key={reply.id} variant="surface" className={`transition-colors ${!reply.is_read ? 'border-l-2 border-l-[var(--accent-9)]' : ''}`}>
                <button onClick={() => toggleExpand(reply)} className="w-full text-left px-4 py-3 flex items-center gap-3">
                  {reply.is_read
                    ? <EnvelopeOpenIcon className="w-4 h-4 text-[var(--gray-9)] flex-shrink-0" />
                    : <EnvelopeIcon className="w-4 h-4 text-[var(--accent-9)] flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm truncate ${!reply.is_read ? 'font-semibold text-[var(--gray-12)]' : 'text-[var(--gray-12)]'}`}>
                        {reply.from_name || reply.from_email}
                      </span>
                      {reply.from_name && <span className="text-xs text-[var(--gray-9)] truncate hidden sm:inline">{reply.from_email}</span>}
                    </div>
                    <p className={`text-sm truncate ${!reply.is_read ? 'font-medium text-[var(--gray-11)]' : 'text-[var(--gray-9)]'}`}>
                      {reply.subject || '(no subject)'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {reply.is_auto_reply && (
                      <Badge variant="soft" color="gray" size="1" className="hidden md:inline-flex" title={reply.auto_reply_reason || undefined}>Auto-reply</Badge>
                    )}
                    {reply.forwarded_at && (
                      <ArrowUturnRightIcon className="w-3.5 h-3.5 text-[var(--gray-9)]" title={`Forwarded to ${reply.forwarded_to}`} />
                    )}
                    <span className="text-xs text-[var(--gray-9)] whitespace-nowrap">{formatTime(reply.created_at)}</span>
                    {isExpanded ? <ChevronUpIcon className="w-4 h-4 text-[var(--gray-9)]" /> : <ChevronDownIcon className="w-4 h-4 text-[var(--gray-9)]" />}
                  </div>
                </button>
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-[var(--gray-a4)]">
                    <div className="pt-3">
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--gray-9)] mb-3">
                        <span>From: {reply.from_name ? `${reply.from_name} <${reply.from_email}>` : reply.from_email}</span>
                        <span>Date: {new Date(reply.created_at).toLocaleString()}</span>
                        {reply.forwarded_at && (
                          <span className="flex items-center gap-1">
                            <ArrowUturnRightIcon className="w-3 h-3" /> Forwarded to {reply.forwarded_to} at {new Date(reply.forwarded_at).toLocaleString()}
                          </span>
                        )}
                      </div>
                      {reply.body_html ? (
                        <div className="prose prose-sm max-w-none text-[var(--gray-12)] [&_a]:text-[var(--accent-9)]" dangerouslySetInnerHTML={{ __html: reply.body_html }} />
                      ) : (
                        <pre className="text-sm text-[var(--gray-12)] whitespace-pre-wrap font-sans">{reply.body_text || '(empty)'}</pre>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
