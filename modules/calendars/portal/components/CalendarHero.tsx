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
    ? { backgroundImage: `url(${coverUrl})` }
    : {
        background: calendar.color
          ? `linear-gradient(135deg, ${calendar.color}55, ${calendar.color}11)`
          : 'linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
      }

  return (
    <div
      className="relative overflow-hidden rounded-2xl bg-cover bg-center mb-8"
      style={bgStyle}
    >
      <div className="bg-gradient-to-t from-black/80 via-black/40 to-transparent">
        <div className="px-6 sm:px-10 py-12 sm:py-20 min-h-[320px] flex flex-col justify-end">
          <div className="flex items-center gap-4 mb-4">
            {logoUrl && (
              <img
                src={logoUrl}
                alt={calendar.name}
                className="w-16 h-16 rounded-lg object-cover ring-2 ring-white/20"
              />
            )}
            <div className="min-w-0">
              <h1 className="text-3xl sm:text-5xl font-bold text-white drop-shadow-lg">
                {calendar.name}
              </h1>
              {calendar.description && (
                <p className="text-white/80 mt-2 text-sm sm:text-base max-w-2xl line-clamp-3 drop-shadow">
                  {calendar.description}
                </p>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 mt-4">
            <Link
              href={`/calendars/${slug}/join`}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-black text-white text-sm font-semibold rounded-lg hover:bg-black/80 transition-colors"
            >
              Join this calendar
            </Link>
            {typeof memberCount === 'number' && memberCount > 0 && (
              <span className="text-white/70 text-sm">
                {memberCount.toLocaleString()} members
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
