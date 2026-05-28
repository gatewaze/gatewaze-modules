// @ts-nocheck
'use client'

interface Props {
  videoId: string | null
  status: string
}

export default function YouTubePlayer({ videoId, status }: Props) {
  if (!videoId || status === 'upcoming') {
    return (
      <div className="w-full aspect-video rounded-lg bg-gray-900 flex flex-col items-center justify-center">
        <svg className="w-16 h-16 text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <p className="text-gray-400 text-lg font-medium">
          {status === 'upcoming' ? 'Stream starting soon...' : 'No stream available'}
        </p>
        {status === 'upcoming' && (
          <p className="text-gray-500 text-sm mt-1">Please wait for the event to begin</p>
        )}
      </div>
    )
  }

  return (
    <div className="w-full aspect-video rounded-lg overflow-hidden bg-black">
      <iframe
        src={`https://www.youtube.com/embed/${videoId}?autoplay=1&modestbranding=1&rel=0`}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="w-full h-full"
        title="Live stream"
      />
    </div>
  )
}
