import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, Badge, Button } from '@/components/ui';
import { Select } from '@/components/ui';
import { toast } from 'sonner';
import {
  HandRaisedIcon,
  ArrowTopRightOnSquareIcon,
  ChatBubbleLeftIcon,
} from '@heroicons/react/24/outline';
import { CheckCircleIcon } from '@heroicons/react/24/solid';
import LoadingSpinner from '@/components/shared/LoadingSpinner';

interface PresenterViewProps {
  eventUuid: string;
}

interface Track {
  id: string;
  name: string;
}

interface ChatMessage {
  id: string;
  track_id: string;
  person_id: string;
  content: string;
  is_question: boolean;
  is_team_message: boolean;
  is_surfaced: boolean;
  is_deleted: boolean;
  reaction_counts: Record<string, number>;
  created_at: string;
}

function totalReactions(counts: Record<string, number>): number {
  return Object.values(counts || {}).reduce((sum, v) => sum + v, 0);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function PresenterView({ eventUuid }: PresenterViewProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);

  const isPopout = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('popout');
  const recentFeedRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Load tracks
  useEffect(() => {
    async function loadTracks() {
      const { data, error } = await supabase
        .from('live_event_tracks')
        .select('id, name')
        .eq('event_id', eventUuid)
        .order('sort_order', { ascending: true });

      if (error) {
        toast.error('Failed to load tracks');
        return;
      }

      const trackList = (data as Track[]) || [];
      setTracks(trackList);
      if (trackList.length > 0) {
        setSelectedTrackId(trackList[0].id);
      }
    }
    loadTracks();
  }, [eventUuid]);

  // Load messages and subscribe to realtime
  useEffect(() => {
    if (!selectedTrackId) return;

    let isMounted = true;

    async function loadMessages() {
      setLoading(true);
      const { data, error } = await supabase
        .from('live_chat_messages')
        .select('*')
        .eq('track_id', selectedTrackId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: true });

      if (error) {
        toast.error('Failed to load messages');
        setLoading(false);
        return;
      }

      if (isMounted) {
        setMessages((data as ChatMessage[]) || []);
        setLoading(false);
      }
    }

    loadMessages();

    const channel = supabase
      .channel(`presenter-chat:${selectedTrackId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'live_chat_messages',
          filter: `track_id=eq.${selectedTrackId}`,
        },
        (payload) => {
          const newMsg = payload.new as ChatMessage;
          if (!newMsg.is_deleted) {
            setMessages(prev => [...prev, newMsg]);
          }
        }
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      isMounted = false;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
    };
  }, [selectedTrackId]);

  // Auto-scroll recent activity
  useEffect(() => {
    recentFeedRef.current?.scrollTo({
      top: recentFeedRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  // Derived data
  const questions = useMemo(() => {
    return messages
      .filter(m => m.is_question)
      .sort((a, b) => totalReactions(b.reaction_counts) - totalReactions(a.reaction_counts));
  }, [messages]);

  const recentMessages = useMemo(() => {
    return messages.slice(-10);
  }, [messages]);

  // Actions
  const handleSurface = async (message: ChatMessage) => {
    try {
      const { error } = await supabase
        .from('live_chat_messages')
        .update({ is_surfaced: true })
        .eq('id', message.id);

      if (error) throw error;
      setMessages(prev =>
        prev.map(m => m.id === message.id ? { ...m, is_surfaced: true } : m)
      );
    } catch (err) {
      console.error('Failed to surface question:', err);
      toast.error('Failed to surface question');
    }
  };

  const handlePopout = () => {
    const url = new URL(window.location.href);
    url.searchParams.set('popout', 'true');
    window.open(url.toString(), '_blank', 'width=600,height=800');
  };

  const trackOptions = tracks.map(t => ({ label: t.name, value: t.id }));

  const content = (
    <div className={`flex flex-col h-full ${isPopout ? 'p-4' : ''}`} style={{ fontSize: '18px' }}>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex-1 min-w-[200px] max-w-xs">
          <Select
            label="Track"
            data={trackOptions}
            value={selectedTrackId}
            onChange={(e) => setSelectedTrackId(e.target.value)}
          />
        </div>

        {!isPopout && (
          <Button variant="ghost" size="sm" onClick={handlePopout} title="Pop out to separate window">
            <ArrowTopRightOnSquareIcon className="w-5 h-5" />
            <span className="ml-1">Pop out</span>
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-3 gap-4 min-h-0 overflow-hidden">
          {/* Question Queue - 2/3 width */}
          <div className="lg:col-span-2 flex flex-col min-h-0">
            <div className="flex items-center gap-2 mb-3">
              <HandRaisedIcon className="w-5 h-5 text-[var(--accent-9)]" />
              <h3 className="font-semibold" style={{ fontSize: '20px' }}>
                Question Queue ({questions.length})
              </h3>
            </div>

            <div className="flex-1 overflow-y-auto space-y-3 pr-1">
              {questions.length === 0 ? (
                <Card>
                  <div className="p-8 text-center text-[var(--gray-11)]">
                    <p style={{ fontSize: '18px' }}>No questions yet. Questions are detected automatically when a message ends with "?".</p>
                  </div>
                </Card>
              ) : (
                questions.map((q) => (
                  <Card key={q.id} className={q.is_surfaced ? 'border-l-4 border-l-green-500' : ''}>
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <p
                            className="text-[var(--gray-12)] font-medium leading-relaxed"
                            style={{ fontSize: '20px' }}
                          >
                            {q.content}
                          </p>
                          <div className="flex items-center gap-2 mt-2">
                            <span className="text-sm text-[var(--gray-11)]">
                              {q.person_id.slice(0, 8)}
                            </span>
                            <span className="text-sm text-[var(--gray-10)]">
                              {formatTime(q.created_at)}
                            </span>
                            {totalReactions(q.reaction_counts) > 0 && (
                              <Badge color="orange" size="1">
                                {totalReactions(q.reaction_counts)} reactions
                              </Badge>
                            )}
                          </div>
                        </div>

                        <div className="shrink-0">
                          {q.is_surfaced ? (
                            <div className="flex items-center gap-1 text-green-600">
                              <CheckCircleIcon className="w-6 h-6" />
                              <span className="text-sm font-medium">Surfaced</span>
                            </div>
                          ) : (
                            <Button
                              color="primary"
                              size="sm"
                              onClick={() => handleSurface(q)}
                            >
                              Surface
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  </Card>
                ))
              )}
            </div>
          </div>

          {/* Recent Activity - 1/3 width */}
          <div className="flex flex-col min-h-0">
            <div className="flex items-center gap-2 mb-3">
              <ChatBubbleLeftIcon className="w-5 h-5 text-[var(--gray-11)]" />
              <h3 className="font-semibold text-base">Recent Activity</h3>
            </div>

            <Card className="flex-1 overflow-hidden">
              <div ref={recentFeedRef} className="h-full overflow-y-auto p-3 space-y-2">
                {recentMessages.length === 0 ? (
                  <p className="text-sm text-[var(--gray-11)] text-center py-4">No recent messages</p>
                ) : (
                  recentMessages.map((msg) => (
                    <div key={msg.id} className="py-1.5 border-b border-[var(--gray-a3)] last:border-0">
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-xs font-medium text-[var(--gray-11)] truncate max-w-[100px]">
                          {msg.person_id.slice(0, 8)}
                        </span>
                        {msg.is_team_message && (
                          <Badge color="blue" size="1">Team</Badge>
                        )}
                        {msg.is_question && (
                          <Badge color="orange" size="1">Q</Badge>
                        )}
                        <span className="text-[10px] text-[var(--gray-9)]">
                          {formatTime(msg.created_at)}
                        </span>
                      </div>
                      <p className="text-sm text-[var(--gray-12)] break-words">{msg.content}</p>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );

  // In popout mode, render fullscreen without admin chrome
  if (isPopout) {
    return (
      <div
        className="fixed inset-0 bg-white dark:bg-[var(--gray-1)] text-[var(--gray-12)]"
        style={{ fontSize: '18px' }}
      >
        {content}
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-200px)] min-h-[500px]">
      {content}
    </div>
  );
}
