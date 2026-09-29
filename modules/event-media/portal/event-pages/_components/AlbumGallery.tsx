'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * The event's photographs, for anyone who just opens the page.
 *
 * The guest app is reached with an upload code on the URL (?u=…). Without
 * one there is nothing to upload with and nobody to be, so this is what
 * the page shows instead: the albums along the top, the photographs
 * under them, and a photograph full screen when one is tapped (asked
 * 2026-09-27, as the old portal had it).
 *
 * It asks nothing of the visitor. No name, no device id, no upload
 * controls -- those belong to the half of the page that has a code.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { faceOf as pickFace } from './_lib/gallery-face'
import { dragOffset, swipeVerdict, TAP_SLOP_PX } from './_lib/swipe'
import { albumAddress, pageBaseFrom } from './_lib/album-address'

const API_BASE = ''

/** A link, for copying one. */
function LinkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.2 10.8a4.5 4.5 0 0 0-6.4 0l-2.7 2.7a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.8 13.2a4.5 4.5 0 0 0 6.4 0l2.7-2.7a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2" />
    </svg>
  )
}

/** A sparkle, for the enhanced copy. */
function SparkIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M18 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8L18 15Z" />
    </svg>
  )
}

/** A half-filled frame, for swapping to the other version of a booth photo. */
function XrayIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M12 4.5v15" />
      <path d="M12 4.5h6a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5h-6Z" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** A tick, for a moment after a link is copied. */
function TickIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.5l5 5 10-11" />
    </svg>
  )
}

const PAGE = 24
/** How long a photograph takes to leave once it has been let go. */
const LEAVE_MS = 200

interface GalleryItem {
  id: string
  kind: 'photo' | 'video'
  url: string
  variants?: Record<string, string> | null
  album?: string | null
  guest_name: string | null
  /** The photograph the guest actually took, where the booth kept one. */
  selfie?: string | null
  /** The album this belongs to, as a link writes it. */
  album_slug?: string | null
  /** url and variants are the enhanced copy of this photograph. */
  enhanced?: boolean
  /** The photograph as it was taken, where an enhanced one is shown. */
  original?: { url: string; thumb?: string; medium?: string } | null
  /** The selfie as it was taken, where an enhanced one is shown. */
  selfie_original?: string | null
  selfie_enhanced?: boolean
}

interface AlbumChoice {
  album: string
  /** What a link carries: "Getting ready" -> getting-ready. */
  slug: string
  name: string
  count: number
  /** This album is showing the enhanced copies of its photographs. */
  enhanced?: boolean
  /** The selfies behind this album's booth pictures may be shown. */
  xray?: boolean
}

interface Props {
  eventIdentifier: string
  darkMode?: boolean
  primaryColor?: string
  /** ?album= on the way in: the album a shared link names. */
  initialAlbum?: string | null
  /**
   * The album named by the address itself -- the "getting-ready" of
   * /photos/getting-ready -- as opposed to one named by a query. Kept
   * apart from initialAlbum because the page's own address is this
   * minus that segment, and everything written back to the bar is built
   * from it.
   */
  pathAlbum?: string | null
  /** ?photo= on the way in: the photograph a shared link names. */
  initialPhoto?: string | null
}

