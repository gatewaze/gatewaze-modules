// @ts-nocheck — portal deps are resolved at build time via webpack alias
import Link from 'next/link'
import { toPublicUrl } from '@gatewaze/shared'
import type { Calendar } from '../lib/types'

interface Props {
  calendar: Calendar
  /**
   * Optional member count to surface on the right of the CTA. Pages
   * that don't fetch stats can omit this; the panel still renders
   * cleanly without the count.
   */
  memberCount?: number
  /**
   * Storage bucket URL from `brandConfig.storageBucketUrl`, used to resolve
   * the relative `cover_image_url` and `logo_url` paths persisted by the
   * admin upload UI. Pages that omit this fall back to using the stored
   * value verbatim — fine for legacy full-URL rows, broken for new uploads.
   */
  storageBucketUrl?: string
}

export function CalendarHero({ calendar, memberCount, storageBucketUrl }: Props) {
  const slug = calendar.slug || calendar.calendar_id

  // Resolve relative storage paths to full URLs when possible. toPublicUrl
  // is idempotent on already-full URLs, so legacy rows work too.
  const coverUrl = storageBucketUrl
    ? toPublicUrl(calendar.cover_image_url, storageBucketUrl)
    : calendar.cover_image_url
  const logoUrl = storageBucketUrl
    ? toPublicUrl(calendar.logo_url, storageBucketUrl)
    : calendar.logo_url

  const bgStyle = coverUrl
    ? { backgroundImage: `url(${coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : {
        background: calendar.color
          ? `linear-gradient(135deg, ${calendar.color}55, ${calendar.color}11)`
          : 'repeating-linear-gradient(45deg, rgba(var(--ui-text),0.04), rgba(var(--ui-text),0.04) 10px, rgba(var(--ui-text),0.07) 10px, rgba(var(--ui-text),0.07) 20px)',
      }

  // The dark scrim + drop-shadowed white text are intentional and theme-agnostic:
  // they sit over an arbitrary cover photo (which may be light or dark), so this
  // overlay text stays white in both UI modes by design — same pattern the
  // newsletters/events poster heroes use.
  return (
    <div className="cal-hero" style={bgStyle}>
      <style>{`
        .cal-hero { position: relative; overflow: hidden; border-radius: 18px; margin-bottom: 32px; }
        .cal-hero-scrim { background: linear-gradient(to top, rgba(0,0,0,0.82), rgba(0,0,0,0.40) 55%, transparent); }
        .cal-hero-inner { padding: 48px 24px; min-height: 320px; display: flex; flex-direction: column; justify-content: flex-end; }
        @media (min-width: 640px) { .cal-hero-inner { padding: 80px 40px; } }
        .cal-hero-logo { width: 64px; height: 64px; border-radius: 11px; object-fit: cover; box-shadow: 0 0 0 2px rgba(255,255,255,0.2); flex-shrink: 0; }
        .cal-hero-name { font: 600 clamp(30px,4vw,48px) var(--font-display); color: #fff; letter-spacing: -0.02em; margin: 0; text-shadow: 0 2px 12px rgba(0,0,0,0.5); }
        .cal-hero-desc { color: rgba(255,255,255,0.85); margin: 8px 0 0; font-size: 15px; line-height: 1.5; max-width: 42rem;
          display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-shadow: 0 1px 6px rgba(0,0,0,0.5); }
        .cal-hero-members { color: rgba(255,255,255,0.75); font-size: 14px; }
      `}</style>
      <div className="cal-hero-scrim">
        <div className="cal-hero-inner">
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
            {logoUrl && (
              <img src={logoUrl} alt={calendar.name} className="cal-hero-logo" />
            )}
            <div style={{ minWidth: 0 }}>
              <h1 className="cal-hero-name">{calendar.name}</h1>
              {calendar.description && (
                <p className="cal-hero-desc">{calendar.description}</p>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <Link href={`/calendars/${slug}/join`} className="btn btn-primary">
              Join this calendar
            </Link>
            {typeof memberCount === 'number' && memberCount > 0 && (
              <span className="cal-hero-members">
                {memberCount.toLocaleString()} members
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
