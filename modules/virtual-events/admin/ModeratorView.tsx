import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { Badge } from '@/components/ui';
import { toast } from 'sonner';
import {
  TrashIcon,
  NoSymbolIcon,
  PaperAirplaneIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { BookmarkIcon } from '@heroicons/react/24/solid';

interface ModeratorViewProps {
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
  person_name?: string;
}

interface BlockedUser {
  id: string;
  person_id: string;
  reason: string | null;
  blocked_at: string;
  person_name?: string;
}

const EMOJI_MAP: Record<string, string> = {
  thumbsup: '👍', heart: '❤️', laughing: '😂', clapping: '👏', thinking: '🤔', fire: '🔥',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// --- Single message row with hover actions ---

function MessageRow({ msg, onPin, onDelete, onUndelete, onBlock }: {
  msg: ChatMessage;
  onPin: () => void;
  onDelete: () => void;
  onUndelete: () => void;
  onBlock: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const isDeleted = msg.is_deleted;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`flex items-start gap-1.5 py-1 px-1.5 rounded transition-colors ${isDeleted ? 'opacity-40' : ''}`}
      style={hovered ? { backgroundColor: 'var(--gray-a3)' } : undefined}
    >
      <div className="flex-1 min-w-0">
        <span className="text-[10px] text-[var(--gray-9)]">
          {msg.person_name}
          {msg.is_team_message && <span className="ml-1 px-1 py-px rounded bg-blue-100 text-blue-700 text-[9px] font-bold">TEAM</span>}
          {msg.is_question && <span className="ml-1 px-1 py-px rounded bg-orange-100 text-orange-700 text-[9px] font-bold">Q</span>}
          {isDeleted && (msg as any).moderation_flags?.auto_moderated
            ? <span className="ml-1 px-1 py-px rounded bg-orange-100 text-orange-700 text-[9px] font-bold">AUTO-BLOCKED</span>
            : isDeleted
              ? <span className="ml-1 px-1 py-px rounded bg-red-100 text-red-700 text-[9px] font-bold">DELETED</span>
              : null
          }
          <span className="ml-1 opacity-60">{formatTime(msg.created_at)}</span>
        </span>
        <p className={`text-[13px] break-words leading-tight ${isDeleted ? 'line-through text-[var(--gray-9)]' : 'text-[var(--gray-12)]'}`}>{msg.content}</p>
        {!isDeleted && Object.entries(msg.reaction_counts || {}).some(([, c]) => c > 0) && (
          <div className="flex gap-1 mt-0.5">
            {Object.entries(msg.reaction_counts).filter(([, c]) => c > 0).map(([type, count]) => (
              <span key={type} className="text-[10px]">{EMOJI_MAP[type]}{count}</span>
            ))}
          </div>
        )}
      </div>
      {hovered && (
        <div className="flex items-center gap-1 shrink-0 mt-0.5">
          {isDeleted ? (
            <button onClick={onUndelete} title="Restore message" className="p-1 rounded cursor-pointer text-green-600" style={{ backgroundColor: 'var(--gray-a3)' }}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
              </svg>
            </button>
          ) : (
            <>
              <button onClick={onPin} title="Pin message" className="p-1 rounded cursor-pointer text-[var(--gray-9)]" style={{ backgroundColor: 'var(--gray-a3)' }}>
                <BookmarkIcon className="w-3.5 h-3.5" />
              </button>
              <button onClick={onDelete} title="Delete message" className="p-1 rounded cursor-pointer text-red-500" style={{ backgroundColor: 'var(--gray-a3)' }}>
                <TrashIcon className="w-3.5 h-3.5" />
              </button>
              <button onClick={onBlock} title="Block user" className="p-1 rounded cursor-pointer text-red-500" style={{ backgroundColor: 'var(--gray-a3)' }}>
                <NoSymbolIcon className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// --- Single track chat column ---

function TrackChatColumn({ track, eventUuid, adminPersonId, chatEnabled, nameCache, lookupNames, getName, onBlock }: {
  track: Track;
  eventUuid: string;
  adminPersonId: string | null;
  chatEnabled: boolean;
  nameCache: React.MutableRefObject<Map<string, string>>;
  lookupNames: (ids: string[]) => Promise<void>;
  getName: (id: string) => string;
  onBlock: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [teamMessage, setTeamMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;

    (async () => {
      setLoading(true);
      const { data } = await supabase
        .from('live_chat_messages')
        .select('*')
        .eq('track_id', track.id)
        .order('created_at', { ascending: true });

      const msgs = (data || []) as ChatMessage[];
      if (!mounted) return;

      const ids = [...new Set(msgs.map(m => m.person_id))];
      await lookupNames(ids);
      setMessages(msgs.map(m => ({ ...m, person_name: getName(m.person_id) })));
      setLoading(false);
      setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }), 50);
    })();

    const channel = supabase
      .channel(`mod-chat:${track.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'live_chat_messages', filter: `track_id=eq.${track.id}` },
        async (payload) => {
          const msg = payload.new as ChatMessage;
          // Moderators see all messages including auto-deleted
          await lookupNames([msg.person_id]);
          msg.person_name = getName(msg.person_id);
          setMessages(prev => prev.some(m => m.id === msg.id) ? prev : [...prev, msg]);
          setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current!.scrollHeight, behavior: 'smooth' }), 50);
        }
      )
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'live_chat_messages', filter: `track_id=eq.${track.id}` },
        (payload) => {
          const updated = payload.new as ChatMessage;
          updated.person_name = getName(updated.person_id);
          // Keep all messages (including deleted) — just update in place
          setMessages(prev =>
            prev.map(m => m.id === updated.id ? { ...updated, person_name: updated.person_name || m.person_name } : m)
          );
        }
      )
      .subscribe();

    // Periodic refresh to catch auto-moderated messages that Realtime might miss
    const refreshInterval = setInterval(async () => {
      const { data } = await supabase
        .from('live_chat_messages')
        .select('*')
        .eq('track_id', track.id)
        .order('created_at', { ascending: true });

      if (data) {
        const msgs = data as ChatMessage[];
        const ids = [...new Set(msgs.map(m => m.person_id))];
        await lookupNames(ids);
        setMessages(msgs.map(m => ({ ...m, person_name: getName(m.person_id) })));
      }
    }, 5000);

    return () => { mounted = false; supabase.removeChannel(channel); clearInterval(refreshInterval); };
  }, [track.id]);

  const handleSend = async () => {
    if (!teamMessage.trim() || !adminPersonId) return;
    setSending(true);
    try {
      const { error } = await supabase.from('live_chat_messages').insert({
        event_id: eventUuid, track_id: track.id, person_id: adminPersonId,
        content: teamMessage.trim(), is_team_message: true,
      });
      if (error) throw error;
      setTeamMessage('');
    } catch { toast.error('Failed to send'); }
    finally { setSending(false); }
  };

  const handleDelete = async (msg: ChatMessage) => {
    const { error } = await supabase.from('live_chat_messages').update({ is_deleted: true, deleted_by: adminPersonId }).eq('id', msg.id);
    if (error) { console.error('[mod] Delete error:', error); toast.error(`Failed to delete: ${error.message}`); }
    else { setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_deleted: true } : m)); toast.success('Deleted'); }
  };

  const handleUndelete = async (msg: ChatMessage) => {
    const { error } = await supabase.from('live_chat_messages').update({ is_deleted: false, deleted_by: null }).eq('id', msg.id);
    if (error) { console.error('[mod] Undelete error:', error); toast.error(`Failed to restore: ${error.message}`); }
    else { setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, is_deleted: false } : m)); toast.success('Message restored'); }
  };

  const handlePin = async (msg: ChatMessage) => {
    if (!adminPersonId) { toast.error('Admin not identified'); return; }
    console.log('[mod] Pinning message:', msg.id);
    const { error } = await supabase.from('live_chat_pinned_messages').insert({ event_id: eventUuid, message_id: msg.id, pinned_by: adminPersonId });
    if (error?.code === '23505') toast.info('Already pinned');
    else if (error) { console.error('[mod] Pin error:', error); toast.error(`Failed to pin: ${error.message}`); }
    else toast.success('Pinned');
  };

  const handleBlock = async (msg: ChatMessage) => {
    if (!adminPersonId) { toast.error('Admin not identified'); return; }
    if (!confirm(`Block ${msg.person_name || 'this user'} from chat? All their messages will be hidden.`)) return;

    const { error } = await supabase.from('live_chat_blocked_users').insert({ event_id: eventUuid, person_id: msg.person_id, blocked_by: adminPersonId });
    if (error?.code === '23505') { toast.info('Already blocked'); return; }
    if (error) { toast.error(`Failed to block: ${error.message}`); return; }

    // Soft-delete all messages from this user in this event
    await supabase.from('live_chat_messages')
      .update({ is_deleted: true, deleted_by: adminPersonId })
      .eq('event_id', eventUuid)
      .eq('person_id', msg.person_id)
      .eq('is_deleted', false);

    // Update local state
    setMessages(prev => prev.map(m =>
      m.person_id === msg.person_id ? { ...m, is_deleted: true } : m
    ));

    toast.success('User blocked and messages hidden');
    onBlock();
  };

  return (
    <div className="flex flex-col min-w-0 flex-1 border border-[var(--gray-6)] rounded-lg overflow-hidden">
      {/* Track header */}
      <div className="px-3 py-2 border-b border-[var(--gray-6)] bg-[var(--gray-2)] text-sm font-medium text-[var(--gray-12)]">
        {track.name}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-2 space-y-0.5">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-[var(--gray-9)] text-sm">Loading...</div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-[var(--gray-9)] text-sm">No messages</div>
        ) : (
          messages.map(msg => (
            <MessageRow
              key={msg.id}
              msg={msg}
              onPin={() => handlePin(msg)}
              onDelete={() => handleDelete(msg)}
              onUndelete={() => handleUndelete(msg)}
              onBlock={() => handleBlock(msg)}
            />
          ))
        )}
      </div>

      {/* Team input */}
      <div className="border-t border-[var(--gray-6)] p-2 flex gap-1.5">
        <input
          value={teamMessage}
          onChange={e => setTeamMessage(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleSend(); } }}
          placeholder={chatEnabled ? 'Team message...' : 'Chat off'}
          disabled={!chatEnabled || sending || !adminPersonId}
          className="flex-1 px-2 py-1.5 text-sm border border-[var(--gray-6)] rounded bg-[var(--color-background)] text-[var(--gray-12)] placeholder-[var(--gray-9)] disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={!teamMessage.trim() || !chatEnabled || sending}
          className="px-2 py-1.5 rounded bg-[var(--accent-9)] text-white disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
        >
          <PaperAirplaneIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

// --- Main moderator view ---

export default function ModeratorView({ eventUuid }: ModeratorViewProps) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUser[]>([]);
  const [chatEnabled, setChatEnabled] = useState(true);
  const [adminPersonId, setAdminPersonId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const nameCache = useRef<Map<string, string>>(new Map());

  const lookupNames = useCallback(async (personIds: string[]) => {
    const unknown = personIds.filter(id => !nameCache.current.has(id));
    if (unknown.length === 0) return;
    const { data } = await supabase.from('people').select('id, email, attributes').in('id', unknown);
    for (const p of data || []) {
      const attrs = (p.attributes || {}) as Record<string, string>;
      nameCache.current.set(p.id, [attrs.first_name, attrs.last_name].filter(Boolean).join(' ') || p.email || p.id.slice(0, 8));
    }
  }, []);

  const getName = useCallback((id: string) => nameCache.current.get(id) || id.slice(0, 8), []);

  // Resolve admin person_id
  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user?.id) {
        const { data } = await supabase.from('people').select('id').eq('auth_user_id', user.id).maybeSingle();
        if (data) setAdminPersonId(data.id);
      }
    })();
  }, []);

  // Load tracks
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('live_event_tracks').select('id, name').eq('event_id', eventUuid).order('sort_order');
      setTracks((data || []) as Track[]);
    })();
  }, [eventUuid]);

  // Load config
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('live_event_config').select('chat_enabled').eq('event_id', eventUuid).maybeSingle();
      if (data) setChatEnabled(data.chat_enabled);
    })();
  }, [eventUuid]);

  // Load blocked users
  const loadBlocked = useCallback(async () => {
    const { data } = await supabase.from('live_chat_blocked_users').select('*').eq('event_id', eventUuid).order('blocked_at', { ascending: false });
    const list = (data || []) as BlockedUser[];
    await lookupNames(list.map(b => b.person_id));
    setBlockedUsers(list.map(b => ({ ...b, person_name: getName(b.person_id) })));
  }, [eventUuid, lookupNames, getName]);

  useEffect(() => { loadBlocked(); }, [loadBlocked]);

  const handleToggleChat = async () => {
    const next = !chatEnabled;
    const { error } = await supabase.from('live_event_config').update({ chat_enabled: next }).eq('event_id', eventUuid);
    if (error) { toast.error('Failed to toggle chat'); return; }
    setChatEnabled(next);
    toast.success(next ? 'Chat enabled' : 'Chat disabled');
  };

  const handleUnblock = async (b: BlockedUser) => {
    const { error } = await supabase.from('live_chat_blocked_users').delete().eq('id', b.id);
    if (error) { toast.error('Failed to unblock'); return; }

    // Restore all messages from this user that were deleted by a moderator
    await supabase.from('live_chat_messages')
      .update({ is_deleted: false, deleted_by: null })
      .eq('event_id', eventUuid)
      .eq('person_id', b.person_id)
      .eq('is_deleted', true);

    toast.success('User unblocked and messages restored');
    loadBlocked();
  };

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleToggleChat}
          className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-md border cursor-pointer transition-colors ${
            chatEnabled ? 'border-green-300 bg-green-50 text-green-700' : 'border-red-300 bg-red-50 text-red-700'
          }`}
        >
          <span className={`w-2 h-2 rounded-full ${chatEnabled ? 'bg-green-500' : 'bg-red-500'}`} />
          Chat {chatEnabled ? 'On' : 'Off'}
        </button>

        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="flex items-center gap-1 px-3 py-1.5 text-sm rounded-md border border-[var(--gray-6)] text-[var(--gray-11)] hover:bg-[var(--gray-3)] cursor-pointer"
        >
          <NoSymbolIcon className="w-4 h-4" />
          Blocked ({blockedUsers.length})
        </button>
      </div>

      <div className="flex gap-3" style={{ height: '500px' }}>
        {/* Track columns */}
        {tracks.map(track => (
          <TrackChatColumn
            key={track.id}
            track={track}
            eventUuid={eventUuid}
            adminPersonId={adminPersonId}
            chatEnabled={chatEnabled}
            nameCache={nameCache}
            lookupNames={lookupNames}
            getName={getName}
            onBlock={loadBlocked}
          />
        ))}

        {tracks.length === 0 && (
          <div className="flex-1 flex items-center justify-center text-[var(--gray-9)] text-sm">
            No tracks configured. Add tracks in the Settings tab.
          </div>
        )}

        {/* Blocked users sidebar */}
        {sidebarOpen && (
          <div className="w-56 shrink-0 flex flex-col border border-[var(--gray-6)] rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--gray-6)] bg-[var(--gray-2)]">
              <span className="text-sm font-medium">Blocked ({blockedUsers.length})</span>
              <button onClick={() => setSidebarOpen(false)} className="cursor-pointer text-[var(--gray-9)]">
                <XMarkIcon className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {blockedUsers.length === 0 ? (
                <p className="text-xs text-[var(--gray-9)] text-center py-4">None</p>
              ) : (
                blockedUsers.map(b => (
                  <div key={b.id} className="flex items-center justify-between py-1 px-2 rounded bg-[var(--gray-a2)]">
                    <div className="min-w-0">
                      <p className="text-xs font-medium truncate">{b.person_name}</p>
                      <p className="text-[10px] text-[var(--gray-9)]">{new Date(b.blocked_at).toLocaleDateString()}</p>
                    </div>
                    <button onClick={() => handleUnblock(b)} className="p-0.5 rounded hover:bg-[var(--gray-a4)] cursor-pointer text-[var(--gray-9)]">
                      <XMarkIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
