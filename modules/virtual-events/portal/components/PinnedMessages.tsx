// @ts-nocheck
'use client'

import { useState, useEffect, useRef } from 'react'

interface PinnedMessage {
  id: string
  message_id: string
  content: string
  pinned_at: string
}

interface Props {
  eventId: string
  trackId: string
}

export default function PinnedMessages({ eventId, trackId }: Props) {
  const [pinned, setPinned] = useState<PinnedMessage[]>([])
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadPinned = async () => {
    try {
      const res = await fetch('/api/live-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get-pinned', event_id: eventId, track_id: trackId }),
      })
      if (res.ok) {
        const { pinned: data } = await res.json()
        setPinned(data || [])
      }
    } catch {}
  }

  useEffect(() => {
    loadPinned()
    intervalRef.current = setInterval(loadPinned, 30000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [eventId, trackId])

  if (pinned.length === 0) return null

  return (
    <div className="shrink-0 border-b border-gray-200">
      {pinned.map(pin => (
        <div
          key={pin.id}
          className="flex items-start gap-2 px-3 py-2 bg-amber-50 text-sm"
        >
          <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
          </svg>
          <span className="text-gray-600 break-words min-w-0 flex-1">{pin.content}</span>
        </div>
      ))}
    </div>
  )
}
