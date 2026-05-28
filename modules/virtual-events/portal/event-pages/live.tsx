// @ts-nocheck
'use client'

import { useState, useEffect, useCallback } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

interface Track {
  id: string
  name: string
  stream_status: string
  youtube_video_id: string | null
  is_default: boolean
  sort_order: number
}

interface LiveConfig {
  id: string
  event_id: string
  event_status: 'upcoming' | 'live' | 'ended'
  scheduled_start: string | null
  scheduled_end: string | null
  chat_enabled: boolean
  replay_video_id: string | null
}

interface Props {
  eventIdentifier: string
  primaryColor: string
  brandName: string
  currentPersonId?: string | null
}

export default function LiveEventPage({ eventIdentifier, primaryColor, brandName, currentPersonId }: Props) {
  const [config, setConfig] = useState<LiveConfig | null>(null)
  const [tracks, setTracks] = useState<Track[]>([])
  const [activeTrackId, setActiveTrackId] = useState<string | null>(null)
  const [resolvedEventUuid, setResolvedEventUuid] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    try {
      // Resolve event identifier (slug or event_id text code) to UUID
      let eventUuid: string | null = null
      const { data: ev1 } = await supabase
        .from('events')
        .select('id')
        .eq('event_slug', eventIdentifier)
        .maybeSingle()
      eventUuid = ev1?.id || null
      if (!eventUuid) {
        const { data: ev2 } = await supabase
          .from('events')
          .select('id')
          .eq('event_id', eventIdentifier)
          .maybeSingle()
        eventUuid = ev2?.id || null
      }

      if (!eventUuid) {
        setError('Event not found.')
        setLoading(false)
        return
      }

      setResolvedEventUuid(eventUuid)

      const { data: configData, error: configError } = await supabase
        .from('live_event_config')
        .select('*')
        .eq('event_id', eventUuid)
        .single()

      if (configError) {
        setError('Live event not configured. Ask the event admin to set up virtual event settings.')
        setLoading(false)
        return
      }

      setConfig(configData)

      const { data: trackData } = await supabase
        .from('live_event_tracks')
        .select('*')
        .eq('event_id', eventUuid)
        .order('sort_order', { ascending: true })

      const loadedTracks = trackData || []
      setTracks(loadedTracks)

      if (loadedTracks.length > 0 && !activeTrackId) {
        const defaultTrack = loadedTracks.find((t: Track) => t.is_default) || loadedTracks[0]
        setActiveTrackId(defaultTrack.id)
      }
    } catch {
      setError('Failed to load event data.')
    } finally {
      setLoading(false)
    }
  }, [eventIdentifier, activeTrackId])

  // Log viewer join/leave
  useEffect(() => {
    if (!resolvedEventUuid || !currentPersonId) return
    fetch('/api/live-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'log-viewer', event_id: resolvedEventUuid, viewer_action: 'join' }),
    }).catch(() => {})

    const handleLeave = () => {
      navigator.sendBeacon?.('/api/live-chat', JSON.stringify({ action: 'log-viewer', event_id: resolvedEventUuid, viewer_action: 'leave' }))
    }
    window.addEventListener('beforeunload', handleLeave)
    return () => {
      window.removeEventListener('beforeunload', handleLeave)
      fetch('/api/live-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'log-viewer', event_id: resolvedEventUuid, viewer_action: 'leave' }),
      }).catch(() => {})
    }
  }, [resolvedEventUuid, currentPersonId])

  useEffect(() => {
    loadData()
  }, [loadData])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-4 border-white/10 rounded-full animate-spin" style={{ borderTopColor: primaryColor }} />
      </div>
    )
  }

  if (error || !config) {
    return (
      <div className="py-12 text-center">
        <p className="text-gray-500">{error || 'Live event not configured.'}</p>
      </div>
    )
  }

  const activeTrack = tracks.find(t => t.id === activeTrackId) || tracks[0]

  if (config.event_status === 'upcoming') {
    const CountdownTimer = require('../components/CountdownTimer').default
    return (
      <div className="py-12">
        <h2 className="text-2xl font-bold text-center text-gray-900 mb-8">Event Starting Soon</h2>
        {config.scheduled_start ? (
          <CountdownTimer targetDate={config.scheduled_start} primaryColor={primaryColor} />
        ) : (
          <p className="text-center text-gray-500">The event will begin shortly. Please check back soon.</p>
        )}
      </div>
    )
  }

  if (config.event_status === 'ended') {
    if (config.replay_video_id) {
      const YouTubePlayer = require('../components/YouTubePlayer').default
      return (
        <div className="py-8 space-y-4">
          <h2 className="text-2xl font-bold text-center text-gray-900">Event Replay</h2>
          <div className="max-w-4xl mx-auto">
            <YouTubePlayer videoId={config.replay_video_id} status="ended" />
          </div>
        </div>
      )
    }

    return (
      <div className="py-12 text-center">
        <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4 bg-gray-100">
          <svg className="w-8 h-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Event Has Ended</h2>
        <p className="text-gray-500">Thank you for joining us.</p>
      </div>
    )
  }

  // Live state
  const YouTubePlayer = require('../components/YouTubePlayer').default
  const ChatFeed = require('../components/ChatFeed').default
  const TrackSwitcher = require('../components/TrackSwitcher').default

  return (
    <div className="space-y-4">
      {tracks.length > 1 && (
        <TrackSwitcher
          tracks={tracks}
          activeTrackId={activeTrackId || ''}
          onTrackChange={setActiveTrackId}
          primaryColor={primaryColor}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        <div>
          <YouTubePlayer
            videoId={activeTrack?.youtube_video_id || null}
            status={config.event_status}
          />
        </div>
        <div className="h-[500px] lg:h-auto">
          {activeTrack && (
            <ChatFeed
              trackId={activeTrack.id}
              eventId={resolvedEventUuid || ''}
              primaryColor={primaryColor}
              currentPersonId={currentPersonId || null}
            />
          )}
        </div>
      </div>
    </div>
  )
}
