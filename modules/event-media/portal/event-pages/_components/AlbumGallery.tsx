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
import { faceOf as pickFace, fullFaceOf } from './_lib/gallery-face'
import { MAX_SAVE_BYTES, fullSizeUrl, isHttpUrl, saveNameOf, saveTypeOf } from './_lib/save-name'
import { dragOffset, GUTTER_PX, settleOffset, swipeVerdict, TAP_SLOP_PX } from './_lib/swipe'
import {
  NO_ZOOM, TAP_SCALE, clampPan, isDoubleTap, isZoomed, midpoint, scaleAbout, settle, spread,
  type Zoom,
} from './_lib/zoom'
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
function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v11" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 10.5 12 15l4.5-4.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 19h14" />
    </svg>
  )
}

function CopyIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} className={className} aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
    </svg>
  )
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden="true">
      <path strokeLinecap="round" d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  )
}

function TickIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className={className} aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.5l5 5 10-11" />
    </svg>
  )
}

const PAGE = 24

/**
 * The longest edge of a photograph put on the clipboard.
 *
 * It has to be redrawn as a PNG to go there at all, and a full-size PNG
 * of a twelve-megapixel photograph is tens of megabytes for a paste into
 * a message. Saving the photograph is the full-size path; this is not.
 */
const COPY_MAX_EDGE = 2560

/** How far ahead of the photograph being looked at to keep loading. */
const LIGHTBOX_LOOKAHEAD = 8

/**
 * Whose name goes under a photograph, if anyone's.
 *
 * A guest's name is worth showing: it says who took it, and there are
 * many of them. A photographer's is not. Their whole album is theirs, so
 * the same credit under all 851 photographs is noise over the pictures
 * rather than information -- and it is on the album itself (asked
 * 2026-10-17).
 *
 * Written as one expression on purpose: an early `return` up here reads
 * to the portal's rules-of-hooks gate as a component bailing out before
 * its hooks, and every hook in the file below it then looks misplaced.
 */
