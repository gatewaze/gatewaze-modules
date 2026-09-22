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
.ua-root{position:fixed;inset:0;z-index:60;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;
  color:#fff;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  background:radial-gradient(120% 80% at 50% -10%,#2a2140 0%,#141019 55%,#0b0a0f 100%)}
.ua-root :where(*,*::before,*::after){box-sizing:border-box}
.ua-root :where(button){appearance:none;-webkit-appearance:none;background:transparent;border:0;margin:0;padding:0;font:inherit;color:inherit;cursor:pointer}
.ua-root :where(p,h1,h2){margin:0}
.ua-wrap{max-width:34rem;margin:0 auto;padding:calc(env(safe-area-inset-top,0px) + 14px) 16px calc(env(safe-area-inset-bottom,0px) + 32px)}
.ua-head{position:sticky;top:0;z-index:5;margin:0 -16px;padding:calc(env(safe-area-inset-top,0px) + 10px) 16px 12px;
  background:linear-gradient(180deg,rgba(20,16,25,.96),rgba(20,16,25,.86));backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)}
.ua-event{font-size:13px;color:rgba(255,255,255,.6);text-align:center;margin-bottom:10px;font-weight:600;letter-spacing:.02em}
.ua-switch{display:grid;grid-template-columns:1fr 1fr;padding:4px;border-radius:14px;background:rgba(255,255,255,.08);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.ua-seg{height:42px;border-radius:11px;font-size:15px;font-weight:700;color:rgba(255,255,255,.7);display:flex;align-items:center;justify-content:center;gap:8px}
.ua-seg-on{color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.35)}
.ua-card{margin-top:16px;border-radius:18px;padding:16px;background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}
.ua-h1{font-size:22px;font-weight:800}
.ua-sub{font-size:14px;color:rgba(255,255,255,.65);margin-top:4px;line-height:1.4}
.ua-add{margin-top:16px;width:100%;border-radius:18px;padding:22px 16px;display:flex;flex-direction:column;align-items:center;gap:8px;
  box-shadow:0 10px 30px rgba(0,0,0,.35);transition:transform 120ms ease}
.ua-add:active{transform:scale(.98)}
.ua-add b{font-size:19px;font-weight:800}
.ua-add span{font-size:13px;opacity:.85}
.ua-who{margin-top:10px;font-size:13px;color:rgba(255,255,255,.6);text-align:center}
.ua-who button{text-decoration:underline;color:rgba(255,255,255,.8)}
.ua-status{margin-top:14px;display:flex;align-items:center;gap:10px;font-size:14px;color:rgba(255,255,255,.8)}
.ua-bar{flex:1;height:6px;border-radius:999px;background:rgba(255,255,255,.12);overflow:hidden}
.ua-bar i{display:block;height:100%;border-radius:999px;transition:width 300ms linear}
.ua-notice{margin-top:14px;border-radius:12px;padding:10px 12px;background:#fef3c7;color:#78350f;font-size:14px}
.ua-tabs{margin-top:22px;display:flex;gap:18px;border-bottom:1px solid rgba(255,255,255,.1)}
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

const X_PATH = 'M6 18L18 6M6 6l12 12'

export default function UploadApp(props: Props) {
  const {
    eventName, primaryColor, nameStep, guestName, onNotMe, allowVideo, tiles, onAdd, onDelete, onRetry,
    notice, onOpenBooth, showGallery, everyone, hasMore, loadingMore, onLoadMore,
  } = props
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [tab, setTab] = useState<'mine' | 'everyone'>('mine')
  const [confirming, setConfirming] = useState<string | null>(null)
  const [viewing, setViewing] = useState<{ src: string; isVideo: boolean } | null>(null)

  // Nothing of the page underneath should scroll behind the app.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const active = tiles.filter((t) => t.state === 'waiting' || t.state === 'uploading' || t.state === 'processing')
  const overall = active.length === 0 ? 100 : active.reduce((s, t) => s + (t.state === 'processing' ? 100 : t.progress), 0) / active.length
  const done = tiles.filter((t) => t.state === 'done' || t.state === 'pending').length

  const tileView = (t: UploadTile) => {
    const busy = t.state === 'waiting' || t.state === 'uploading' || t.state === 'processing'
    return (
      <div key={t.key} className="ua-tile">
        <button type="button" className="ua-dim" style={{ background: 'transparent' }} aria-label="View photo"
          onClick={() => setViewing({ src: t.full ?? t.src, isVideo: t.isVideo })}>
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
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d={X_PATH} />
            </svg>
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="ua-root" data-event-media-overlay="" role="main">
      <style>{STYLES}</style>
      <div className="ua-wrap">
        <div className="ua-head">
          <p className="ua-event">{eventName}</p>
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
            <button
              type="button"
              className="ua-add"
              style={{ backgroundColor: primaryColor }}
              onClick={() => inputRef.current?.click()}
            >
              <svg width="34" height="34" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0021.75 19.5V4.5A1.5 1.5 0 0020.25 3H3.75A1.5 1.5 0 002.25 4.5v15A1.5 1.5 0 003.75 21zM12 8.25v6m3-3H9" />
              </svg>
              <b>Add your photos</b>
              <span>Pick as many as you like — they upload straight away</span>
            </button>
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

            {tab === 'mine' && (
              tiles.length === 0
                ? <p className="ua-empty">Photos you add appear here. Tap × on any you&apos;d rather not share.</p>
                : <div className="ua-grid">{tiles.map(tileView)}</div>
            )}

            {tab === 'everyone' && (
              <>
                {everyone.length === 0
                  ? <p className="ua-empty">No photos yet — be the first!</p>
                  : (
                    <div className="ua-grid">
                      {everyone.map((it) => (
                        <button key={it.id} type="button" className="ua-tile" aria-label={it.guest_name ? `Photo by ${it.guest_name}` : 'Photo'}
                          onClick={() => setViewing({ src: it.variants?.medium || it.url, isVideo: it.kind === 'video' })}>
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
          </>
        )}
      </div>

      {viewing && (
        <div className="ua-view" onClick={() => setViewing(null)}>
          {viewing.isVideo
            ? <video src={viewing.src} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} />
            // eslint-disable-next-line @next/next/no-img-element -- full-size view
            : <img src={viewing.src} alt="" />}
          <button type="button" className="ua-view-close" aria-label="Close" onClick={() => setViewing(null)}>
            <svg width="20" height="20" fill="none" viewBox="0 0 24 24" strokeWidth={2.2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d={X_PATH} />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