export default function AlbumGallery({
  eventIdentifier, darkMode, initialAlbum, initialPhoto, pathAlbum,
}: Props) {
  const [albums, setAlbums] = useState<AlbumChoice[]>([])
  const [chosen, setChosen] = useState<string | null>(initialAlbum ?? null)
  const [items, setItems] = useState<GalleryItem[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [lightbox, setLightbox] = useState<number | null>(null)
  // X-ray: the selfies people actually took, rather than what the booth
  // made of them (asked 2026-09-27).
  const [xray, setXray] = useState(false)
  // Enhanced copies are what an album with enhancement on shows; the
  // checkbox is how you see what was done (asked 2026-09-28). Both this
  // and x-ray can be switched per photograph while one is open, without
  // changing what the grid behind is showing.
  const [showEnhanced, setShowEnhanced] = useState(true)
  const [openEnhanced, setOpenEnhanced] = useState<boolean | null>(null)
  const [openXray, setOpenXray] = useState<boolean | null>(null)
  // Dragging one photograph aside to bring in the next, on a phone. The
  // picture follows the finger rather than a swipe being detected after
  // the fact (asked 2026-09-28).
  const [drag, setDrag] = useState(0)
  /**
   * The photograph on its way out. Letting go used to snap the picture
   * back to the middle and change what it showed in the same breath,
   * which reads as a bounce rather than a page turning (reported
   * 2026-09-28): it now carries on the way the finger went, and the next
   * one takes its place once it has gone.
   */
  const [leaving, setLeaving] = useState<0 | -1 | 1>(0)
  const dragFrom = useRef<{ x: number; y: number; at: number } | null>(null)
  const dragging = useRef(false)
  // A photograph a link named, shown before the page it sits on has
  // loaded -- page forty of The day is still one link.
  const [focus, setFocus] = useState<GalleryItem | null>(null)
  const [copied, setCopied] = useState(false)
  const wantedPhoto = useRef<string | null>(initialPhoto ?? null)

  const subText = darkMode ? 'text-white/70' : 'text-gray-600'

  // The fetch is written once and used for the first page, an album
  // change and each further page: same request, different offset.
  const load = useCallback(async (album: string | null, offset: number) => {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    if (album) qs.set('album', album)
    if (offset === 0 && wantedPhoto.current) qs.set('photo', wantedPhoto.current)
    const res = await fetch(`${API_BASE}/api/public/event-media/events/${encodeURIComponent(eventIdentifier)}/gallery?${qs}`)
    if (!res.ok) throw new Error(`gallery ${res.status}`)
    return res.json() as Promise<{
      albums: AlbumChoice[]
      items: GalleryItem[]
      total: number
      next_offset: number | null
      focus?: GalleryItem | null
    }>
  }, [eventIdentifier])

  // First page, and again whenever the album changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    load(chosen, 0)
      .then((data) => {
        if (cancelled) return
        setAlbums(data.albums ?? [])
        setItems(data.items ?? [])
        setTotal(data.total ?? 0)
        setNextOffset(data.next_offset ?? null)
        if (data.focus) {
          // If the link's photograph is on this page, it becomes the one
          // being looked at rather than a thing shown over the top: then
          // it drags, it has neighbours, and the arrows move from it. A
          // photograph further in than the first page stays a focus until
          // the page it sits on has loaded.
          const here = (data.items ?? []).findIndex((i) => i.id === data.focus!.id)
          if (here >= 0) setLightbox(here)
          else setFocus(data.focus)
          // Only on the way in: choosing another album afterwards should
          // not reopen the photograph the link named.
          wantedPhoto.current = null
        }
      })
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [load, chosen])

  const more = useCallback(async () => {
    if (nextOffset === null) return
    const at = nextOffset
    // Claim the offset first: the sentinel can fire twice before a page
    // arrives, and the same photographs would be appended twice.
    setNextOffset(null)
    try {
      const data = await load(chosen, at)
      setItems((prev) => {
        const seen = new Set(prev.map((i) => i.id))
        return [...prev, ...(data.items ?? []).filter((i) => !seen.has(i.id))]
      })
      setNextOffset(data.next_offset ?? null)
    } catch {
      setNextOffset(at)
    }
  }, [load, chosen, nextOffset])

  // More photographs as the visitor reaches the end of the ones they
  // have, rather than a button to press.
  const sentinel = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const node = sentinel.current
    if (!node || nextOffset === null) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void more()
    }, { rootMargin: '600px' })
    io.observe(node)
    return () => io.disconnect()
  }, [more, nextOffset])

  // Arrow keys and Escape while a photograph is full screen.
  useEffect(() => {
    if (lightbox === null && focus === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setFocus(null); setLightbox(null) }
      if (e.key === 'ArrowRight') setLightbox((i) => (i === null ? null : Math.min(i + 1, items.length - 1)))
      if (e.key === 'ArrowLeft') setLightbox((i) => (i === null ? null : Math.max(i - 1, 0)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, focus, items.length])

  // Arrow keys move through the grid once a link's photograph is closed.

  const open = focus ?? (lightbox === null ? null : items[lightbox] ?? null)

  // The one on either side, fetched while this one is being looked at,
  // so a drag brings in a photograph rather than a gap. Fetched, not
  // rendered: on a desktop the picture is narrower than the window and
  // anything parked beside it is simply visible (reported 2026-09-28).
  useEffect(() => {
    if (lightbox === null || typeof window === 'undefined') return
    for (const at of [lightbox - 1, lightbox + 1]) {
      const item = items[at]
      if (!item) continue
      const img = new window.Image()
      img.src = faceOf(item, 1200, { xray: openXray ?? xray, enhanced: openEnhanced ?? showEnhanced })
    }
    // faceOf reads the switches, and both are in the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightbox, items, openXray, xray, openEnhanced, showEnhanced])

  /**
   * The address bar always holds the link for what is on screen, so
   * sharing is copying it -- and the copy button hands over the same
   * thing for anyone who would rather press a button (asked 2026-09-27).
   */
  /**
   * The page's own address, worked out once when it loads and never
   * again: whatever the address was, minus the album segment if it had
   * one. Reading it back out of the bar each time is what appended a
   * second copy of the album to /photos/photo-booth -- on the way in the
   * album list has not arrived, so there was nothing to recognise and
   * strip (reported 2026-09-28).
   */
  const pageBase = useRef<string | null>(null)
  if (pageBase.current === null && typeof window !== 'undefined') {
    pageBase.current = pageBaseFrom(window.location.pathname, pathAlbum)
  }

  const linkFor = useCallback((album: string | null, photo: GalleryItem | null): string => {
    if (typeof window === 'undefined') return ''
    const url = new URL(window.location.href)
    url.search = ''
    const slug = photo?.album_slug ?? album
    // The album is part of the address -- /photos/getting-ready -- with
    // the query kept for the one photograph.
    url.pathname = albumAddress(pageBase.current ?? '/', slug)
    if (photo) url.searchParams.set('photo', photo.id)
    return url.toString()
  }, [pathAlbum])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const next = linkFor(chosen, open)
    if (next && next !== window.location.href) window.history.replaceState(null, '', next)
  }, [chosen, open, linkFor])

  const copyLink = useCallback(async (album: string | null, photo: GalleryItem | null) => {
    const link = linkFor(album, photo)
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Some phones refuse the clipboard outside a trusted gesture;
      // the address bar holds the same link either way.
      window.prompt('Copy this link', link)
    }
  }, [linkFor])

  const closeLightbox = useCallback(() => {
    setFocus(null)
    setLightbox(null)
    setOpenEnhanced(null)
    setOpenXray(null)
    setDrag(0)
    dragFrom.current = null
    dragging.current = false
  }, [])

  // A photograph opens showing what the grid shows; the switches under
  // it are for this photograph only and go when it closes.
  const openAt = useCallback((i: number) => {
    setOpenEnhanced(null)
    setOpenXray(null)
    setDrag(0)
    setLeaving(0)
    setLightbox(i)
  }, [])
  // Only the booth's own albums have selfies behind their pictures.
  // The server sends a selfie only for an album whose organiser has
  // turned x-ray on, so having one is the permission.
  const boothAlbum = items.some((i) => i.selfie)
  // Only where an album is actually showing enhanced copies is there a
  // difference to look at.
  const albumIsEnhanced = albums.some((a) => (chosen === null || a.slug === chosen || a.album === chosen) && a.enhanced)
    && items.some((i) => i.enhanced)
  const someSelfies = boothAlbum
  /**
   * What to show for one item. Under x-ray that is the selfie -- and the
   * booth picture where there is no selfie, for the ones made before the
   * booth started keeping them, rather than a hole in the grid.
   */
  const faceOf = (item: GalleryItem, width: number, over?: { xray?: boolean; enhanced?: boolean }) => pickFace(
    { ...item, selfieOriginal: item.selfie_original ?? null },
    width,
    { xray: over?.xray ?? xray, enhanced: over?.enhanced ?? showEnhanced },
  )

  const chips = useMemo(() => [
    { album: null as string | null, name: 'Everything', count: albums.reduce((n, a) => n + a.count, 0) },
    // Chosen by slug, which is what a link carries.
    ...albums.map((a) => ({ album: a.slug as string | null, name: a.name, count: a.count })),
  ], [albums])

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      {/* All of them on screen at once: a row that scrolls sideways hides
          half the albums behind an edge nobody notices (reported
          2026-09-28). Wrapping costs a line of height and nothing else. */}
      {chips.length > 1 && (
        <div className="mb-1 flex flex-wrap gap-2 pb-2">
          {chips.map((c) => {
            const on = c.album === chosen
            return (
              <button
                key={c.album ?? 'all'}
                onClick={() => setChosen(c.album)}
                // The colours are written here rather than as classes:
                // the chosen chip came out white on white in the portal
                // build (reported 2026-09-27), and a chip nobody can read
                // is worse than one that does not match the theme.
                style={on
                  ? { background: '#ffffff', color: '#111827', fontWeight: 600 }
                  : { background: darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.06)', color: darkMode ? 'rgba(255,255,255,0.85)' : '#374151' }}
                className="shrink-0 rounded-full px-3.5 py-1.5 text-sm"
              >
                {c.name} <span style={{ opacity: 0.6 }}>{c.count}</span>
              </button>
            )
          })}
        </div>
      )}

      {items.length > 0 && (
        <div className="mb-3 flex items-center justify-end gap-2">
          {/* What you can change about what you are looking at, beside
              the link -- not a column of worded checkboxes under the
              albums (asked 2026-09-28). */}
          {albumIsEnhanced && (
            <button
              onClick={() => setShowEnhanced((v) => !v)}
              title={showEnhanced ? 'Showing the improved copies' : 'Showing the photos as they were taken'}
              aria-label={showEnhanced ? 'Show the photos as they were taken' : 'Show the improved copies'}
              aria-pressed={showEnhanced}
              className="rounded-full p-2"
              style={showEnhanced
                ? { background: '#ffffff', color: '#111827' }
                : { background: darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)', color: darkMode ? 'rgba(255,255,255,0.85)' : '#374151' }}
            >
              <SparkIcon className="h-4 w-4" />
            </button>
          )}
          {someSelfies && (
            <button
              onClick={() => setXray((v) => !v)}
              title={xray ? 'Showing the selfies people took' : 'Showing what the booth made of them'}
              aria-label={xray ? 'Show what the booth made' : 'Show the selfies people took'}
              aria-pressed={xray}
              className="rounded-full p-2"
              style={xray
                ? { background: '#ffffff', color: '#111827' }
                : { background: darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)', color: darkMode ? 'rgba(255,255,255,0.85)' : '#374151' }}
            >
              <XrayIcon className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={() => void copyLink(chosen, null)}
            title={copied ? 'Link copied' : chosen ? 'Copy a link to this album' : 'Copy a link to these photos'}
            aria-label={copied ? 'Link copied' : chosen ? 'Copy a link to this album' : 'Copy a link to these photos'}
            className={`rounded-full p-2 ${subText}`}
            style={{ background: darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.05)' }}
          >
            {copied ? <TickIcon className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
          </button>
        </div>
      )}

      {loading && items.length === 0 && <p className={`text-sm ${subText}`}>Loading the photos…</p>}
      {failed && (
        <p className={`text-sm ${subText}`}>
          The photos could not be loaded just now. Please try again in a moment.
        </p>
      )}
      {!loading && !failed && items.length === 0 && (
        <p className={`text-sm ${subText}`}>There are no photos here yet.</p>
      )}

      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-1.5">
        {items.map((item, i) => (
          <button
            key={item.id}
            onClick={() => openAt(i)}
            className="relative aspect-square overflow-hidden rounded-lg bg-gray-200"
          >
            {item.kind === 'video' ? (
              <>
                <video src={item.url} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                <span className="absolute inset-0 flex items-center justify-center text-white text-2xl drop-shadow">▶</span>
              </>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- module gallery grid
              <img
                src={faceOf(item, 350)}
                alt={item.guest_name ? `Photo by ${item.guest_name}` : 'Event photo'}
                loading="lazy"
                className="w-full h-full object-cover"
              />
            )}
            {item.guest_name && (
              <span className="absolute bottom-0 left-0 right-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 text-left text-[11px] text-white">
                {item.guest_name}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Where the next page is asked for. */}
      <div ref={sentinel} className="h-8" />
      {nextOffset !== null && (
        <p className={`text-center text-xs ${subText}`}>Loading more…</p>
      )}
      {items.length > 0 && nextOffset === null && total > 0 && (
        <p className={`text-center text-xs ${subText}`}>{total} photo{total === 1 ? '' : 's'}</p>
      )}

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black/90 p-4"
          onClick={closeLightbox}
        >
          <div
            className="relative max-h-full max-w-4xl"
            onClick={(e) => e.stopPropagation()}
            onTouchStart={(e) => {
              if (lightbox === null || e.touches.length !== 1) return
              const t = e.touches[0]!
              dragFrom.current = { x: t.clientX, y: t.clientY, at: Date.now() }
              dragging.current = false
            }}
            onTouchMove={(e) => {
              const from = dragFrom.current
              if (!from || e.touches.length !== 1) return
              const t = e.touches[0]!
              const dx = t.clientX - from.x
              const dy = t.clientY - from.y
              // A finger that has gone further down than across is
              // scrolling, not turning a page: let it go.
              if (!dragging.current) {
                if (Math.abs(dx) < TAP_SLOP_PX && Math.abs(dy) < TAP_SLOP_PX) return
                if (Math.abs(dy) > Math.abs(dx)) { dragFrom.current = null; return }
                dragging.current = true
              }
              setDrag(dragOffset(dx, { atStart: lightbox === 0, atEnd: lightbox === items.length - 1 }))
            }}
            onTouchEnd={() => {
              const from = dragFrom.current
              dragFrom.current = null
              if (!from || !dragging.current) { setDrag(0); return }
              dragging.current = false
              const verdict = swipeVerdict({ dx: drag, ms: Date.now() - from.at, width: window.innerWidth })
              const goes = (verdict === 'next' && lightbox !== null && lightbox < items.length - 1)
                || (verdict === 'previous' && lightbox !== null && lightbox > 0)
              if (!goes || lightbox === null) { setDrag(0); return }
              // Off the way the finger went, then the next one arrives in
              // its place. Changing the picture while it springs back is
              // what made this feel like a bounce rather than a turn.
              const way = verdict === 'next' ? -1 : 1
              setLeaving(way)
              setDrag(way * window.innerWidth)
              window.setTimeout(() => {
                openAt(verdict === 'next' ? lightbox + 1 : lightbox - 1)
                setLeaving(0)
              }, LEAVE_MS)
            }}
            style={{
              transform: `translateX(${drag}px)`,
              // While a finger is down the picture follows it exactly. On
              // release it either settles back or carries on out, and
              // both of those are animated; only the drag itself is not.
              transition: dragFrom.current && drag !== 0
                ? 'none'
                : `transform ${leaving ? LEAVE_MS : 220}ms ease-out`,
              opacity: leaving ? 0.15 : 1,
              touchAction: 'pan-y',
            }}
          >
            {open.kind === 'video' ? (
              <video src={open.url} controls autoPlay playsInline className="max-h-[85vh] max-w-full" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- lightbox shows the CDN copy directly
              <img
                src={faceOf(open, 1200, { xray: openXray ?? xray, enhanced: openEnhanced ?? showEnhanced })}
                alt={open.guest_name ? `Photo by ${open.guest_name}` : 'Event photo'}
                className="max-h-[85vh] max-w-full object-contain"
                draggable={false}
              />
            )}
            {/* The one on either side, waiting just off screen, so the
                drag brings a photograph in rather than a black gap. */}
            {drag !== 0 && lightbox !== null && items[lightbox - 1] && (
              // eslint-disable-next-line @next/next/no-img-element -- the neighbour, off screen
              <img
                src={faceOf(items[lightbox - 1]!, 1200, { xray: openXray ?? xray, enhanced: openEnhanced ?? showEnhanced })}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 my-auto max-h-[85vh] max-w-full object-contain"
                style={{ right: '100%', marginRight: 24 }}
              />
            )}
            {drag !== 0 && lightbox !== null && items[lightbox + 1] && (
              // eslint-disable-next-line @next/next/no-img-element -- the neighbour, off screen
              <img
                src={faceOf(items[lightbox + 1]!, 1200, { xray: openXray ?? xray, enhanced: openEnhanced ?? showEnhanced })}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 my-auto max-h-[85vh] max-w-full object-contain"
                style={{ left: '100%', marginLeft: 24 }}
              />
            )}
            {open.selfie && (
              // The other half of a booth picture: what the booth made,
              // and what it started with. Whichever is not on screen sits
              // in the corner, and tapping it swaps the two over (asked
              // 2026-09-28) -- the x-ray switch, as a picture.
              <button
                onClick={() => setOpenXray((v) => !(v ?? xray))}
                title={(openXray ?? xray) ? 'Show what the booth made of it' : 'Show the selfie behind it'}
                aria-label={(openXray ?? xray) ? 'Show what the booth made of it' : 'Show the selfie behind it'}
                className="absolute bottom-3 right-3 h-20 w-20 overflow-hidden rounded-lg border-2 border-white/80 shadow-lg sm:h-24 sm:w-24"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- the other version, small */}
                <img
                  src={faceOf(open, 350, { xray: !(openXray ?? xray), enhanced: openEnhanced ?? showEnhanced })}
                  alt={(openXray ?? xray) ? 'What the booth made of it' : 'The selfie behind it'}
                  className="h-full w-full object-cover"
                />
              </button>
            )}
            {open.guest_name && <p className="mt-2 text-center text-sm text-white/80">by {open.guest_name}</p>}
            <div className="mt-2 flex items-center justify-end gap-2">
              {open.original && (
                <button
                  onClick={() => setOpenEnhanced((v) => !(v ?? showEnhanced))}
                  title={(openEnhanced ?? showEnhanced) ? 'Showing the improved copy' : 'Showing it as it was taken'}
                  aria-label={(openEnhanced ?? showEnhanced) ? 'Show it as it was taken' : 'Show the improved copy'}
                  aria-pressed={openEnhanced ?? showEnhanced}
                  style={{
                    background: (openEnhanced ?? showEnhanced) ? '#ffffff' : 'rgba(255,255,255,0.16)',
                    color: (openEnhanced ?? showEnhanced) ? '#111827' : '#ffffff',
                  }}
                  className="rounded-full p-2"
                >
                  <SparkIcon className="h-4 w-4" />
                </button>
              )}
              <button
                onClick={() => void copyLink(chosen, open)}
                title={copied ? 'Link copied' : 'Copy a link to this photo'}
                aria-label={copied ? 'Link copied' : 'Copy a link to this photo'}
                style={{ background: 'rgba(255,255,255,0.16)', color: '#ffffff' }}
                className="rounded-full p-2"
              >
                {copied ? <TickIcon className="h-4 w-4" /> : <LinkIcon className="h-4 w-4" />}
              </button>
            </div>
          </div>
          {/* On a desktop there is no finger to drag with, so the arrows
              are the whole of the navigation: round, dark enough to see
              against a photograph, and a target rather than a character
              at the edge of the screen (reported 2026-09-28). */}
          {lightbox !== null && lightbox > 0 && (
            <button
              className="absolute left-3 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full text-2xl text-white sm:left-6 sm:h-14 sm:w-14"
              style={{ background: 'rgba(0,0,0,0.55)' }}
              onClick={(e) => { e.stopPropagation(); openAt(lightbox - 1) }}
              aria-label="Previous photo"
            >
              ‹
            </button>
          )}
          {lightbox !== null && lightbox < items.length - 1 && (
            <button
              className="absolute right-3 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full text-2xl text-white sm:right-6 sm:h-14 sm:w-14"
              style={{ background: 'rgba(0,0,0,0.55)' }}
              onClick={(e) => { e.stopPropagation(); openAt(lightbox + 1) }}
              aria-label="Next photo"
            >
              ›
            </button>
          )}
          <button className="absolute right-4 top-4 text-3xl text-white" onClick={closeLightbox} aria-label="Close">
            ×
          </button>
        </div>
      )}

      <p className={`mt-6 text-center text-xs ${subText}`}>
        Scan the event&apos;s photo QR code to add your own photos.
      </p>
    </div>
  )
}
