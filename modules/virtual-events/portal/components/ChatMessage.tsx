// @ts-nocheck
'use client'

import { useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'

interface ChatMessageType {
  id: string
  person_id: string
  content: string
  is_question: boolean
  is_team_message: boolean
  is_surfaced: boolean
  is_deleted: boolean
  reaction_counts: Record<string, number>
  created_at: string
  person_name?: string
}

interface Props {
  message: ChatMessageType
  currentPersonId: string | null
  primaryColor: string
  isLast?: boolean
  onEdit?: (messageId: string, currentContent: string) => void
  showTooltip?: boolean
  onHover?: (messageId: string | null) => void
}

const EMOJI_MAP: Record<string, string> = {
  thumbsup: '👍', heart: '❤️', laughing: '😂', clapping: '👏', thinking: '🤔', fire: '🔥',
}

function formatRelativeTime(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export default function ChatMessage({ message, currentPersonId, primaryColor, isLast = false, onEdit, showTooltip = false, onHover }: Props) {
  const ReactionBar = require('./ReactionBar').default
  const isOwn = currentPersonId && message.person_id === currentPersonId
  const displayName = message.person_name || 'Anonymous'
  const timeAgo = useMemo(() => formatRelativeTime(message.created_at), [message.created_at])
  const containerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLParagraphElement>(null)

  const activeReactions = Object.entries(message.reaction_counts || {}).filter(([, c]) => c > 0)

  // Compute tooltip position from ref
  const getTooltipStyle = () => {
    const el = textRef.current || containerRef.current
    if (!el) return {}
    const rect = el.getBoundingClientRect()
    return {
      position: 'fixed' as const,
      top: isLast ? rect.top - 40 : rect.bottom,
      left: rect.left,
      zIndex: 9999,
    }
  }

  // Deleted message — shown grayed out for the author only
  if (message.is_deleted) {
    return (
      <div className="px-2 py-1.5 rounded opacity-40">
        <span className="text-[11px] text-gray-400">
          {displayName} <span className="ml-1 opacity-60">{timeAgo}</span>
        </span>
        <p className="text-sm leading-tight line-through text-gray-400">
          {message.content}
        </p>
        <span className="text-[10px] italic text-red-400/60">
          Deleted by moderator
        </span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      className="relative group"
    >
      <div
        className={`px-2 py-1.5 rounded transition-colors cursor-default select-none ${
          message.is_surfaced
            ? 'bg-yellow-500/10 border-l-2 border-yellow-500'
            : message.is_team_message
              ? 'bg-blue-500/10'
              : ''
        }`}
      >
        {message.is_surfaced && (
          <div className="text-[10px] font-medium text-yellow-500">
            ⭐ Featured
          </div>
        )}

        <span className={`text-[11px] ${
          message.is_team_message ? 'text-blue-500' : 'text-gray-400'
        }`}>
          {displayName}
          {message.is_team_message && (
            <span className="ml-2 text-[9px] font-bold uppercase px-1.5 py-px rounded text-white" style={{ backgroundColor: primaryColor }}>
              Team
            </span>
          )}
          <span className="ml-1.5 text-[10px] opacity-60">{timeAgo}</span>
        </span>

        <div className="flex items-start gap-1">
          <p
            ref={textRef}
            className="text-sm leading-tight whitespace-pre-wrap break-words flex-1 text-gray-900"
            onMouseEnter={() => onHover?.(message.id)}
            onMouseLeave={() => onHover?.(null)}
          >
            {message.content}
          </p>
          {isOwn && onEdit && (
            <button
              onClick={() => onEdit(message.id, message.content)}
              className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer mt-0.5 text-gray-400 hover:text-gray-600"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
              </svg>
            </button>
          )}
        </div>

        {(message as any).is_edited && (
          <span className="text-[10px] italic text-gray-400">edited</span>
        )}

        {activeReactions.length > 0 && (
          <div className="flex items-center gap-2 mt-1">
            {activeReactions.map(([type, count]) => (
              <button
                key={type}
                onClick={currentPersonId && !isOwn ? async () => {
                  try {
                    await fetch('/api/live-chat', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'react', message_id: message.id, reaction_type: type }),
                    })
                  } catch {}
                } : undefined}
                className={`inline-flex items-center gap-1 text-sm px-1.5 py-0.5 rounded-full transition-colors ${
                  currentPersonId && !isOwn ? 'cursor-pointer' : 'cursor-default'
                } bg-white/10 hover:bg-white/20`}
              >
                <span>{EMOJI_MAP[type]}</span>
                <span className="text-[10px] tabular-nums text-gray-500">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Reaction tooltip — only one visible at a time, controlled by parent */}
      {showTooltip && !isOwn && typeof document !== 'undefined' && createPortal(
        <div
          className="rounded-lg shadow-lg px-1.5 py-1 bg-white border border-white/10"
          style={getTooltipStyle()}
          onMouseEnter={() => onHover?.(message.id)}
          onMouseLeave={() => onHover?.(null)}
        >
          <ReactionBar
            messageId={message.id}
            reactionCounts={message.reaction_counts || {}}
            currentPersonId={currentPersonId}
            inline
          />
        </div>,
        document.body
      )}
    </div>
  )
}
