'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * The wedding-photos half of the guest page, as an app rather than a web
 * page: full screen, one obvious "Add photos", and the guest's own
 * photos right there -- appearing the moment they are picked, uploading
 * in place, each removable with a tap. A switch at the top goes to the
 * photo booth.
 *
 * No camera here, deliberately: this is for the photos guests have
 * already taken. The booth is where the camera lives.
 *
 * Presentation only. Uploading, deleting and the gallery feed all stay
 * with the page (photos.tsx) and arrive as props, so the upload engine
 * that has been hardened on real phones is the same one underneath.
 */

import { useEffect, useRef, useState } from 'react'

export interface UploadTile {
  key: string
  /** Local preview (object URL) or the server's thumbnail. */
  src: string
  isVideo: boolean
  state: 'waiting' | 'uploading' | 'processing' | 'done' | 'failed' | 'pending'
  progress: number
  error?: string
  /** Server id once it has one; needed to delete a finished upload. */
  mediaId: string | null
  /** Full-size picture for the viewer, when there is one. */
  full?: string
}

interface GalleryItem {
  id: string
  kind: string
  url: string
  variants?: Record<string, string>
  guest_name?: string | null
}

interface Props {
  eventName: string
  primaryColor: string
  /** "Who are you?" when the guest has not said yet; null once they have. */
  nameStep: React.ReactNode | null
  guestName: string | null
  onNotMe: () => void
  allowVideo: boolean
  tiles: UploadTile[]
  onAdd: (files: FileList) => void
  onDelete: (tile: UploadTile) => void
  onRetry: (tile: UploadTile) => void
  notice: string | null
  /** The booth, when this link has one. */
  onOpenBooth: (() => void) | null
  showGallery: boolean
  everyone: GalleryItem[]
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
}

const STYLES = `
.ua-root{position:fixed;inset:0;z-index:60;overflow:hidden;
  color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:transparent}
.ua-root.ua-solid{background:radial-gradient(120% 80% at 50% -10%,#2a2140 0%,#141019 55%,#0b0a0f 100%)}
.ua-root :where(*,*::before,*::after){box-sizing:border-box}
.ua-root :where(button){appearance:none;-webkit-appearance:none;background:transparent;border:0;margin:0;padding:0;font:inherit;color:inherit;cursor:pointer}
.ua-root :where(p,h1,h2){margin:0}
.ua-wrap{max-width:34rem;height:100%;margin:0 auto;display:flex;flex-direction:column;
  padding:calc(env(safe-area-inset-top,0px) + 12px) 16px 0}
.ua-head{flex:none}
/* Only the photos scroll: the switch, the add panel and the tabs stay put. */
.ua-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;
  margin:0 -16px;padding:0 16px calc(env(safe-area-inset-bottom,0px) + 28px)}
.ua-switch{display:grid;grid-template-columns:1fr 1fr;padding:4px;border-radius:14px;background:rgba(255,255,255,.08);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.ua-seg{height:42px;border-radius:11px;font-size:15px;font-weight:700;color:rgba(255,255,255,.7);display:flex;align-items:center;justify-content:center;gap:8px}
.ua-seg-on{color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.35)}
.ua-card{margin-top:16px;border-radius:18px;padding:16px;background:rgba(10,8,20,.5);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
.ua-h1{font-size:22px;font-weight:800}
.ua-sub{font-size:14px;color:rgba(255,255,255,.65);margin-top:4px;line-height:1.4}
.ua-panel{margin-top:14px;border-radius:18px;padding:16px;background:rgba(10,8,20,.45);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.14)}
.ua-panel h2{font-size:18px;font-weight:800}
.ua-panel p{font-size:13px;color:rgba(255,255,255,.72);margin-top:3px;line-height:1.4}
.ua-btn{margin-top:12px;height:48px;padding:0 22px;border-radius:999px;display:inline-flex;align-items:center;gap:8px;
  font-size:16px;font-weight:800;color:#fff;box-shadow:0 6px 18px rgba(0,0,0,.35);transition:transform 120ms ease}
.ua-btn:active{transform:scale(.97)}
.ua-who{margin-top:10px;font-size:13px;color:rgba(255,255,255,.6);text-align:center}
.ua-who button{text-decoration:underline;color:rgba(255,255,255,.8)}
.ua-status{margin-top:14px;display:flex;align-items:center;gap:10px;font-size:14px;color:rgba(255,255,255,.8)}
.ua-bar{flex:1;height:6px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden}
.ua-bar i{display:block;height:100%;border-radius:999px;transition:width 300ms linear}
.ua-notice{margin-top:14px;border-radius:12px;padding:10px 12px;background:#fef3c7;color:#78350f;font-size:14px}
.ua-tabs{flex:none;margin-top:18px;display:flex;gap:18px;border-bottom:1px solid rgba(255,255,255,.1)}
.ua-tab{padding:10px 2px;font-size:15px;font-weight:700;color:rgba(255,255,255,.5);border-bottom:2px solid transparent;margin-bottom:-1px}
.ua-tab-on{color:#fff}
.ua-grid{margin-top:12px;display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
.ua-tile{position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;background:#1f1b26}
.ua-tile img,.ua-tile video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;max-width:none}
.ua-dim{position:absolute;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}
.ua-ring{width:38px;height:38px}
.ua-x{position:absolute;top:6px;right:6px;width:28px;height:28px;border-radius:50%;background:rgba(0,0,0,.6);
  display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 1px rgba(255,255,255,.25)}
.ua-badge{position:absolute;left:6px;bottom:6px;font-size:10px;font-weight:700;border-radius:6px;padding:2px 6px}
.ua-confirm{position:absolute;inset:0;background:rgba(10,8,14,.85);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:6px}
.ua-confirm p{font-size:12px;font-weight:700}
.ua-confirm div{display:flex;gap:6px}
.ua-mini{font-size:12px;font-weight:700;border-radius:8px;padding:6px 10px;background:rgba(255,255,255,.14)}
.ua-mini-danger{background:#b42318}
.ua-empty{margin-top:18px;text-align:center;font-size:14px;color:rgba(255,255,255,.55);line-height:1.5}
.ua-more{display:block;margin:16px auto 0;height:42px;padding:0 20px;border-radius:999px;font-size:14px;font-weight:700;background:rgba(255,255,255,.1)}
.ua-view{position:fixed;inset:0;z-index:70;background:rgba(0,0,0,.94);display:flex;align-items:center;justify-content:center;padding:16px}
.ua-view img,.ua-view video{max-width:100%;max-height:100%;object-fit:contain;border-radius:8px}
.ua-view-nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;
  background:rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center}
.ua-view-count{position:absolute;left:0;right:0;bottom:calc(env(safe-area-inset-bottom,0px) + 16px);text-align:center;
  font-size:13px;color:rgba(255,255,255,.7)}
.ua-view-close{position:absolute;top:calc(env(safe-area-inset-top,0px) + 12px);right:12px;width:42px;height:42px;border-radius:50%;
  background:rgba(255,255,255,.14);display:flex;align-items:center;justify-content:center}
@media (min-width:640px){.ua-grid{grid-template-columns:repeat(4,1fr)}}
@media (prefers-reduced-motion:reduce){.ua-root *{transition:none!important;animation:none!important}}
`

