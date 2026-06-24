// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import type { CalendarMediaItem } from '../lib/types'

interface Props {
  items: CalendarMediaItem[]
  showTitle?: boolean
  calendarSlug?: string
}

export function CalendarMediaGallery({ items, showTitle = true, calendarSlug }: Props) {
  if (items.length === 0) return null

  return (
    <section className="cal-media" style={{ marginBottom: 32 }}>
      <style>{`
        .cal-media-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
        @media (min-width: 640px) { .cal-media-grid { grid-template-columns: repeat(3, 1fr); } }
        @media (min-width: 1024px) { .cal-media-grid { grid-template-columns: repeat(4, 1fr); } }
        .cal-media-tile { position: relative; aspect-ratio: 1; border-radius: 12px; overflow: hidden;
          background: rgba(var(--ui-text), 0.05); border: 1px solid rgba(var(--ui-text), 0.10); }
        .cal-media-tile img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .cal-media-play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); transition: background .2s ease; }
        .cal-media-tile:hover .cal-media-play { background: rgba(0,0,0,0.4); }
        .cal-media-play span { width: 48px; height: 48px; border-radius: 50%; background: rgba(255,255,255,0.92); display: flex; align-items: center; justify-content: center; }
        .cal-media-cap { position: absolute; inset: auto 0 0 0; padding: 8px; background: linear-gradient(to top, rgba(0,0,0,0.8), transparent);
          color: rgba(255,255,255,0.92); font-size: 12px; opacity: 0; transition: opacity .2s ease; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cal-media-tile:hover .cal-media-cap { opacity: 1; }
      `}</style>
      {showTitle && (
        <div className="pub-sechead" style={{ marginBottom: 14 }}>
          <h2 style={{ font: '600 22px var(--font-display)', color: 'var(--ink)', letterSpacing: '-0.01em', margin: 0 }}>
            Media highlights
          </h2>
          {calendarSlug && (
            <Link href={`/calendars/${calendarSlug}/media`} className="pub-viewall">
              See all →
            </Link>
          )}
        </div>
      )}
      <div className="cal-media-grid">
        {items.map((item) => (
          <div key={item.id} className="cal-media-tile">
            <img
              src={item.thumbnail_url || item.url}
              alt={item.caption || item.event_title}
              loading="lazy"
            />
            {item.type === 'video' && (
              <div className="cal-media-play">
                <span>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="#000" style={{ marginLeft: 3 }}>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </span>
              </div>
            )}
            <div className="cal-media-cap">{item.event_title}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
