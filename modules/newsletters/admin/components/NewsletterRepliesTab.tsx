import { useState, useEffect, useCallback } from 'react';
import {
  EnvelopeIcon,
  EnvelopeOpenIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ArrowUturnRightIcon,
} from '@heroicons/react/24/outline';
import { Card, Badge } from '@/components/ui';
import { supabase } from '@/lib/supabase';

interface Reply {
  id: string;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  edition_id: string | null;
  is_read: boolean;
  forwarded_to: string | null;
  forwarded_at: string | null;
  created_at: string;
  edition?: { title: string | null; edition_date: string } | null;
}

interface NewsletterRepliesTabProps {
  newsletterId: string;
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function NewsletterRepliesTab({ newsletterId }: NewsletterRepliesTabProps) {
  const [replies, setReplies] = useState<Reply[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('newsletter_replies')
      .select('*, edition:newsletters_editions(title, edition_date)')
      .eq('collection_id', newsletterId)
      .order('created_at', { ascending: false });
    setReplies(data || []);
    setLoading(false);
  }, [newsletterId]);

  useEffect(() => { load(); }, [load]);

  // Poll for new replies
  useEffect(() => {
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  const toggleExpand = async (reply: Reply) => {
    const isExpanding = expandedId !== reply.id;
    setExpandedId(isExpanding ? reply.id : null);

    // Mark as read when expanded
    if (isExpanding && !reply.is_read) {
      await supabase
        .from('newsletter_replies')
        .update({ is_read: true })
        .eq('id', reply.id);
      setReplies(prev => prev.map(r => r.id === reply.id ? { ...r, is_read: true } : r));
    }
  };

  const unreadCount = replies.filter(r => !r.is_read).length;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--accent-9)]" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold text-[var(--gray-12)]">Replies</h2>
          {unreadCount > 0 && (
            <Badge variant="solid" color="blue" size="1">{unreadCount} new</Badge>
          )}
        </div>
        <span className="text-sm text-[var(--gray-9)]">{replies.length} total</span>
      </div>

      {replies.length === 0 ? (
        <Card variant="surface" className="p-12 text-center">
          <EnvelopeIcon className="w-10 h-10 text-[var(--gray-8)] mx-auto mb-3" />
          <p className="text-[var(--gray-11)] mb-1">No replies yet</p>
          <p className="text-sm text-[var(--gray-9)]">
            Replies to your newsletter sending address will appear here
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {replies.map(reply => {
            const isExpanded = expandedId === reply.id;
            return (
              <Card
                key={reply.id}
                variant="surface"
                className={`transition-colors ${!reply.is_read ? 'border-l-2 border-l-[var(--accent-9)]' : ''}`}
              >
                {/* Reply header — clickable */}
                <button
                  onClick={() => toggleExpand(reply)}
                  className="w-full text-left px-4 py-3 flex items-center gap-3"
                >
                  {reply.is_read ? (
                    <EnvelopeOpenIcon className="w-4 h-4 text-[var(--gray-9)] flex-shrink-0" />
                  ) : (
                    <EnvelopeIcon className="w-4 h-4 text-[var(--accent-9)] flex-shrink-0" />
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm truncate ${!reply.is_read ? 'font-semibold text-[var(--gray-12)]' : 'text-[var(--gray-12)]'}`}>
                        {reply.from_name || reply.from_email}
                      </span>
                      {reply.from_name && (
                        <span className="text-xs text-[var(--gray-9)] truncate hidden sm:inline">
                          {reply.from_email}
                        </span>
                      )}
                    </div>
                    <p className={`text-sm truncate ${!reply.is_read ? 'font-medium text-[var(--gray-11)]' : 'text-[var(--gray-9)]'}`}>
                      {reply.subject || '(no subject)'}
                    </p>
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    {reply.edition && (
                      <Badge variant="soft" color="blue" size="1" className="hidden md:inline-flex">
                        {reply.edition.title || reply.edition.edition_date}
                      </Badge>
                    )}
                    {reply.forwarded_at && (
                      <ArrowUturnRightIcon className="w-3.5 h-3.5 text-[var(--gray-9)]" title={`Forwarded to ${reply.forwarded_to}`} />
                    )}
                    <span className="text-xs text-[var(--gray-9)] whitespace-nowrap">
                      {formatTime(reply.created_at)}
                    </span>
                    {isExpanded ? (
                      <ChevronUpIcon className="w-4 h-4 text-[var(--gray-9)]" />
                    ) : (
                      <ChevronDownIcon className="w-4 h-4 text-[var(--gray-9)]" />
                    )}
                  </div>
                </button>

                {/* Expanded body */}
                {isExpanded && (
                  <div className="px-4 pb-4 border-t border-[var(--gray-a4)]">
                    <div className="pt-3">
                      {/* Metadata */}
                      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-[var(--gray-9)] mb-3">
                        <span>From: {reply.from_name ? `${reply.from_name} <${reply.from_email}>` : reply.from_email}</span>
                        <span>Date: {new Date(reply.created_at).toLocaleString()}</span>
                        {reply.forwarded_at && (
                          <span className="flex items-center gap-1">
                            <ArrowUturnRightIcon className="w-3 h-3" />
                            Forwarded to {reply.forwarded_to} at {new Date(reply.forwarded_at).toLocaleString()}
                          </span>
                        )}
                      </div>

                      {/* Body */}
                      {reply.body_html ? (
                        <div
                          className="prose prose-sm max-w-none text-[var(--gray-12)] [&_a]:text-[var(--accent-9)]"
                          dangerouslySetInnerHTML={{ __html: reply.body_html }}
                        />
                      ) : (
                        <pre className="text-sm text-[var(--gray-12)] whitespace-pre-wrap font-sans">
                          {reply.body_text || '(empty)'}
                        </pre>
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