const creditFor = (item: { guest_name: string | null; album?: string | null }): string | null => (
  item.album === 'photographer' ? null : (item.guest_name || null)
)
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
  /** The roll itself, measured to know how far the neighbour sits. */
  const track = useRef<HTMLDivElement | null>(null)
  /** True for the one frame the photographs are swapped on. */
  const [snap, setSnap] = useState(false)
  /**
   * The photograph's own zoom, which the portal has to do itself: both
   * of the host app's layouts set `userScalable: false`, so the browser's
   * pinch is off for every page of every tenant's portal.
   */
  const [zoom, setZoom] = useState<Zoom>(NO_ZOOM)
  /** The pinch in progress: the finger spread and zoom it started from. */
  const pinch = useRef<{ spread: number; from: Zoom } | null>(null)
  /** Where a one-finger pan started, while zoomed in. */
  const panFrom = useRef<{ x: number; y: number; from: Zoom } | null>(null)
  /** The last tap, for spotting a double one. */
  const lastTap = useRef<{ at: number; x: number; y: number } | null>(null)
  /** The photograph itself, measured so a pan knows how far it may go. */
  const shot = useRef<HTMLImageElement | null>(null)

  /** The frame and the photograph in it, for clamping a pan. */
  const extents = useCallback(() => {
    const frameRect = track.current?.getBoundingClientRect()
    const shotRect = shot.current?.getBoundingClientRect()
    const frame = { w: frameRect?.width ?? 0, h: frameRect?.height ?? 0 }
    // The rendered box divided by the scale it is already drawn at, so
    // the content size is the unzoomed one however deep we are.
    const s = zoom.scale > 0 ? zoom.scale : 1
    const content = shotRect
      ? { w: shotRect.width / s, h: shotRect.height / s }
      : frame
    return { frame, content }
  }, [zoom.scale])

  /** Back to fit. Called whenever the photograph changes or closes. */
  const unzoom = useCallback(() => {
    pinch.current = null
    panFrom.current = null
    setZoom(NO_ZOOM)
  }, [])
  const dragging = useRef(false)
  // A photograph a link named, shown before the page it sits on has
  // loaded -- page forty of The day is still one link.
  const [focus, setFocus] = useState<GalleryItem | null>(null)
  const [copied, setCopied] = useState(false)
  /** 'off' | 'saving' | 'saved' — what the save button is showing. */
  const [saveState, setSaveState] = useState<'off' | 'saving' | 'saved'>('off')
  /** The same, for the copy-to-clipboard button. */
  const [copyState, setCopyState] = useState<'off' | 'copying' | 'copied'>('off')
  /**
   * The two hosts an object can be fetched from, as the api reports
   * them: the CDN that browsing goes through, and the bucket behind it
   * that a save goes to instead.
   */
  const [origins, setOrigins] = useState<{ cdn: string | null; object: string | null }>(
    { cdn: null, object: null },
  )
  // Whether this device can hand a file to the OS share sheet, which on a
  // phone is how a photograph reaches the camera roll; a download there
  // lands in Files where nobody looks for it. Probed once on mount and
  // never during render: building the probe File throws in some old
  // WebViews, and a throw during render takes the page down.
  const [canShareFiles, setCanShareFiles] = useState(false)
  useEffect(() => {
    try {
      const probe = new File([new Uint8Array([0])], 'probe.jpg', { type: 'image/jpeg' })
      setCanShareFiles(Boolean(navigator.canShare?.({ files: [probe] })))
    } catch {
      setCanShareFiles(false)
    }
  }, [])
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
      /** Which end the page came back in, as the api decided it. */
      sort?: 'newest' | 'oldest'
      /** The CDN in front of the bucket, and the bucket itself. */
      cdn_origin?: string | null
      object_origin?: string | null
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
        setOrigins({ cdn: data.cdn_origin ?? null, object: data.object_origin ?? null })
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

  /**
   * More photographs while the lightbox is open.
   *
   * Paging is driven by a sentinel at the foot of the grid, and the
   * lightbox is a fixed overlay on top of it -- so nothing scrolls, the
   * sentinel never intersects, and the album stopped dead at whatever
   * had been loaded when it was opened. The next arrow disappeared and
   * the only way on was to close it, scroll, and open it again
   * (reported 2026-10-17). In here the photograph being looked at is the
   * thing that moves, so it is what asks for the next page.
   */
  useEffect(() => {
    if (lightbox === null || nextOffset === null) return
    if (lightbox >= items.length - LIGHTBOX_LOOKAHEAD) void more()
  }, [lightbox, items.length, nextOffset, more])

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

  /**
   * Keep the photograph being looked at.
   *
   * The file is fetched and handed over as a file rather than linked to,
   * because `<a download>` is ignored across origins -- these objects come
   * off the CDN, not off the portal -- and the browser would navigate to
   * the picture instead of saving it. The CDN allows the read
   * (`access-control-allow-origin: *`), so fetching it is the only thing
   * that actually downloads.
   *
   * On a phone it goes to the share sheet, which is how a picture reaches
   * the camera roll; a download there lands in Files where nobody looks
   * for it. That is the same order `photos.tsx` uses for a booth picture.
   *
   * Whatever face is on screen is what gets saved -- the improved copy or
   * the photograph as it was taken, the booth's picture or the selfie
   * behind it -- but at the size it was stored rather than the size the
   * page happened to be showing.
   */
  const savePhoto = useCallback(async (photo: GalleryItem | null) => {
    if (!photo) return
    const shown = fullFaceOf(
      { ...photo, selfieOriginal: photo.selfie_original ?? null },
      { xray: openXray ?? xray, enhanced: openEnhanced ?? showEnhanced },
    )
    // Off the origin rather than the CDN: Bunny Optimizer recompresses
    // what it serves -- 3.0MB in the bucket came back as 1.4MB at the
    // same pixel dimensions -- and a photograph somebody is keeping or
    // printing should be the one that was delivered.
    const url = fullSizeUrl(shown, origins.cdn, origins.object)
    // Only ever http(s). The url is built by our own api out of operator
    // config and a server-chosen storage path, so this cannot be reached
    // today -- but `window.open` below is one tampered response away
    // from being handed a `javascript:` url, and that is too cheap a
    // guard to leave out.
    if (!isHttpUrl(url)) return
    setSaveState('saving')
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`fetch ${resp.status}`)
      // Checked BEFORE the body is read, because reading it is the thing
      // that costs the memory: `blob()` holds the whole object at once
      // and an upload link allows a two-gigabyte video by default. Over
      // the cap the browser can have it -- it streams, we do not.
      const size = Number(resp.headers.get('content-length') ?? '0')
      if (Number.isFinite(size) && size > MAX_SAVE_BYTES) {
        await resp.body?.cancel()
        throw new Error('too big to hold')
      }
      const blob = await resp.blob()
      // The type comes off a CDN header, so it is allowlisted rather than
      // trusted. Null leaves the File untyped, which is inert; labelling
      // it `image/jpeg` regardless would invite whatever opens it to act
      // on a label we had not checked.
      const type = saveTypeOf(blob.type)
      const file = new File([blob], saveNameOf(url, { ...photo, type }), type ? { type } : undefined)

      if (canShareFiles && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] })
        } catch {
          // A cancelled sheet is somebody changing their mind, not a
          // failure, and falling through to a download would leave them
          // with the file they just declined.
        }
        setSaveState('off')
        return
      }

      const href = URL.createObjectURL(file)
      const a = document.createElement('a')
      a.href = href
      a.download = file.name
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Revoked on a delay: revoking straight away races the browser's own
      // read of the blob in some WebViews and saves a zero-byte file.
      window.setTimeout(() => URL.revokeObjectURL(href), 30_000)
      setSaveState('saved')
      window.setTimeout(() => setSaveState('off'), 2000)
    } catch {
      // Opening it is still better than nothing: the viewer can save it
      // from there with the browser's own menu, and for the one case
      // that lands here on purpose -- an object too big to buffer -- the
      // browser streams what we would have choked on.
      setSaveState('off')
      if (isHttpUrl(url)) window.open(url, '_blank', 'noopener,noreferrer')
    }
  }, [canShareFiles, origins, openXray, xray, openEnhanced, showEnhanced])

  /**
   * Put the photograph on the clipboard, to paste into a message.
   *
   * PNG, whatever the photograph is stored as. The async clipboard only
   * agrees on one image type across browsers -- Chrome and Safari both
   * refuse an `image/jpeg` ClipboardItem -- so a JPEG has to be redrawn
   * through a canvas on the way. That costs a decode, which is why the
   * longest edge is capped: a paste into a messaging app does not need
   * twelve megapixels, and a full-size PNG of one is enormous.
   *
   * The blob is handed over as a PROMISE. Safari ends the user gesture
   * when the handler awaits, and a clipboard write outside a gesture is
   * refused; passing the promise lets it keep the gesture while the
   * fetch runs. Videos cannot go on a clipboard at all, so they do not
   * offer the button.
   */
  const copyImage = useCallback(async (photo: GalleryItem | null) => {
    if (!photo || photo.kind === 'video') return
    const url = fullFaceOf(
      { ...photo, selfieOriginal: photo.selfie_original ?? null },
      { xray: openXray ?? xray, enhanced: openEnhanced ?? showEnhanced },
    )
    if (!isHttpUrl(url)) return

    const asPng = async (): Promise<Blob> => {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error(`fetch ${resp.status}`)
      const size = Number(resp.headers.get('content-length') ?? '0')
      if (Number.isFinite(size) && size > MAX_SAVE_BYTES) {
        await resp.body?.cancel()
        throw new Error('too big to hold')
      }
      const blob = await resp.blob()
      if (saveTypeOf(blob.type) === 'image/png') return blob
      const bitmap = await createImageBitmap(blob)
      try {
        const scale = Math.min(1, COPY_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
        const w = Math.max(1, Math.round(bitmap.width * scale))
        const h = Math.max(1, Math.round(bitmap.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('no canvas')
        ctx.drawImage(bitmap, 0, 0, w, h)
        const png = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
        if (!png) throw new Error('could not encode')
        return png
      } finally {
        bitmap.close()
      }
    }

    setCopyState('copying')
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        throw new Error('no image clipboard here')
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': asPng() })])
      setCopyState('copied')
      window.setTimeout(() => setCopyState('off'), 2000)
    } catch {
      // A browser with no image clipboard, or a refused write. Copying
      // the link instead is something every browser can do, and it is
      // what somebody pasting into a message can use.
      setCopyState('off')
      void copyLink(chosen, photo)
    }
  }, [chosen, copyLink, openXray, xray, openEnhanced, showEnhanced])

  const closeLightbox = useCallback(() => {
    setFocus(null)
    setLightbox(null)
    setOpenEnhanced(null)
    setOpenXray(null)
    setDrag(0)
    dragFrom.current = null
    dragging.current = false
    unzoom()
  }, [unzoom])

  // A photograph opens showing what the grid shows; the switches under
  // it are for this photograph only and go when it closes.
  const openAt = useCallback((i: number) => {
    setOpenEnhanced(null)
    setOpenXray(null)
    setDrag(0)
    setLeaving(0)
    // A zoom belongs to the photograph it was made on. Carrying it to
    // the next one lands the viewer deep inside a picture they have not
    // seen yet, at a corner chosen by the last one.
    unzoom()
    setLightbox(i)
  }, [unzoom])
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
            {creditFor(item) && (
              <span className="absolute bottom-0 left-0 right-0 truncate bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 text-left text-[11px] text-white">
                {creditFor(item)}
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
              if (lightbox === null) return
              // Two fingers is a pinch, and it cancels whatever one
              // finger had started: a page half-turned while the second
              // finger lands should settle back, not keep going.
              if (e.touches.length === 2) {
                const a = e.touches[0]!
                const b = e.touches[1]!
                pinch.current = {
                  spread: spread({ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY }),
                  from: zoom,
                }
                dragFrom.current = null
                dragging.current = false
                panFrom.current = null
                setDrag(0)
                return
              }
              if (e.touches.length !== 1) return
              const t = e.touches[0]!
              // Zoomed in, one finger moves the photograph rather than
              // turning the page. Turning it while magnified would throw
              // away the bit somebody was looking at.
              if (isZoomed(zoom)) {
                panFrom.current = { x: t.clientX, y: t.clientY, from: zoom }
                return
              }
              dragFrom.current = { x: t.clientX, y: t.clientY, at: Date.now() }
              dragging.current = false
            }}
            onTouchMove={(e) => {
              // A pinch: the scale follows the ratio of the finger
              // spread, anchored at the point between them so whatever
              // is under the fingers stays under them.
              if (pinch.current && e.touches.length === 2) {
                const a = e.touches[0]!
                const b = e.touches[1]!
                const now = spread({ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY })
                const started = pinch.current.spread
                if (started <= 0 || now <= 0) return
                const centre = track.current?.getBoundingClientRect()
                const mid = midpoint({ x: a.clientX, y: a.clientY }, { x: b.clientX, y: b.clientY })
                const at = centre
                  ? { x: mid.x - (centre.left + centre.width / 2), y: mid.y - (centre.top + centre.height / 2) }
                  : { x: 0, y: 0 }
                const next = scaleAbout(at, pinch.current.from, pinch.current.from.scale * (now / started))
                const { frame, content } = extents()
                setZoom(clampPan(next, frame, content))
                return
              }
              // A pan, while zoomed in.
              if (panFrom.current && e.touches.length === 1) {
                const t = e.touches[0]!
                const { frame, content } = extents()
                setZoom(clampPan({
                  scale: panFrom.current.from.scale,
                  x: panFrom.current.from.x + (t.clientX - panFrom.current.x),
                  y: panFrom.current.from.y + (t.clientY - panFrom.current.y),
                }, frame, content))
                return
              }
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
            onTouchEnd={(e) => {
              // The last finger of a pinch has come off: keep the zoom if
              // there is one, and fall back to fit if it was pinched
              // shut. Done on the way out rather than during, so the
              // photograph does not snap while fingers are still moving.
              if (pinch.current) {
                if (e.touches.length === 0) {
                  const { frame, content } = extents()
                  setZoom(settle(zoom, frame, content))
                  pinch.current = null
                }
                return
              }
              if (panFrom.current) {
                if (e.touches.length === 0) panFrom.current = null
                return
              }
              const from = dragFrom.current
              dragFrom.current = null
              if (!from || !dragging.current) {
                setDrag(0)
                // A tap that did not drag. Two of them in the same place
                // zoom in, which is the gesture everyone tries first and
                // the only one that works without two hands.
                const tap = { at: Date.now(), x: from?.x ?? 0, y: from?.y ?? 0 }
                if (from && isDoubleTap(lastTap.current, tap)) {
                  lastTap.current = null
                  const centre = track.current?.getBoundingClientRect()
                  const at = centre
                    ? { x: tap.x - (centre.left + centre.width / 2), y: tap.y - (centre.top + centre.height / 2) }
                    : { x: 0, y: 0 }
                  const { frame, content } = extents()
                  setZoom(isZoomed(zoom)
                    ? NO_ZOOM
                    : clampPan(scaleAbout(at, NO_ZOOM, TAP_SCALE), frame, content))
                } else if (from) {
                  lastTap.current = tap
                }
                return
              }
              dragging.current = false
              const verdict = swipeVerdict({ dx: drag, ms: Date.now() - from.at, width: window.innerWidth })
              const goes = (verdict === 'next' && lightbox !== null && lightbox < items.length - 1)
                || (verdict === 'previous' && lightbox !== null && lightbox > 0)
              if (!goes || lightbox === null) { setDrag(0); return }
              // The roll carries on the way the finger went, far enough to
              // put the neighbour exactly where this photograph is -- one
              // width plus the gutter, measured off the track rather than
              // guessed from the window.
              //
              // Then the swap happens with the transition OFF. By that
              // point the neighbour is already sitting in the middle of
              // the screen, so making it the current photograph and
              // putting the roll back to zero is the same picture in the
              // same place: nothing moves. Doing that swap with the
              // transition on is what made this look like a bounce -- the
              // roll animated back to the middle, and the photograph
              // appeared to come in from the side it had just left.
              const way: -1 | 1 = verdict === 'next' ? -1 : 1
              const width = track.current?.getBoundingClientRect().width ?? window.innerWidth
              setLeaving(way)
              setDrag(settleOffset(way, width))
              window.setTimeout(() => {
                setSnap(true)
                openAt(verdict === 'next' ? lightbox + 1 : lightbox - 1)
                setLeaving(0)
                // Two frames: one for the browser to paint the swap with
                // no transition, then the transition comes back for the
                // next drag. One frame is not always enough.
                requestAnimationFrame(() => requestAnimationFrame(() => setSnap(false)))
              }, LEAVE_MS)
            }}
            ref={track}
            style={{
              transform: `translateX(${drag}px)`,
              // While a finger is down the picture follows it exactly. On
              // release it either settles back or carries on out, and
              // both of those are animated; the drag itself is not, and
              // neither is the frame the photographs are swapped on.
              transition: snap || (dragFrom.current && drag !== 0)
                ? 'none'
                : `transform ${leaving ? LEAVE_MS : 220}ms ease-out`,
              // Not faded on the way out. The photograph coming in rides
              // on the same roll, so dimming the one leaving dims the one
              // arriving with it, which is what made a turn read as a
              // flicker rather than a movement.
              //
              // Every touch in here is ours.
              //
              // It cannot be conditional on a pinch being in progress:
              // that lives in a ref, so starting one does not re-render
              // and the style would still say 'pan-y' for the frames
              // that matter most. And it cannot be left to
              // preventDefault, because React registers touchmove as a
              // PASSIVE listener, where preventDefault does nothing but
              // log. The overlay is fixed and covers the page, so there
              // was never anything behind it to scroll anyway.
              touchAction: 'none',
            }}
          >
            {open.kind === 'video' ? (
              <video src={open.url} controls autoPlay playsInline className="max-h-[85vh] max-w-full" />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- lightbox shows the CDN copy directly
              <img
                ref={shot}
                src={faceOf(open, 1200, { xray: openXray ?? xray, enhanced: openEnhanced ?? showEnhanced })}
                alt={open.guest_name ? `Photo by ${open.guest_name}` : 'Event photo'}
                style={{
                  transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
                  // Follows the fingers exactly while they are down; eases
                  // only when a gesture has finished and it is settling.
                  transition: pinch.current || panFrom.current ? 'none' : 'transform 180ms ease-out',
                  willChange: 'transform',
                }}
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
                style={{ right: '100%', marginRight: GUTTER_PX }}
              />
            )}
            {drag !== 0 && lightbox !== null && items[lightbox + 1] && (
              // eslint-disable-next-line @next/next/no-img-element -- the neighbour, off screen
              <img
                src={faceOf(items[lightbox + 1]!, 1200, { xray: openXray ?? xray, enhanced: openEnhanced ?? showEnhanced })}
                alt=""
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 my-auto max-h-[85vh] max-w-full object-contain"
                style={{ left: '100%', marginLeft: GUTTER_PX }}
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
            {creditFor(open) && <p className="mt-2 text-center text-sm text-white/80">by {creditFor(open)}</p>}
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
              {open.kind !== 'video' && (
                <button
                  onClick={() => void copyImage(open)}
                  disabled={copyState === 'copying'}
                  title={
                    copyState === 'copying' ? 'Copying…'
                      : copyState === 'copied' ? 'Copied — paste it anywhere'
                        : 'Copy this photo'
                  }
                  aria-label={
                    copyState === 'copying' ? 'Copying the photo'
                      : copyState === 'copied' ? 'Photo copied'
                        : 'Copy this photo'
                  }
                  style={{ background: 'rgba(255,255,255,0.16)', color: '#ffffff' }}
                  className="rounded-full p-2 disabled:opacity-60"
                >
                  {copyState === 'copying' ? <SpinnerIcon className="h-4 w-4 animate-spin" />
                    : copyState === 'copied' ? <TickIcon className="h-4 w-4" />
                      : <CopyIcon className="h-4 w-4" />}
                </button>
              )}
              <button
                onClick={() => void savePhoto(open)}
                disabled={saveState === 'saving'}
                title={
                  saveState === 'saving' ? 'Saving…'
                    : saveState === 'saved' ? 'Saved'
                      : canShareFiles ? 'Save this photo' : 'Download this photo'
                }
                aria-label={
                  saveState === 'saving' ? 'Saving the photo'
                    : saveState === 'saved' ? 'Photo saved'
                      : canShareFiles ? 'Save this photo' : 'Download this photo'
                }
                style={{ background: 'rgba(255,255,255,0.16)', color: '#ffffff' }}
                className="rounded-full p-2 disabled:opacity-60"
              >
                {saveState === 'saving' ? <SpinnerIcon className="h-4 w-4 animate-spin" />
                  : saveState === 'saved' ? <TickIcon className="h-4 w-4" />
                    : <DownloadIcon className="h-4 w-4" />}
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
          {/* Still offered while there are pages left to fetch. Hiding it
              at the end of the LOADED photographs is what made the album
              look finished when it was not: there was no way on without
              closing the lightbox and scrolling the grid. */}
          {lightbox !== null && (lightbox < items.length - 1 || nextOffset !== null) && (
            <button
              className="absolute right-3 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full text-2xl text-white sm:right-6 sm:h-14 sm:w-14"
              style={{ background: 'rgba(0,0,0,0.55)' }}
              onClick={(e) => {
                e.stopPropagation()
                // At the end of what is loaded, fetch rather than refuse.
                // The lookahead above normally gets there first, so this
                // is the case where somebody out-ran it.
                if (lightbox + 1 < items.length) openAt(lightbox + 1)
                else void more()
              }}
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