function Ring({ pct, color }: { pct: number; color: string }) {
  const r = 16
  const c = 2 * Math.PI * r
  return (
    <svg className="ua-ring" viewBox="0 0 38 38" aria-hidden="true">
      <circle cx="19" cy="19" r={r} fill="none" stroke="rgba(255,255,255,.25)" strokeWidth="4" />
      <circle cx="19" cy="19" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.04, pct / 100))} transform="rotate(-90 19 19)" />
    </svg>
  )
}

// A cross closes; a bin deletes. They used to share a cross, so the
// same mark removed a photo on the grid and merely closed the viewer
// (asked 2026-09-22).
const X_PATH = 'M6 18L18 6M6 6l12 12'
const TRASH_PATH = 'M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0'
const CHEVRON_L = 'M15.75 19.5L8.25 12l7.5-7.5'
const CHEVRON_R = 'M8.25 4.5l7.5 7.5-7.5 7.5'
const SWIPE_PX = 50

export default function UploadApp(props: Props) {
  const {
    eventName, primaryColor, nameStep, guestName, onNotMe, allowVideo, tiles, onAdd, onDelete, onRetry,
    notice, onOpenBooth, showGallery, everyone, hasMore, loadingMore, onLoadMore,
  } = props
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [tab, setTab] = useState<'mine' | 'everyone'>('mine')
  const [confirming, setConfirming] = useState<string | null>(null)
  // The large view: which list, and where in it. Swipe or arrow keys to move.
  const [viewing, setViewing] = useState<{ list: 'mine' | 'everyone'; index: number } | null>(null)
  const touchX = useRef<number | null>(null)

  // The portal's own animated background shows through; the event page
  // itself does not. That background is a fixed, pointer-events:none layer
  // among the body's children, so everything else there is hidden (and
  // restored on the way out). If no such layer exists, the app paints its
  // own background instead.
  const [backdrop, setBackdrop] = useState(false)
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const touched: Array<[HTMLElement, string]> = []
    let found = false
    for (const el of Array.from(document.body.children)) {
      if (!(el instanceof HTMLElement)) continue
      if (el.dataset.eventMediaOverlay !== undefined || el.querySelector('[data-event-media-overlay]')) continue
      const cs = getComputedStyle(el)
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue
      if (cs.position === 'fixed' && cs.pointerEvents === 'none') { found = true; continue }
      touched.push([el, el.style.visibility])
      el.style.visibility = 'hidden'
    }
    setBackdrop(found)
    return () => {
      document.body.style.overflow = prev
      for (const [el, v] of touched) el.style.visibility = v
    }
  }, [])

  const viewList = viewing
    ? viewing.list === 'mine'
      ? tiles.map((t) => ({ src: t.full ?? t.src, isVideo: t.isVideo }))
      : everyone.map((it) => ({ src: it.variants?.medium || it.url, isVideo: it.kind === 'video' }))
    : []
  const viewed = viewing ? viewList[Math.min(viewing.index, viewList.length - 1)] ?? null : null
  const step = (d: number) => setViewing((v) => {
    if (!v) return v
    const n = v.list === 'mine' ? tiles.length : everyone.length
    const next = v.index + d
    return next < 0 || next >= n ? v : { ...v, index: next }
  })

  useEffect(() => {
    if (!viewing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'Escape') setViewing(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const active = tiles.filter((t) => t.state === 'waiting' || t.state === 'uploading' || t.state === 'processing')
  const overall = active.length === 0 ? 100 : active.reduce((s, t) => s + (t.state === 'processing' ? 100 : t.progress), 0) / active.length
  const done = tiles.filter((t) => t.state === 'done' || t.state === 'pending').length

  const tileView = (t: UploadTile, index: number) => {
    const busy = t.state === 'waiting' || t.state === 'uploading' || t.state === 'processing'
    return (
      <div key={t.key} className="ua-tile">
        <button type="button" className="ua-dim" style={{ background: 'transparent' }} aria-label="View photo"
          onClick={() => setViewing({ list: 'mine', index })}>
          {t.isVideo
            ? <video src={t.src} muted playsInline preload="metadata" />
            // eslint-disable-next-line @next/next/no-img-element -- local preview or thumbnail
            : <img src={t.src} alt="" loading="lazy" />}
        </button>
        {busy && (
          <div className="ua-dim" aria-label={`Uploading, ${Math.round(t.progress)}%`}>
            <Ring pct={t.state === 'processing' ? 100 : t.progress} color="#fff" />
          </div>
        )}
        {t.state === 'failed' && (
          <div className="ua-dim" style={{ flexDirection: 'column', gap: 6 }}>
            <p style={{ fontSize: 12, fontWeight: 700, textAlign: 'center', padding: '0 6px' }}>{t.error ?? 'Did not upload'}</p>
            <button type="button" className="ua-mini" onClick={() => onRetry(t)}>Try again</button>
          </div>
        )}
        {t.state === 'pending' && (
          <span className="ua-badge" style={{ background: '#f59e0b', color: '#111' }}>Awaiting approval</span>
        )}
        {confirming === t.key ? (
          <div className="ua-confirm">
            <p>{t.state === 'done' || t.state === 'pending' ? 'Remove this photo?' : 'Stop this upload?'}</p>
            <div>
              <button type="button" className="ua-mini ua-mini-danger" onClick={() => { setConfirming(null); onDelete(t) }}>Remove</button>
              <button type="button" className="ua-mini" onClick={() => setConfirming(null)}>Keep</button>
            </div>
          </div>
        ) : (
          <button type="button" className="ua-x" aria-label="Remove this photo" onClick={() => setConfirming(t.key)}>
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d={TRASH_PATH} />
            </svg>
          </button>
        )}
      </div>
    )
  }

  return (
    <div className={`ua-root${backdrop ? '' : ' ua-solid'}`} data-event-media-overlay="" role="main">
      <style>{STYLES}</style>
      <div className="ua-wrap">
        <div className="ua-head">
          {onOpenBooth && (
            <div className="ua-switch" role="tablist" aria-label="Choose">
              <button type="button" role="tab" aria-selected="true" className="ua-seg ua-seg-on" style={{ backgroundColor: primaryColor }}>
                Wedding photos
              </button>
              <button type="button" role="tab" aria-selected="false" className="ua-seg" onClick={onOpenBooth}>
                Photo booth
              </button>
            </div>
          )}
        </div>

        {nameStep ? (
          <div className="ua-card">{nameStep}</div>
        ) : (
          <>
            <div className="ua-panel">
              <h2>Share your photos</h2>
              <p>Pick as many as you like from your phone — they upload straight away.</p>
              <button
                type="button"
                className="ua-btn"
                style={{ backgroundColor: primaryColor }}
                onClick={() => inputRef.current?.click()}
              >
                <svg width="20" height="20" fill="none" viewBox="0 0 24 24" strokeWidth={2.6} stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                Add photos
              </button>
            </div>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={allowVideo ? 'image/*,video/mp4,video/quicktime,video/webm' : 'image/*'}
              style={{ display: 'none' }}
              onChange={(e) => { if (e.target.files?.length) onAdd(e.target.files); e.target.value = '' }}
            />
            {guestName && (
              <p className="ua-who">
                Sharing as <b>{guestName}</b> · <button type="button" onClick={onNotMe}>not you?</button>
              </p>
            )}

            {active.length > 0 && (
              <div className="ua-status" aria-live="polite">
                <span>Uploading {active.length}…</span>
                <span className="ua-bar"><i style={{ width: `${overall}%`, backgroundColor: primaryColor }} /></span>
              </div>
            )}
            {notice && <p className="ua-notice" role="alert">{notice}</p>}

            <div className="ua-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === 'mine'} className={`ua-tab${tab === 'mine' ? ' ua-tab-on' : ''}`}
                style={tab === 'mine' ? { borderBottomColor: primaryColor } : undefined} onClick={() => setTab('mine')}>
                Your photos{done > 0 ? ` (${done})` : ''}
              </button>
              {showGallery && (
                <button type="button" role="tab" aria-selected={tab === 'everyone'} className={`ua-tab${tab === 'everyone' ? ' ua-tab-on' : ''}`}
                  style={tab === 'everyone' ? { borderBottomColor: primaryColor } : undefined} onClick={() => setTab('everyone')}>
                  Everyone&apos;s
                </button>
              )}
            </div>

            <div className="ua-scroll">
            {tab === 'mine' && (
              tiles.length === 0
                ? <p className="ua-empty">Photos you add appear here. Tap × on any you&apos;d rather not share.</p>
                : <div className="ua-grid">{tiles.map((t, i) => tileView(t, i))}</div>
            )}

            {tab === 'everyone' && (
              <>
                {everyone.length === 0
                  ? <p className="ua-empty">No photos yet — be the first!</p>
                  : (
                    <div className="ua-grid">
                      {everyone.map((it, i) => (
                        <button key={it.id} type="button" className="ua-tile" aria-label={it.guest_name ? `Photo by ${it.guest_name}` : 'Photo'}
                          onClick={() => setViewing({ list: 'everyone', index: i })}>
                          {it.kind === 'video'
                            ? <video src={it.url} muted playsInline preload="metadata" />
                            // eslint-disable-next-line @next/next/no-img-element -- gallery thumbnail
                            : <img src={it.variants?.thumb || it.url} alt="" loading="lazy" />}
                        </button>
                      ))}
                    </div>
                  )}
                {hasMore && (
                  <button type="button" className="ua-more" disabled={loadingMore} onClick={onLoadMore}>
                    {loadingMore ? 'Loading…' : 'Show more'}
                  </button>
                )}
              </>
            )}
            </div>
          </>
        )}
      </div>

      {viewing && viewed && (
        <div
          className="ua-view"
          role="dialog"
          aria-label="Photo"
          onClick={() => setViewing(null)}
          onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null }}
          onTouchEnd={(e) => {
            const start = touchX.current
            touchX.current = null
            const end = e.changedTouches[0]?.clientX
            if (start === null || end === undefined) return
            const dx = end - start
            if (Math.abs(dx) >= SWIPE_PX) step(dx < 0 ? 1 : -1)
          }}
        >
          {viewed.isVideo
            ? <video key={viewed.src} src={viewed.src} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} />
            // eslint-disable-next-line @next/next/no-img-element -- full-size view
            : <img key={viewed.src} src={viewed.src} alt="" onClick={(e) => e.stopPropagation()} />}
          <button type="button" className="ua-view-close" aria-label="Close" onClick={() => setViewing(null)}>
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d={X_PATH} />
            </svg>
          </button>
          {viewing.index > 0 && (
            <button type="button" className="ua-view-nav" style={{ left: 10 }} aria-label="Previous photo" onClick={(e) => { e.stopPropagation(); step(-1) }}>
              <svg width="22" height="22" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d={CHEVRON_L} /></svg>
            </button>
          )}
          {viewing.index < viewList.length - 1 && (
            <button type="button" className="ua-view-nav" style={{ right: 10 }} aria-label="Next photo" onClick={(e) => { e.stopPropagation(); step(1) }}>
              <svg width="22" height="22" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d={CHEVRON_R} /></svg>
            </button>
          )}
          <p className="ua-view-count">{viewing.index + 1} / {viewList.length}</p>
        </div>
      )}
    </div>
  )
}
