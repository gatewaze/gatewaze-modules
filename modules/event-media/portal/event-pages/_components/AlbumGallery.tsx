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

const API_BASE = ''
const PAGE = 60

interface GalleryItem {
  id: string
  kind: 'photo' | 'video'
  url: string
  variants?: Record<string, string> | null
  album?: string | null
  guest_name: string | null
}

interface AlbumChoice {
  album: string
  name: string
  count: number
}

interface Props {
  eventIdentifier: string
  darkMode?: boolean
  primaryColor?: string
}

export default function AlbumGallery({ eventIdentifier, darkMode }: Props) {
  const [albums, setAlbums] = useState<AlbumChoice[]>([])
  const [chosen, setChosen] = useState<string | null>(null)
  const [items, setItems] = useState<GalleryItem[]>([])
  const [total, setTotal] = useState(0)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [lightbox, setLightbox] = useState<number | null>(null)

  const subText = darkMode ? 'text-white/70' : 'text-gray-600'

  // The fetch is written once and used for the first page, an album
  // change and each further page: same request, different offset.
  const load = useCallback(async (album: string | null, offset: number) => {
    const qs = new URLSearchParams({ limit: String(PAGE), offset: String(offset) })
    if (album) qs.set('album', album)
    const res = await fetch(`${API_BASE}/api/public/event-media/events/${encodeURIComponent(eventIdentifier)}/gallery?${qs}`)
    if (!res.ok) throw new Error(`gallery ${res.status}`)
    return res.json() as Promise<{
      albums: AlbumChoice[]
      items: GalleryItem[]
      total: number
      next_offset: number | null
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
    if (lightbox === null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(null)
      if (e.key === 'ArrowRight') setLightbox((i) => (i === null ? null : Math.min(i + 1, items.length - 1)))
      if (e.key === 'ArrowLeft') setLightbox((i) => (i === null ? null : Math.max(i - 1, 0)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox, items.length])

  const open = lightbox === null ? null : items[lightbox] ?? null
  const chips = useMemo(() => [
    { album: null as string | null, name: 'Everything', count: albums.reduce((n, a) => n + a.count, 0) },
    ...albums.map((a) => ({ album: a.album as string | null, name: a.name, count: a.count })),
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
                onClick={() => { setChosen(c.album); setItems([]); }}
                className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm ${
                  on
                    ? 'bg-white text-gray-900 font-medium shadow'
                    : darkMode ? 'bg-white/10 text-white/80' : 'bg-black/5 text-gray-700'
                }`}
              >
                {c.name} <span className="opacity-60">{c.count}</span>
              </button>
            )
          })}
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
            onClick={() => setLightbox(i)}
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
                src={item.variants?.thumb || item.url}
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
          onClick={() => setLightbox(null)}
        >
          <div className="max-h-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
            {open.kind === 'video' ? (
              <video src={open.url} controls autoPlay playsInline className="max-h-[85vh] max-w-full" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- lightbox shows the CDN copy directly
              <img
                src={open.variants?.medium || open.url}
                alt={open.guest_name ? `Photo by ${open.guest_name}` : 'Event photo'}
                className="max-h-[85vh] max-w-full object-contain"
              />
            )}
            {open.guest_name && <p className="mt-2 text-center text-sm text-white/80">by {open.guest_name}</p>}
          </div>
          {lightbox !== null && lightbox > 0 && (
            <button
              className="absolute left-2 top-1/2 -translate-y-1/2 px-3 py-6 text-4xl text-white/80"
              onClick={(e) => { e.stopPropagation(); setLightbox(lightbox - 1) }}
              aria-label="Previous photo"
            >
              ‹
            </button>
          )}
          {lightbox !== null && lightbox < items.length - 1 && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-6 text-4xl text-white/80"
              onClick={(e) => { e.stopPropagation(); setLightbox(lightbox + 1) }}
              aria-label="Next photo"
            >
              ›
            </button>
          )}
          <button className="absolute right-4 top-4 text-3xl text-white" onClick={() => setLightbox(null)} aria-label="Close">
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
