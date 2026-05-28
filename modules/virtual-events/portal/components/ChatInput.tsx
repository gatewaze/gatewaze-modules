// @ts-nocheck
'use client'

import { useState, useRef, useEffect } from 'react'

interface Props {
  trackId: string
  eventId: string
  personId: string | null
  isBlocked: boolean
  chatEnabled: boolean
  editingMessage?: { id: string; content: string } | null
  onCancelEdit?: () => void
  onEditComplete?: () => void
  onStartEditLast?: () => void
  onMessageSent?: (result: { id: string; is_deleted: boolean; auto_moderated: boolean; content: string }) => void
}

export default function ChatInput({
  trackId, eventId, personId, isBlocked, chatEnabled,
  editingMessage, onCancelEdit, onEditComplete, onStartEditLast, onMessageSent,
}: Props) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isEditing = !!editingMessage
  const disabled = !chatEnabled || isBlocked || !personId

  // When entering edit mode, populate the textarea
  useEffect(() => {
    if (editingMessage) {
      setMessage(editingMessage.content)
      textareaRef.current?.focus()
    }
  }, [editingMessage])

  const placeholderText = !chatEnabled
    ? 'Chat is currently disabled'
    : isBlocked
      ? 'You have been muted by a moderator'
      : !personId
        ? 'Sign in to chat'
        : 'Type a message...'

  const handleSend = async () => {
    const trimmed = message.trim()
    if (!trimmed || disabled || sending) return

    setSending(true)
    try {
      if (isEditing) {
        // Edit existing message
        await fetch('/api/live-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'edit', message_id: editingMessage.id, content: trimmed }),
        })
        onEditComplete?.()
      } else {
        // Send new message
        const res = await fetch('/api/live-chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'send', event_id: eventId, track_id: trackId, content: trimmed }),
        })
        const result = await res.json()
        if (result.is_deleted) {
          // Message was auto-moderated — notify parent so it can show to the author
          onMessageSent?.({ id: result.id, is_deleted: true, auto_moderated: result.auto_moderated, content: trimmed })
        }
      }
      setMessage('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
    } catch {} finally {
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
    // Up arrow on empty input = edit last own message
    if (e.key === 'ArrowUp' && !message && !isEditing) {
      e.preventDefault()
      onStartEditLast?.()
    }
    // Escape = cancel edit
    if (e.key === 'Escape' && isEditing) {
      e.preventDefault()
      setMessage('')
      onCancelEdit?.()
    }
  }

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setMessage(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 100) + 'px'
  }

  return (
    <div className="p-2">
      {isEditing && (
        <div className="flex items-center justify-between px-2 py-1 mb-1 rounded text-[11px] bg-blue-500/10 text-blue-400">
          <span>Editing message</span>
          <button
            onClick={() => { setMessage(''); onCancelEdit?.() }}
            className="cursor-pointer hover:underline"
          >
            Cancel
          </button>
        </div>
      )}
      <div className="flex items-end gap-1.5">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={placeholderText}
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none px-3 py-1.5 text-sm rounded-lg border border-white/10 bg-white/5 text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-white/20 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !message.trim() || sending}
          className="shrink-0 p-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          style={{ backgroundColor: disabled || !message.trim() ? undefined : '#3b82f6', color: '#fff' }}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </div>
    </div>
  )
}
