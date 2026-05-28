// @ts-nocheck — portal deps are resolved at build time via webpack alias
'use client'

import { useEffect, useRef, useState } from 'react'

interface Props {
  /**
   * The path to the ICS feed for this calendar — typically
   *   `/api/calendars/{slug}/feed.ics`
   * The component computes absolute http:// and webcal:// variants from
   * the current window.location, so server-side render works without env.
   */
  feedPath: string
  calendarName: string
}

/**
 * Subscribe-to-Calendar button. Opens a small popover with the live
 * subscription URL (webcal:// for Apple/Outlook, https:// for Google) and
 * a one-click copy. We deliberately avoid third-party "Add to Google
 * Calendar" deep links: those add the events as one-off entries instead of
 * a live-subscribed feed, which defeats the whole point.
 */
export function CalendarSubscribeButton({ feedPath, calendarName }: Props) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<'webcal' | 'https' | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Compute the URLs once we're on the client.
  const [urls, setUrls] = useState<{ webcal: string; https: string; google: string } | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const origin = window.location.origin
    const httpsUrl = `${origin}${feedPath}`
    const webcalUrl = httpsUrl.replace(/^https?:\/\//, 'webcal://')
    const googleUrl = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(httpsUrl)}`
    setUrls({ webcal: webcalUrl, https: httpsUrl, google: googleUrl })
  }, [feedPath])

  // Click-outside / Esc to close.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function copy(value: string, kind: 'webcal' | 'https') {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // Clipboard API may be blocked — fall back to a manual select prompt.
      window.prompt(`Copy this URL and paste it into your calendar app:`, value)
    }
  }

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-white/15 backdrop-blur text-white text-sm font-semibold rounded-lg hover:bg-white/25 transition-colors"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 00-7-7m7 14a7 7 0 01-7 7M5 5a14 14 0 0114 14"/>
          <circle cx="6" cy="18" r="1.5" fill="currentColor"/>
        </svg>
        Subscribe
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`Subscribe to ${calendarName}`}
          className="absolute z-20 mt-2 w-[min(28rem,calc(100vw-2rem))] right-0 sm:left-0 sm:right-auto bg-neutral-900 border border-white/15 rounded-xl shadow-2xl p-5 text-left"
        >
          <h3 className="text-white font-semibold mb-1">
            Subscribe to {calendarName}
          </h3>
          <p className="text-white/60 text-xs mb-4">
            Add this calendar to your own calendar app. Events appear automatically and stay
            in sync as we add new ones.
          </p>

          {!urls ? (
            <p className="text-white/50 text-sm">Loading…</p>
          ) : (
            <div className="space-y-3">
              <a
                href={urls.webcal}
                className="flex items-start gap-3 p-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10"
              >
                <span className="text-xl">📅</span>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-sm font-medium">Apple Calendar / Outlook</div>
                  <div className="text-white/50 text-xs">Click to open in your default calendar app</div>
                </div>
              </a>

              <a
                href={urls.google}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-3 p-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10"
              >
                <span className="text-xl">🟦</span>
                <div className="flex-1 min-w-0">
                  <div className="text-white text-sm font-medium">Google Calendar</div>
                  <div className="text-white/50 text-xs">Opens Google Calendar with this feed pre-filled</div>
                </div>
              </a>

              <div className="pt-2">
                <label className="block text-white/60 text-xs mb-1">Or copy the feed URL</label>
                <div className="flex items-stretch gap-2">
                  <input
                    type="text"
                    readOnly
                    value={urls.https}
                    onFocus={(e) => e.currentTarget.select()}
                    className="flex-1 min-w-0 bg-black/40 border border-white/15 rounded-lg px-3 py-2 text-white text-xs font-mono"
                  />
                  <button
                    type="button"
                    onClick={() => copy(urls.https, 'https')}
                    className="px-3 py-2 rounded-lg bg-white text-black text-xs font-semibold hover:bg-white/90"
                  >
                    {copied === 'https' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
