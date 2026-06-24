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
    <div ref={containerRef} className="cal-sub" style={{ position: 'relative', display: 'inline-block' }}>
      <style>{`
        .cal-sub-pop { position: absolute; z-index: 20; margin-top: 8px; width: min(28rem, calc(100vw - 2rem)); right: 0; text-align: left;
          background: var(--paper); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow-3); padding: 20px;
          -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); }
        @media (min-width: 640px) { .cal-sub-pop { left: 0; right: auto; } }
        .cal-sub-h { font: 600 15px var(--font-display); color: var(--ink); margin: 0 0 4px; }
        .cal-sub-sub { color: var(--ink-3); font-size: 12px; margin: 0 0 16px; line-height: 1.5; }
        .cal-sub-opt { display: flex; align-items: flex-start; gap: 12px; padding: 12px; border-radius: 10px; text-decoration: none;
          background: rgba(var(--ui-text), 0.04); border: 1px solid var(--line); transition: background .15s ease, border-color .15s ease; }
        .cal-sub-opt:hover { background: rgba(var(--ui-text), 0.07); border-color: var(--line-2); }
        .cal-sub-opt-t { color: var(--ink); font-size: 14px; font-weight: 500; }
        .cal-sub-opt-d { color: var(--ink-3); font-size: 12px; }
        .cal-sub-label { display: block; color: var(--ink-3); font-size: 12px; margin-bottom: 4px; }
        .cal-sub-url { flex: 1; min-width: 0; background: rgba(var(--ui-text), 0.06); border: 1px solid var(--line); border-radius: 10px;
          padding: 8px 12px; color: var(--ink); font: 12px var(--font-mono); }
        .cal-sub-copy { padding: 8px 12px; border-radius: 10px; border: 0; cursor: pointer; font: 600 12px var(--font-sans);
          background: var(--ink); color: var(--paper); transition: opacity .15s ease; white-space: nowrap; }
        .cal-sub-copy:hover { opacity: 0.9; }
      `}</style>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="btn btn-secondary"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg className="ic" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 00-7-7m7 14a7 7 0 01-7 7M5 5a14 14 0 0114 14"/>
          <circle cx="6" cy="18" r="1.5" fill="currentColor"/>
        </svg>
        Subscribe
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`Subscribe to ${calendarName}`}
          className="cal-sub-pop"
        >
          <h3 className="cal-sub-h">Subscribe to {calendarName}</h3>
          <p className="cal-sub-sub">
            Add this calendar to your own calendar app. Events appear automatically and stay
            in sync as we add new ones.
          </p>

          {!urls ? (
            <p style={{ color: 'var(--ink-3)', fontSize: 14 }}>Loading…</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <a href={urls.webcal} className="cal-sub-opt">
                <span style={{ fontSize: 20 }}>📅</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cal-sub-opt-t">Apple Calendar / Outlook</div>
                  <div className="cal-sub-opt-d">Click to open in your default calendar app</div>
                </div>
              </a>

              <a href={urls.google} target="_blank" rel="noopener noreferrer" className="cal-sub-opt">
                <span style={{ fontSize: 20 }}>🟦</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="cal-sub-opt-t">Google Calendar</div>
                  <div className="cal-sub-opt-d">Opens Google Calendar with this feed pre-filled</div>
                </div>
              </a>

              <div style={{ paddingTop: 8 }}>
                <label className="cal-sub-label">Or copy the feed URL</label>
                <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
                  <input
                    type="text"
                    readOnly
                    value={urls.https}
                    onFocus={(e) => e.currentTarget.select()}
                    className="cal-sub-url"
                  />
                  <button type="button" onClick={() => copy(urls.https, 'https')} className="cal-sub-copy">
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
