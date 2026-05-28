// @ts-nocheck
'use client'

import { useState } from 'react'

const REACTIONS = [
  { type: 'thumbsup', emoji: '👍' },
  { type: 'heart', emoji: '❤️' },
  { type: 'laughing', emoji: '😂' },
  { type: 'clapping', emoji: '👏' },
  { type: 'thinking', emoji: '🤔' },
  { type: 'fire', emoji: '🔥' },
]

interface Props {
  messageId: string
  reactionCounts: Record<string, number>
  currentPersonId: string | null
  inline?: boolean  // when true, render as flat emoji row (for tooltip)
}

export default function ReactionBar({ messageId, reactionCounts, currentPersonId, inline = false }: Props) {
  const [toggling, setToggling] = useState(false)

  const handleReaction = async (type: string) => {
    if (!currentPersonId || toggling) return
    setToggling(true)

    try {
      await fetch('/api/live-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'react', message_id: messageId, reaction_type: type }),
      })
    } catch {} finally {
      setToggling(false)
    }
  }

  // Inline mode: just show all emoji as small clickable buttons (for tooltip)
  if (inline) {
    return (
      <div className="flex items-center gap-px">
        {REACTIONS.map(r => (
          <button
            key={r.type}
            onClick={() => handleReaction(r.type)}
            className="text-lg w-8 h-8 flex items-center justify-center rounded transition-all cursor-pointer hover:scale-125 hover:bg-white/10"
          >
            {r.emoji}
          </button>
        ))}
      </div>
    )
  }

  // Default: not used anymore (tooltip handles interaction)
  return null
}
