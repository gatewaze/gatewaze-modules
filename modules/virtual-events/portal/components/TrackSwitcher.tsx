// @ts-nocheck
'use client'

interface Track {
  id: string
  name: string
  stream_status: string
}

interface Props {
  tracks: Track[]
  activeTrackId: string
  onTrackChange: (trackId: string) => void
  primaryColor: string
}

export default function TrackSwitcher({ tracks, activeTrackId, onTrackChange, primaryColor }: Props) {
  if (tracks.length <= 1) return null

  return (
    <div className="flex gap-1 bg-gray-100 rounded-lg p-1 overflow-x-auto">
      {tracks.map(track => {
        const isActive = track.id === activeTrackId
        return (
          <button
            key={track.id}
            onClick={() => onTrackChange(track.id)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md whitespace-nowrap transition-colors cursor-pointer"
            style={isActive ? { backgroundColor: primaryColor, color: '#fff' } : undefined}
          >
            {track.stream_status === 'live' && (
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            )}
            <span className={isActive ? '' : 'text-gray-600'}>{track.name}</span>
          </button>
        )
      })}
    </div>
  )
}
