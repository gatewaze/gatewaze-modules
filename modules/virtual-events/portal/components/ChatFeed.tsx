// @ts-nocheck
'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface ChatMessageType {
  id: string
  event_id: string
  track_id: string
  person_id: string
  content: string
  is_question: boolean
  is_team_message: boolean
  is_surfaced: boolean
  is_deleted: boolean
  reaction_counts: Record<string, number>
  created_at: string
  reply_to_id: string | null
  person_name?: string
}

interface Props {
  trackId: string
  eventId: string
  primaryColor: string
  currentPersonId?: string | null
}

export default function ChatFeed({ trackId, eventId, primaryColor, currentPersonId = null }: Props) {
  const [messages, setMessages] = useState<ChatMessageType[]>([])
  const [activeTab, setActiveTab] = useState<'chat' | 'questions'>('chat')
  const [autoScroll, setAutoScroll] = useState(true)
  const [hasNewMessages, setHasNewMessages] = useState(false)
  const [loading, setLoading] = useState(true)
  const [editingMessage, setEditingMessage] = useState<{ id: string; content: string } | null>(null)
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null)
  const [isBlocked, setIsBlocked] = useState(false)
  const [showBlockedNotice, setShowBlockedNotice] = useState(false)
  const hoverHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMessageHover = useCallback((id: string | null) => {
    if (hoverHideTimer.current) { clearTimeout(hoverHideTimer.current); hoverHideTimer.current = null }
    if (id) {
      setHoveredMessageId(id)
    } else {
      // Delay hiding so mouse can move to the tooltip
      hoverHideTimer.current = setTimeout(() => setHoveredMessageId(null), 300)
    }
  }, [])
  const scrollRef = useRef<HTMLDivElement>(null)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)
  const nameCache = useRef<Map<string, string>>(new Map())

  // Check if user is blocked — poll via API every 3 seconds for real-time detection
  useEffect(() => {
    if (!currentPersonId || !eventId) return
    let wasBlocked = false

    const checkBlocked = async () => {
      try {
        // Get current message IDs to check for deletions
        let knownIds: string[] = []
        setMessages(prev => { knownIds = prev.map(m => m.id); return prev })

        const res = await fetch('/api/live-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'check-blocked', event_id: eventId, known_message_ids: knownIds }),
        })
        const { blocked, deleted_message_ids } = await res.json()

        // Handle blocked status
        if (blocked && !wasBlocked) {
          setIsBlocked(true)
          setShowBlockedNotice(true)
          setTimeout(() => setShowBlockedNotice(false), 10000)
          wasBlocked = true
        } else if (!blocked && wasBlocked) {
          // Just got unblocked — reload all messages to pick up restorations
          setIsBlocked(false)
          wasBlocked = false
          reloadMessages()
        } else if (blocked) {
          setIsBlocked(true)
          wasBlocked = true
        }

        // Mark newly deleted messages only — don't restore here
        // (restoration is handled by the Realtime UPDATE subscription)
        if (deleted_message_ids?.length > 0) {
          const deletedSet = new Set(deleted_message_ids as string[])
          setMessages(prev => prev.map(m => {
            if (deletedSet.has(m.id) && !m.is_deleted) {
              return { ...m, is_deleted: true }
            }
            return m
          }))
        }
      } catch {}
    }

    checkBlocked()
    const interval = setInterval(checkBlocked, 3000)
    return () => clearInterval(interval)
  }, [currentPersonId, eventId])

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [])

  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return
    const { scrollTop, clientHeight, scrollHeight } = scrollRef.current
    const isNearBottom = scrollTop + clientHeight >= scrollHeight - 50
    setAutoScroll(isNearBottom)
    if (isNearBottom) setHasNewMessages(false)
  }, [])

  // Reusable message loader
  const reloadMessages = useCallback(async () => {
    const { data } = await supabase
      .from('live_chat_messages')
      .select('*')
      .eq('track_id', trackId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: true })
      .limit(200)

    if (data) {
      const uniquePersonIds = [...new Set(data.map((m: any) => m.person_id))]
      if (uniquePersonIds.length > 0) {
        try {
          const res = await fetch('/api/live-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'lookup-names', person_ids: uniquePersonIds }),
          })
          const { names } = await res.json()
          if (names) {
            for (const [id, name] of Object.entries(names)) {
              nameCache.current.set(id, name as string)
            }
          }
        } catch {}
      }

      setMessages(data.map((msg: any) => ({
        ...msg,
        person_name: nameCache.current.get(msg.person_id) || 'Anonymous',
      })))
      setTimeout(scrollToBottom, 50)
    }
  }, [trackId, scrollToBottom])

  // Load initial messages
  useEffect(() => {
    setLoading(true)
    reloadMessages().then(() => setLoading(false))
  }, [reloadMessages])

  // Lightweight periodic sync: merges any messages from the server that aren't in local state.
  // This is needed because the INSERT realtime handler skips auto-deleted messages for non-authors,
  // so when a moderator later restores such a message, the UPDATE event (which only maps over existing
  // state) can't bring it back. Same applies to messages that were deleted then restored.
  useEffect(() => {
    const syncMessages = async () => {
      const { data } = await supabase
        .from('live_chat_messages')
        .select('*')
        .eq('track_id', trackId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: true })
        .limit(200)

      if (!data) return

      // Look up any missing names before merging into state
      const missingIds = [...new Set(
        data.filter((m: any) => !nameCache.current.has(m.person_id)).map((m: any) => m.person_id)
      )] as string[]
      if (missingIds.length > 0) {
        try {
          const res = await fetch('/api/live-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'lookup-names', person_ids: missingIds }),
          })
          const { names } = await res.json()
          if (names) {
            for (const [id, name] of Object.entries(names)) {
              nameCache.current.set(id, name as string)
            }
          }
        } catch {}
      }

      setMessages(prev => {
        const prevById = new Map(prev.map(m => [m.id, m]))
        const serverIds = new Set<string>(data.map((m: any) => m.id))

        // Start from the server's non-deleted set (authoritative for visible chat)
        const merged: ChatMessageType[] = data.map((m: any) => ({
          ...m,
          person_name: prevById.get(m.id)?.person_name || nameCache.current.get(m.person_id) || 'Anonymous',
        }))

        // Preserve locally-visible deleted messages authored by the current user
        // (their own auto-moderated messages, which the server query filters out)
        for (const m of prev) {
          if (!serverIds.has(m.id) && m.is_deleted && m.person_id === currentPersonId) {
            merged.push(m)
          }
        }

        merged.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

        // Bail out if nothing changed to avoid unnecessary re-renders
        if (merged.length === prev.length) {
          let same = true
          for (let i = 0; i < merged.length; i++) {
            if (merged[i].id !== prev[i].id || merged[i].is_deleted !== prev[i].is_deleted) {
              same = false
              break
            }
          }
          if (same) return prev
        }
        return merged
      })
    }

    const interval = setInterval(syncMessages, 10000)
    return () => clearInterval(interval)
  }, [trackId, currentPersonId])

  // Subscribe to Realtime
  useEffect(() => {
    const channel = supabase
      .channel(`chat:${trackId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'live_chat_messages',
          filter: `track_id=eq.${trackId}`,
        },
        async (payload) => {
          const newMsg = payload.new as ChatMessageType
          // Skip deleted messages unless it's the current user's own message
          if (newMsg.is_deleted && newMsg.person_id !== currentPersonId) return

          // Look up person name from cache or API
          if (!nameCache.current.has(newMsg.person_id)) {
            try {
              const res = await fetch('/api/live-chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'lookup-names', person_ids: [newMsg.person_id] }),
              })
              const { names } = await res.json()
              if (names?.[newMsg.person_id]) {
                nameCache.current.set(newMsg.person_id, names[newMsg.person_id])
              }
            } catch {}
          }
          newMsg.person_name = nameCache.current.get(newMsg.person_id) || 'Anonymous'

          setMessages(prev => {
            if (prev.some(m => m.id === newMsg.id)) return prev
            return [...prev, newMsg]
          })

          if (autoScroll) {
            setTimeout(scrollToBottom, 50)
          } else {
            setHasNewMessages(true)
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'live_chat_messages',
          filter: `track_id=eq.${trackId}`,
        },
        (payload) => {
          const updated = payload.new as ChatMessageType
          // Preserve person_name from cache or existing message
          updated.person_name = nameCache.current.get(updated.person_id) || undefined
          setMessages(prev =>
            updated.is_deleted
              ? prev.filter(m => m.id !== updated.id)
              : prev.map(m => m.id === updated.id ? { ...updated, person_name: updated.person_name || m.person_name } : m)
          )
        }
      )
      .subscribe()

    channelRef.current = channel

    return () => {
      supabase.removeChannel(channel)
    }
  }, [trackId, autoScroll, scrollToBottom])

  // Filter messages: hide deleted for non-authors, keep for author (shown grayed out)
  const filteredMessages = (activeTab === 'questions'
    ? messages.filter(m => m.is_question)
    : messages
  ).filter(m => !m.is_deleted || m.person_id === currentPersonId)

  const ChatMessage = require('./ChatMessage').default
  const ChatInput = require('./ChatInput').default
  const PinnedMessages = require('./PinnedMessages').default

  return (
    <div className="flex flex-col h-full rounded-lg border border-white/10 bg-white/10 text-gray-900 overflow-hidden backdrop-blur-md relative">
      {/* Blocked overlay */}
      {isBlocked && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/60 backdrop-blur-sm rounded-lg">
          <div className="text-center px-6">
            <div className="w-12 h-12 rounded-full bg-red-500/20 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              </svg>
            </div>
            <p className="text-white font-medium mb-1">You have been muted</p>
            <p className="text-gray-400 text-sm">A moderator has muted you from this chat. You can still watch the stream.</p>
          </div>
        </div>
      )}

      {/* Blocked notification toast */}
      {showBlockedNotice && (
        <div className="absolute top-2 left-2 right-2 z-50 bg-red-500 text-white text-sm font-medium px-4 py-3 rounded-lg shadow-lg flex items-center justify-between animate-in fade-in slide-in-from-top-2">
          <span>You have been muted by a moderator</span>
          <button onClick={() => setShowBlockedNotice(false)} className="ml-2 cursor-pointer opacity-80 hover:opacity-100">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b shrink-0 border-white/10">
        {(['chat', 'questions'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className="flex-1 px-4 py-2.5 text-sm font-medium transition-colors cursor-pointer capitalize"
            style={activeTab === tab
              ? { color: primaryColor, borderBottom: `2px solid ${primaryColor}` }
              : undefined
            }
          >
            <span className={activeTab !== tab ? 'text-gray-500' : ''}>
              {tab === 'chat' ? 'Chat' : 'Questions'}
            </span>
          </button>
        ))}
      </div>

      {/* Pinned messages */}
      <PinnedMessages eventId={eventId} trackId={trackId} />

      {/* Messages area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0"
      >
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="w-6 h-6 border-2 border-gray-300 rounded-full animate-spin" style={{ borderTopColor: primaryColor }} />
          </div>
        ) : filteredMessages.length === 0 ? (
          <div className="text-center py-8 text-sm text-gray-400">
            {activeTab === 'questions' ? 'No questions yet' : 'No messages yet. Be the first to say hello!'}
          </div>
        ) : (
          filteredMessages.map((msg, idx) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              currentPersonId={currentPersonId}
              primaryColor={primaryColor}
              isLast={idx === filteredMessages.length - 1}
              onEdit={(id, content) => setEditingMessage({ id, content })}
              showTooltip={hoveredMessageId === msg.id}
              onHover={handleMessageHover}
            />
          ))
        )}
      </div>

      {/* New messages indicator */}
      {hasNewMessages && (
        <div className="shrink-0 px-3 pb-1">
          <button
            onClick={() => {
              scrollToBottom()
              setAutoScroll(true)
              setHasNewMessages(false)
            }}
            className="w-full py-1.5 text-xs font-medium rounded-md cursor-pointer text-white"
            style={{ backgroundColor: primaryColor }}
          >
            New messages ↓
          </button>
        </div>
      )}

      {/* Chat input */}
      <div className="shrink-0 border-t border-white/10">
        <ChatInput
          trackId={trackId}
          eventId={eventId}
          personId={currentPersonId}
          isBlocked={isBlocked}
          chatEnabled={!isBlocked}
          editingMessage={editingMessage}
          onCancelEdit={() => setEditingMessage(null)}
          onEditComplete={() => setEditingMessage(null)}
          messages={messages}
          onStartEditLast={() => {
            const lastOwn = [...messages].reverse().find(m => m.person_id === currentPersonId)
            if (lastOwn) setEditingMessage({ id: lastOwn.id, content: lastOwn.content })
          }}
          onMessageSent={(result) => {
            // Auto-moderated message — add to local state so author sees it as deleted
            if (result.is_deleted && currentPersonId) {
              const authorName = nameCache.current.get(currentPersonId) || 'You'
              setMessages(prev => [...prev, {
                id: result.id,
                event_id: eventId,
                track_id: trackId,
                person_id: currentPersonId,
                content: result.content,
                is_question: false,
                is_team_message: false,
                is_surfaced: false,
                is_deleted: true,
                reaction_counts: {},
                created_at: new Date().toISOString(),
                reply_to_id: null,
                person_name: authorName,
              }])
            }
          }}
        />
      </div>
    </div>
  )
}
