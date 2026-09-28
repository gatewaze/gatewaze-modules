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

const API_BASE = ''

const PAGE = 24

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
}

interface AlbumChoice {
  album: string
  /** What a link carries: "Getting ready" -> getting-ready. */
  slug: string
  name: string
  count: number
  /** This album is showing the enhanced copies of its photographs. */
  enhanced?: boolean
}

interface Props {
  eventIdentifier: string
  darkMode?: boolean
  primaryColor?: string
  /** ?album= on the way in: the album a shared link names. */
  initialAlbum?: string | null
  /** ?photo= on the way in: the photograph a shared link names. */
  initialPhoto?: string | null
}

export default function AlbumGallery({ eventIdentifier, darkMode, initialAlbum, initialPhoto }: Props) {
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
          setFocus(data.focus)
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

  /**
   * The address bar always holds the link for what is on screen, so
   * sharing is copying it -- and the copy button hands over the same
   * thing for anyone who would rather press a button (asked 2026-09-27).
   */
  const linkFor = useCallback((album: string | null, photo: GalleryItem | null): string => {
    if (typeof window === 'undefined') return ''
    const url = new URL(window.location.href)
    url.search = ''
    const slug = photo?.album_slug ?? album
    if (slug) url.searchParams.set('album', slug)
    if (photo) url.searchParams.set('photo', photo.id)
    return url.toString()
  }, [])

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
  }, [])

  // A photograph opens showing what the grid shows; the switches under
  // it are for this photograph only and go when it closes.
  const openAt = useCallback((i: number) => {
    setOpenEnhanced(null)
    setOpenXray(null)
    setLightbox(i)
  }, [])
  // Only the booth's own albums have selfies behind their pictures.
  const boothAlbum = items.some((i) => i.selfie) || chosen === 'photo-booth' || chosen === 'photo-booth-elsewhere'
  // Only where an album is actually showing enhanced copies is there a
  // difference to look at.
  const albumIsEnhanced = albums.some((a) => (chosen === null || a.slug === chosen || a.album === chosen) && a.enhanced)
    && items.some((i) => i.enhanced)
  const someSelfies = boothAlbum && items.some((i) => i.selfie)
  /**
   * What to show for one item. Under x-ray that is the selfie -- and the
   * booth picture where there is no selfie, for the ones made before the
   * booth started keeping them, rather than a hole in the grid.
   */
  const faceOf = (item: GalleryItem, width: number, over?: { xray?: boolean; enhanced?: boolean }) => pickFace(
    item,
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
      {chips.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-3 -mx-1 px-1">
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

      {albumIsEnhanced && (
        <label className={`mb-3 flex w-fit cursor-pointer items-center gap-2 text-sm ${subText}`}>
          <input
            type="checkbox"
            checked={showEnhanced}
            onChange={(e) => setShowEnhanced(e.target.checked)}
            className="h-4 w-4"
          />
          Enhanced: show the improved copies
        </label>
      )}

      {someSelfies && (
        <label className={`mb-3 flex w-fit cursor-pointer items-center gap-2 text-sm ${subText}`}>
          <input
            type="checkbox"
            checked={xray}
            onChange={(e) => setXray(e.target.checked)}
            className="h-4 w-4"
          />
          X-ray: show the selfies people actually took
        </label>
      )}

      {items.length > 0 && (
        <button
          onClick={() => void copyLink(chosen, null)}
          className={`mb-3 text-sm underline underline-offset-2 ${subText}`}
        >
          {copied ? 'Link copied' : chosen ? 'Copy a link to this album' : 'Copy a link to these photos'}
        </button>
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
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={closeLightbox}
        >
          <div className="max-h-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
            {open.kind === 'video' ? (
              <video src={open.url} controls autoPlay playsInline className="max-h-[85vh] max-w-full" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- lightbox shows the CDN copy directly
              <img
                src={faceOf(open, 1200, { xray: openXray ?? xray, enhanced: openEnhanced ?? showEnhanced })}
                alt={open.guest_name ? `Photo by ${open.guest_name}` : 'Event photo'}
                className="max-h-[85vh] max-w-full object-contain"
              />
            )}
            {open.guest_name && <p className="mt-2 text-center text-sm text-white/80">by {open.guest_name}</p>}
            {(open.original || open.selfie) && (
              <div className="mt-3 flex flex-wrap justify-center gap-2" onClick={(e) => e.stopPropagation()}>
                {open.original && (
                  <button
                    onClick={() => setOpenEnhanced((v) => !(v ?? showEnhanced))}
                    style={{
                      background: (openEnhanced ?? showEnhanced) ? '#ffffff' : 'rgba(255,255,255,0.14)',
                      color: (openEnhanced ?? showEnhanced) ? '#111827' : '#ffffff',
                    }}
                    className="rounded-full px-4 py-1.5 text-sm"
                  >
                    {(openEnhanced ?? showEnhanced) ? 'Enhanced' : 'As taken'}
                  </button>
                )}
                {open.selfie && (
                  <button
                    onClick={() => setOpenXray((v) => !(v ?? xray))}
                    style={{
                      background: (openXray ?? xray) ? '#ffffff' : 'rgba(255,255,255,0.14)',
                      color: (openXray ?? xray) ? '#111827' : '#ffffff',
                    }}
                    className="rounded-full px-4 py-1.5 text-sm"
                  >
                    {(openXray ?? xray) ? 'The selfie' : 'X-ray'}
                  </button>
                )}
              </div>
            )}
          </div>
          {lightbox !== null && lightbox > 0 && (
            <button
              className="absolute left-2 top-1/2 -translate-y-1/2 px-3 py-6 text-4xl text-white/80"
              onClick={(e) => { e.stopPropagation(); openAt(lightbox - 1) }}
              aria-label="Previous photo"
            >
              ‹
            </button>
          )}
          {lightbox !== null && lightbox < items.length - 1 && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-6 text-4xl text-white/80"
              onClick={(e) => { e.stopPropagation(); openAt(lightbox + 1) }}
              aria-label="Next photo"
            >
              ›
            </button>
          )}
          <button className="absolute right-4 top-4 text-3xl text-white" onClick={closeLightbox} aria-label="Close">
            ×
          </button>
          {/* The link to this one photograph. */}
          <button
            onClick={(e) => { e.stopPropagation(); void copyLink(chosen, open) }}
            style={{ background: 'rgba(255,255,255,0.14)', color: '#fff' }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-4 py-2 text-sm"
          >
            {copied ? 'Link copied' : 'Copy link to this photo'}
          </button>
        </div>
      )}

      <p className={`mt-6 text-center text-xs ${subText}`}>
        Scan the event&apos;s photo QR code to add your own photos.
      </p>
    </div>
  )
}
