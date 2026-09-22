'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * The illustrated photo booth: a full-screen place rather than a form.
 *
 * The guest picks an era (a painted board of decades, or a plain grid),
 * then one of that era's six looks (painted artwork if the event has it,
 * otherwise cards showing each look's sample picture) -- an event themed
 * on one era starts at its looks. Choosing a look walks them INSIDE that
 * era's booth: the interior fills the screen, their front camera runs
 * live in the booth's window, and the shutter (or the coin slot) takes
 * the picture -- 3 2 1, flash. It develops in the window, then lands on a
 * Polaroid in the carousel of everything they have made.
 *
 * Everything drawn on a scene -- tiles, window, coin slot, panel -- is a
 * fraction of that painting, from the event's booth theme (served by the
 * link endpoint; see lib/booth-theme.ts). _lib/booth-stage.ts decides
 * where the painting sits on a given screen.
 *
 * This component owns only the scenes and the camera. The shot itself,
 * the model call, uploading and saving all stay with the page, exactly as
 * they are for the plain booth, and are reached through the callbacks.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { coverCrop, pctStyle, polaroidSize, stageRect } from './_lib/booth-stage'
import {
  addPicture,
  loadHistory,
  markPosted,
  markUnposted,
  removePicture,
  saveHistory,
  type BoothPicture,
} from './_lib/booth-history'

interface Rect { x: number; y: number; w: number; h: number }
interface Scene { image: string; width: number; height: number; focus_x: number }
interface Interior extends Scene { window: Rect; coin: Rect; panel: Rect }
/** Painted artwork whose tiles each name what they open. */
interface Painted extends Scene { tiles: Array<Rect & { key: string }> }

export interface BoothEraView {
  key: string
  label: string
  blurb: string
  card: string | null
  interior: Interior
  /** Painted outside board, when the event has artwork for it. */
  board: Painted | null
  looks: Array<{ id: string; label: string; blurb: string; sample: string | null }>
}

/** The booth as the link endpoint serves it (lib/booth-theme.ts). */
export interface BoothView {
  /** Painted era picker; a plain grid when absent. */
  picker: Painted | null
  eras: BoothEraView[]
}

export interface BoothLook {
  key: string
  payload: { filter_id: string } | { effect: string }
  label: string
}

interface Shot {
  original: string
  preview: string | null
  filterLabel: string | null
  busy: string | null
  error: string | null
  /** The server's kept copy of `preview`, when it kept one. */
  mediaId?: string | null
}

interface Props {
  booth: BoothView
  effects: Array<{ id: string; label: string; blurb: string }>
  faces: Array<{ id: string; label: string; preview: string }>
  shot: Shot | null
  /** 0..100 while a look is being made. */
  progress: number
  /** Rotating status line while generating. */
  statusText: string
  /** True while generating, and for a beat after, so the bar can finish. */
  generating: boolean
  primaryColor: string
  onCaptured: (dataUrl: string, look: BoothLook | null) => void
  /** No live camera (blocked, or an old browser): use the camera app. */
  onFallbackCamera: (look: BoothLook | null) => void
  onAccept: () => void
  onSave: () => void
  onDiscard: () => void
  onOriginal: () => void
  onClose: () => void
  /** Where this event's pictures are kept on the device. */
  historyKey: string
  /** Upload a kept picture; told the upload's id once it has one. */
  onPostImage: (dataUrl: string, styled: boolean, onMediaId: (mediaId: string) => void) => Promise<void>
  /** Save or share a kept picture; false if it could not be. */
  onSaveImage: (dataUrl: string) => boolean
  /** Remove one of this device's uploads from the event. */
  onRemoveUpload: (mediaId: string) => Promise<boolean>
  /** Put a picture the server already kept onto the big screen. */
  onPostKept: (mediaId: string) => Promise<boolean>
  /** Take one back off the big screen. */
  onUnpostKept: (mediaId: string) => Promise<boolean>
}

/**
 * picker -> board -> (to-inside) -> inside -> (to-outside) -> board.
 * An event with one era starts on its board and never shows the picker.
 */
type Phase = 'picker' | 'board' | 'to-inside' | 'inside' | 'to-outside'
type CamState = 'off' | 'starting' | 'live' | 'blocked'

/** Walking through the curtain. */
const ENTER_MS = 650
const ARRIVE_MS = 550
const COUNT_FROM = 3
const COUNT_STEP_MS = 800
const COIN_MS = 480 // matches bx-drop

// The booth styles itself. It is not built from the portal's Tailwind
// utilities: module code reaches production by snapshot and restart, and
// a class that nothing else in the portal uses may simply not exist
// there -- a missing button reset alone paints white boxes over the
// artwork (seen in the harness). Scoped under .bx-root; the reset uses
// :where() so it never outranks the bx- rules that follow it.
const STYLES = `
.bx-root{position:fixed;top:0;left:0;width:100vw;height:100vh;height:100dvh;z-index:70;background:#000;overflow:hidden;user-select:none;-webkit-user-select:none;
  touch-action:manipulation;-webkit-tap-highlight-color:transparent;color:#fff;
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
.bx-root :where(*,*::before,*::after){box-sizing:border-box}
.bx-root :where(button){appearance:none;-webkit-appearance:none;background:transparent;border:0;margin:0;padding:0;
  font:inherit;color:inherit;cursor:pointer;line-height:1.2;text-align:center}
.bx-root :where(button:disabled){cursor:default;opacity:.45}
.bx-root :where(p){margin:0}
.bx-fill{position:absolute;inset:0}
.bx-abs{position:absolute}
.bx-art{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;max-width:none}
.bx-center{display:flex;align-items:center;justify-content:center}
.bx-glass{background:rgba(12,12,16,.72);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
  border:1px solid rgba(255,255,255,.14)}
.bx-pill{display:inline-flex;align-items:center;gap:6px;height:40px;padding:0 14px;border-radius:999px;
  font-size:14px;font-weight:600;white-space:nowrap}
.bx-tile{position:absolute;border-radius:8px;transition:transform 160ms ease,box-shadow 160ms ease}
.bx-window{position:absolute;overflow:hidden;border-radius:10px;background:#000}
.bx-media{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;max-width:none}
.bx-note{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:12px;padding:16px;text-align:center;font-size:14px;line-height:1.35;color:rgba(255,255,255,.82)}
.bx-count{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:900;
  font-size:min(34vw,180px);text-shadow:0 4px 30px rgba(0,0,0,.6);animation:bx-count 800ms ease-out both}
.bx-flash{position:absolute;inset:0;background:#fff;pointer-events:none;animation:bx-flash 700ms ease-out both}
.bx-dev{position:absolute;left:0;right:0;bottom:0;padding:16px}
.bx-status{font-size:14px;font-weight:600;text-align:center;margin-bottom:8px;text-shadow:0 1px 8px rgba(0,0,0,.8);
  animation:bx-rise 420ms ease-out both}
.bx-bar{position:relative;height:6px;border-radius:999px;overflow:hidden;background:rgba(255,255,255,.2)}
.bx-bar-fill{position:absolute;top:0;bottom:0;left:0;border-radius:999px;transition:width 240ms linear}
.bx-sheen{position:absolute;top:0;bottom:0;width:25%;
  background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.6),rgba(255,255,255,0));
  animation:bx-sheen 1.6s ease-in-out infinite}
.bx-coin{position:absolute;border-radius:8px}
.bx-coin-live{animation:bx-glow 1.8s ease-in-out infinite}
.bx-coin-drop{position:absolute;left:50%;top:50%;width:70%;aspect-ratio:1;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-weight:900;font-size:11px;color:#6b4d06;
  background:radial-gradient(circle at 35% 30%,#fff6c8,#e8b938 55%,#9c7414);box-shadow:0 2px 6px rgba(0,0,0,.5);
  animation:bx-drop 480ms ease-in both}
.bx-shutter{position:absolute;left:50%;bottom:16px;transform:translateX(-50%);width:72px;height:72px;
  border-radius:50%;border:4px solid #fff;display:flex;align-items:center;justify-content:center;
  box-shadow:0 2px 14px rgba(0,0,0,.45);transition:transform 120ms ease}
.bx-shutter::after{content:"";width:54px;height:54px;border-radius:50%;background:#fff;transition:transform 120ms ease}
.bx-shutter:active::after{transform:scale(.86)}
.bx-root :where(button){outline:none}
.bx-root button:focus-visible{outline:3px solid rgba(255,255,255,.85);outline-offset:3px}
.bx-top-right{display:flex;gap:8px;align-items:center}
.bx-car{position:absolute;inset:0;z-index:5;overflow:hidden}
.bx-car-bg{position:absolute;inset:-40px;width:calc(100% + 80px);height:calc(100% + 80px);object-fit:cover;
  filter:blur(18px) brightness(.62) saturate(1.1);max-width:none;pointer-events:none}
.bx-car-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.25),rgba(0,0,0,.05) 40%,rgba(0,0,0,.55))}
.bx-track{position:absolute;left:0;right:0;top:calc(env(safe-area-inset-top,0px) + 64px);bottom:calc(env(safe-area-inset-bottom,0px) + 206px);
  display:flex;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch}
.bx-track::-webkit-scrollbar{display:none}
.bx-slide{flex:0 0 100%;scroll-snap-align:center;display:flex;align-items:center;justify-content:center}
.bx-polaroid{margin:0;border-radius:3px;box-shadow:0 22px 50px rgba(0,0,0,.55),0 2px 6px rgba(0,0,0,.35);
  background:
    radial-gradient(circle at 8% 12%,rgba(170,130,70,.16),transparent 22%),
    radial-gradient(circle at 92% 88%,rgba(170,130,70,.18),transparent 25%),
    radial-gradient(circle at 85% 6%,rgba(170,130,70,.10),transparent 18%),
    linear-gradient(180deg,#f7f3ea,#eee7d6)}
.bx-polaroid img{display:block;object-fit:cover;max-width:none;background:#111;box-shadow:inset 0 0 0 1px rgba(0,0,0,.15)}
.bx-polaroid figcaption{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:#2b2b33}
.bx-hand{font-family:"Bradley Hand","Segoe Print","Marker Felt","Comic Sans MS",cursive;font-size:clamp(18px,5.4vw,28px);transform:rotate(-2deg)}
.bx-note-line{font-size:12px;color:#6b6258;text-align:center;padding:0 10px;line-height:1.3}
.bx-posted{font-size:11px;font-weight:700;letter-spacing:.04em;color:#2f7d4f;text-transform:uppercase}
.bx-arrow{position:absolute;top:calc(env(safe-area-inset-top,0px) + 64px + (100% - 64px - 206px) / 2);transform:translateY(-50%);
  width:48px;height:48px;border-radius:50%;display:flex;align-items:center;justify-content:center}
.bx-car-foot{position:absolute;left:0;right:0;bottom:0;padding:0 16px;display:flex;flex-direction:column;gap:10px;align-items:center}
.bx-car-foot > .bx-primary,.bx-car-foot > .bx-row{width:100%;max-width:26rem}
.bx-counter{font-size:14px;font-weight:600;color:rgba(255,255,255,.9)}
.bx-dots{display:flex;gap:8px}
.bx-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.35)}
.bx-dot-on{background:#fff}
.bx-row.bx-row-4{grid-template-columns:repeat(4,1fr)}
.bx-btn-danger{color:#fecaca}
.bx-danger{background:#b42318}
.bx-confirm-title{font-size:17px;font-weight:700;text-align:center}
.bx-confirm-body{font-size:14px;color:rgba(255,255,255,.75);text-align:center;line-height:1.4}
.bx-screen{position:absolute;inset:0;overflow:hidden}
.bx-screen-bg{position:absolute;inset:-40px;width:calc(100% + 80px);height:calc(100% + 80px);object-fit:cover;
  filter:blur(20px) brightness(.5) saturate(1.15);max-width:none;pointer-events:none}
.bx-screen-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.35),rgba(0,0,0,.1) 30%,rgba(0,0,0,.45))}
.bx-screen-body{position:absolute;inset:0;overflow-y:auto;-webkit-overflow-scrolling:touch;
  padding:calc(env(safe-area-inset-top,0px) + 68px) 16px calc(env(safe-area-inset-bottom,0px) + 84px)}
.bx-h1{font-size:30px;font-weight:800;text-align:center;letter-spacing:.01em;text-shadow:0 2px 16px rgba(0,0,0,.6)}
.bx-sub{font-size:14px;text-align:center;color:rgba(255,255,255,.75);margin-top:4px}
.bx-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;max-width:30rem;margin:18px auto 0}
.bx-card{position:relative;display:block;width:100%;aspect-ratio:3/4;border-radius:14px;overflow:hidden;background:#1d1d22;
  box-shadow:0 10px 24px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.12);transition:transform 160ms ease,box-shadow 160ms ease}
.bx-card img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;max-width:none}
.bx-card-blank{position:absolute;inset:0;background:linear-gradient(135deg,#3a2a4a,#1b2a3a)}
.bx-card-label{position:absolute;left:0;right:0;bottom:0;padding:28px 10px 10px;text-align:left;
  background:linear-gradient(180deg,rgba(0,0,0,0),rgba(0,0,0,.82))}
.bx-card-label b{display:block;font-size:16px;font-weight:800;line-height:1.15}
.bx-card-label span{display:block;font-size:11px;line-height:1.25;margin-top:2px;color:rgba(255,255,255,.75)}
.bx-card-pressed{transform:scale(.95);box-shadow:0 0 0 3px rgba(255,255,255,.9),0 0 30px 8px rgba(255,80,200,.5)}
.bx-more-inline{display:block;margin:18px auto 0;height:44px;padding:0 22px;border-radius:999px;font-size:14px;font-weight:700}
.bx-live{width:100%;max-width:26rem;height:48px;border-radius:12px;display:flex;align-items:center;gap:10px;
  padding:0 8px 0 14px;background:#157f3c;box-shadow:0 0 0 2px rgba(74,222,128,.55),0 6px 20px rgba(21,127,60,.45)}
.bx-live-dot{width:10px;height:10px;border-radius:50%;background:#bbf7d0;box-shadow:0 0 0 0 rgba(187,247,208,.8);
  animation:bx-pulse 1.6s ease-out infinite}
.bx-live-text{flex:1;text-align:left;font-size:15px;font-weight:800}
.bx-live-remove{height:34px;padding:0 14px;border-radius:9px;font-size:13px;font-weight:700;background:rgba(0,0,0,.28);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.35)}
@keyframes bx-pulse{0%{box-shadow:0 0 0 0 rgba(187,247,208,.8)}100%{box-shadow:0 0 0 10px rgba(187,247,208,0)}}
.bx-icons{display:flex;justify-content:center;gap:18px}
.bx-icon{width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  background:rgba(255,255,255,.12);box-shadow:inset 0 0 0 1px rgba(255,255,255,.22)}
.bx-icon-danger{color:#fecaca;background:rgba(180,35,24,.28);box-shadow:inset 0 0 0 1px rgba(254,202,202,.35)}
.bx-panel{position:absolute;display:flex;align-items:center;justify-content:center;pointer-events:none}
.bx-controls{pointer-events:auto;width:100%;height:100%;border-radius:14px;padding:10px;display:flex;
  flex-direction:column;justify-content:center;gap:8px;animation:bx-rise 380ms ease-out both}
.bx-primary{width:100%;height:44px;border-radius:10px;font-size:14px;font-weight:700;color:#fff}
.bx-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.bx-btn{height:40px;border-radius:10px;font-size:12px;font-weight:600;background:rgba(255,255,255,.1);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.2)}
.bx-link{font-size:11px;color:rgba(255,255,255,.6);text-decoration:underline}
.bx-error{font-size:12px;color:#fcd34d;text-align:center;line-height:1.25}
.bx-top{position:absolute;left:0;right:0;display:flex;align-items:center;justify-content:space-between;padding:0 12px}
.bx-toast{position:absolute;left:50%;transform:translateX(-50%);padding:8px 16px;border-radius:999px;font-size:14px;
  font-weight:600;white-space:nowrap;animation:bx-rise-x 300ms ease-out both}
.bx-more{position:absolute;left:50%;transform:translateX(-50%);height:44px;padding:0 22px;border-radius:999px;
  font-size:14px;font-weight:700}
.bx-sheet-wrap{position:absolute;inset:0;z-index:10}
.bx-scrim{position:absolute;inset:0;background:rgba(0,0,0,.5)}
.bx-sheet{position:absolute;left:0;right:0;bottom:0;width:100%;max-width:32rem;margin:0 auto;border-radius:24px 24px 0 0;padding:20px;
  display:flex;flex-direction:column;gap:16px;animation:bx-rise 280ms ease-out both}
.bx-grip{margin:0 auto;height:4px;width:40px;border-radius:999px;background:rgba(255,255,255,.3)}
.bx-faces{display:flex;gap:16px;overflow-x:auto;padding-bottom:4px}
.bx-face{flex-shrink:0;display:flex;flex-direction:column;align-items:center;gap:6px;font-size:12px;font-weight:600}
.bx-face img{width:64px;height:64px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 2px rgba(255,255,255,.6)}
.bx-looks{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.bx-look{border-radius:12px;padding:10px 12px;text-align:left;background:rgba(255,255,255,.1);
  box-shadow:inset 0 0 0 1px rgba(255,255,255,.15)}
.bx-look b{display:block;font-size:14px;font-weight:600;line-height:1.2}
.bx-look span{display:block;font-size:11px;line-height:1.25;margin-top:2px;color:rgba(255,255,255,.55)}
@keyframes bx-drop{0%{transform:translate(-50%,-160%) scale(1.1);opacity:0}25%{opacity:1}
  80%{transform:translate(-50%,10%) scale(.55);opacity:1}100%{transform:translate(-50%,30%) scale(.4);opacity:0}}
@keyframes bx-glow{0%,100%{box-shadow:0 0 0 0 rgba(255,214,102,0),0 0 18px 4px rgba(255,214,102,.35)}
  50%{box-shadow:0 0 0 6px rgba(255,214,102,.25),0 0 28px 10px rgba(255,214,102,.55)}}
@keyframes bx-count{0%{transform:scale(1.6);opacity:0}20%{transform:scale(1);opacity:1}85%{opacity:1}100%{transform:scale(.9);opacity:0}}
@keyframes bx-flash{0%{opacity:.95}100%{opacity:0}}
@keyframes bx-sheen{from{transform:translateX(-100%)}to{transform:translateX(400%)}}
@keyframes bx-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes bx-rise-x{from{opacity:0;margin-top:8px}to{opacity:1;margin-top:0}}
@media (prefers-reduced-motion:reduce){.bx-root *{animation:none!important;transition:none!important}}
`

// Heroicons outline paths, drawn inline so nothing is fetched.
const ICON = {
  save: 'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3',
  retake: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99',
  era: 'M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5',
  trash: 'M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0',
}

function IconButton({ label, d, onClick, danger = false }: { label: string; d: string; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className={`bx-icon${danger ? ' bx-icon-danger' : ''}`}>
      <svg width="24" height="24" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d={d} />
      </svg>
    </button>
  )
}

export default function BoothExperience(props: Props) {
  const {
    booth, effects, faces, shot, progress, statusText, generating, primaryColor,
    onCaptured, onFallbackCamera, onAccept, onSave, onDiscard, onOriginal, onClose,
    historyKey, onPostImage, onSaveImage, onRemoveUpload, onPostKept, onUnpostKept,
  } = props

  const [vp, setVp] = useState({ w: 390, h: 844 })
  const eras = booth.eras
  const [phase, setPhase] = useState<Phase>(eras.length === 1 ? 'board' : 'picker')
  const [eraKey, setEraKey] = useState<string>(eras[0]!.key)
  const [look, setLook] = useState<BoothLook | null>(null)
  const [pressed, setPressed] = useState<number | null>(null)
  const [cam, setCam] = useState<CamState>('off')
  const [count, setCount] = useState<number | null>(null)
  const [coinDrop, setCoinDrop] = useState(false)
  const [flash, setFlash] = useState(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // The Polaroids: every picture the booth has made on this phone.
  const [pictures, setPictures] = useState<BoothPicture[]>([])
  const [historyLoaded, setHistoryLoaded] = useState(false)
  const [carousel, setCarousel] = useState(false)
  const [slide, setSlide] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [postingId, setPostingId] = useState<string | null>(null)
  // The space the Polaroid actually has, between the top bar and the
  // buttons. Measured, not derived from the screen height: on an iPhone
  // the notch, the home bar and Safari's toolbars take a share the page
  // cannot predict, and a Polaroid sized from the whole screen overlapped
  // both (Dan's phone, 2026-09-22).
  const [trackBox, setTrackBox] = useState<{ w: number; h: number } | null>(null)
  // Safety net: whatever the sums say, measure the Polaroid as drawn and
  // shrink it until it fits the space between the header and the buttons.
  const [fitScale, setFitScale] = useState(1)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const recordedRef = useRef<string | null>(null)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms))
  }, [])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const era = eras.find((e) => e.key === eraKey) ?? eras[0]!
  const interior = era.interior
  const inside = phase === 'inside' || phase === 'to-outside'
  const busy = Boolean(shot?.busy)
  // The camera runs only while there is nothing in the window to look at,
  // and not behind the Polaroids.
  const cameraWanted = inside && !shot && !carousel

  // Fill the screen, whatever the screen does. Measured from the booth's
  // own full-screen box, not window.innerWidth: before a phone settles
  // its viewport, innerWidth can report the unscaled 980px layout width,
  // which drew the board at twice the size of the screen (harness,
  // 2026-09-21). The box is, by construction, exactly what is filled.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    // The VISIBLE area where the browser reports it: anything on the page
    // underneath that is wider than the phone grows the layout viewport,
    // and a fixed box with it, past the edges of the screen.
    const vv = window.visualViewport
    const apply = () => {
      const r = el.getBoundingClientRect()
      const w = vv ? Math.min(vv.width, r.width) : r.width
      const h = vv ? Math.min(vv.height, r.height) : r.height
      if (w > 0 && h > 0) setVp({ w, h })
    }
    apply()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    ro?.observe(el)
    window.addEventListener('resize', apply)
    vv?.addEventListener('resize', apply)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', apply)
      vv?.removeEventListener('resize', apply)
    }
  }, [])

  // A full-screen place should not scroll the page underneath it.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  // Warm every interior while the guest reads the board, so walking in
  // never shows an empty booth loading.
  useEffect(() => {
    for (const e of booth.eras) {
      const img = new window.Image()
      img.src = e.interior.image
    }
  }, [booth])

  // The live camera. Started the first time it is wanted and then kept
  // running until the guest leaves the booth altogether. It used to stop
  // after every photo and start again for the next, and each start makes
  // iOS show its "Camera access allowed" banner over the booth -- which a
  // page cannot suppress, only avoid causing (asked 2026-09-22). The
  // camera light stays on while the booth is open; closing it stops it.
  const streamRef = useRef<MediaStream | null>(null)
  useEffect(() => {
    if (!cameraWanted) return
    const v = videoRef.current
    if (streamRef.current) {
      // Already running: back into the window it goes.
      if (v && v.srcObject !== streamRef.current) v.srcObject = streamRef.current
      v?.play().catch(() => { /* resumes on the next tap */ })
      setCam('live')
      return
    }
    if (!navigator.mediaDevices?.getUserMedia) { setCam('blocked'); return }
    let cancelled = false
    setCam('starting')
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = s
        const el = videoRef.current
        if (el) {
          el.srcObject = s
          el.play().catch(() => { /* autoplay refusals resolve on the next tap */ })
        }
        setCam('live')
      })
      .catch(() => { if (!cancelled) setCam('blocked') })
    return () => { cancelled = true }
  }, [cameraWanted])

  // Off when the booth closes.
  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  // A camera that never starts (a permission prompt dismissed without an
  // answer, a browser that stalls) must not leave the guest with a dead
  // shutter: after a while, offer the camera app instead. A late answer
  // still wins -- the stream promise above sets 'live' whenever it lands.
  useEffect(() => {
    if (cam !== 'starting') return
    const t = setTimeout(() => setCam((c) => (c === 'starting' ? 'blocked' : c)), 8000)
    return () => clearTimeout(t)
  }, [cam])

  const flashNotice = useCallback((text: string) => {
    setNotice(text)
    later(() => setNotice(null), 2600)
  }, [later])

  // Bring back this phone's pictures from earlier in the evening.
  useEffect(() => {
    let cancelled = false
    void loadHistory(historyKey).then((kept) => {
      if (cancelled) return
      // Anything made before the load finished stays, newest first.
      setPictures((now) => kept.reduce((list, p) => (list.some((x) => x.id === p.id) ? list : [...list, p]), now))
      setHistoryLoaded(true)
    })
    return () => { cancelled = true }
  }, [historyKey])

  useEffect(() => {
    if (historyLoaded) void saveHistory(historyKey, pictures)
  }, [pictures, historyLoaded, historyKey])

  // A finished picture goes onto a Polaroid, whatever the guest then does
  // with it -- posted, saved or neither, it is kept. A look that failed
  // keeps the guest's own photo instead, so they are never left with
  // nothing.
  useEffect(() => {
    if (!shot || shot.busy || generating) return
    if (!shot.preview && !shot.error) return
    const signature = `${shot.preview ?? shot.original}|${shot.error ?? ''}`
    if (recordedRef.current === signature) return
    recordedRef.current = signature
    const styled = Boolean(shot.preview)
    setPictures((list) => addPicture(list, {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      image: shot.preview ?? shot.original,
      label: styled ? shot.filterLabel ?? look?.label ?? null : null,
      styled,
      note: styled ? null : 'That look did not work this time, so here is your photo as it was.',
      createdAt: Date.now(),
      posted: false,
      // Kept on the server already: posting flips it on, deleting removes it.
      mediaId: styled ? shot.mediaId ?? null : null,
    }))
    setSlide(0)
    setCarousel(true)
    onDiscard()
  }, [shot, generating, look, onDiscard])

  useEffect(() => {
    if (!carousel) return
    const el = trackRef.current
    if (!el) return
    const apply = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) setTrackBox({ w: el.clientWidth, h: el.clientHeight })
    }
    apply()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(apply) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [carousel])

  useEffect(() => {
    if (!carousel || !trackBox) return
    const fig = trackRef.current?.querySelector('.bx-polaroid') as HTMLElement | null
    if (!fig) return
    const h = fig.offsetHeight
    const w = fig.offsetWidth
    if (!h || !w) return
    // Room for the tilt and the shadow.
    setFitScale(Math.min(1, (trackBox.h - 24) / h, (trackBox.w - 24) / w))
  }, [carousel, trackBox, pictures.length])

  // Open on the newest, without an animated scroll from wherever it was.
  useEffect(() => {
    if (!carousel) return
    const el = trackRef.current
    if (el) el.scrollTo({ left: slide * el.clientWidth, behavior: 'auto' })
    // Only on opening; scrolling itself updates `slide`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [carousel])

  const goTo = useCallback((i: number) => {
    const el = trackRef.current
    if (!el) return
    const n = Math.max(0, Math.min(i, pictures.length - 1))
    el.scrollTo({ left: n * el.clientWidth, behavior: 'smooth' })
  }, [pictures.length])

  const onTrackScroll = useCallback(() => {
    const el = trackRef.current
    if (!el || el.clientWidth === 0) return
    setSlide(Math.round(el.scrollLeft / el.clientWidth))
  }, [])

  const postPicture = useCallback(async (pic: BoothPicture) => {
    if (pic.posted || postingId) return
    setPostingId(pic.id)
    try {
      if (pic.mediaId) {
        // Kept by the server when it was made: just put it on.
        if (!(await onPostKept(pic.mediaId))) throw new Error('post failed')
      } else {
        await onPostImage(pic.image, pic.styled, (mediaId) => {
          setPictures((list) => markPosted(list, pic.id, mediaId))
        })
      }
      setPictures((list) => markPosted(list, pic.id))
      flashNotice('Sent to the big screen')
    } catch {
      flashNotice('That did not send. Try again in a moment.')
    } finally {
      setPostingId(null)
    }
  }, [postingId, onPostImage, onPostKept, flashNotice])

  const unpostPicture = useCallback(async (pic: BoothPicture) => {
    if (!pic.posted || !pic.mediaId || postingId) return
    setPostingId(pic.id)
    try {
      if (!(await onUnpostKept(pic.mediaId))) throw new Error('unpost failed')
      setPictures((list) => markUnposted(list, pic.id))
      flashNotice('Taken off the big screen')
    } catch {
      flashNotice('Could not take it down. Try again in a moment.')
    } finally {
      setPostingId(null)
    }
  }, [postingId, onUnpostKept, flashNotice])

  const savePicture = useCallback((pic: BoothPicture) => {
    if (!onSaveImage(pic.image)) flashNotice('That one would not save. Try again.')
  }, [onSaveImage, flashNotice])

  /**
   * Delete from the carousel and the phone, and -- if it was posted --
   * from the event, which takes it off the big screen too.
   */
  const deletePicture = useCallback(async (pic: BoothPicture) => {
    if (pic.mediaId) {
      const ok = await onRemoveUpload(pic.mediaId)
      if (!ok) {
        setConfirmDelete(null)
        flashNotice('Could not take it off the big screen. Try again.')
        return
      }
    }
    const remaining = pictures.length - 1
    setPictures((list) => removePicture(list, pic.id))
    setConfirmDelete(null)
    setSlide((i) => Math.max(0, Math.min(i, remaining - 1)))
    if (remaining <= 0) setCarousel(false)
    flashNotice(pic.posted ? 'Deleted, and taken off the big screen' : 'Deleted')
    // (A kept picture is removed from the event above whether or not it
    // was ever posted -- deleting means gone.)
  }, [pictures.length, onRemoveUpload, flashNotice])

  /** Walk in. Every visit starts with the live camera and no picture. */
  const enter = useCallback((chosen: BoothLook | null, tileIndex: number | null) => {
    if (phase !== 'board') return
    setPressed(tileIndex)
    setMoreOpen(false)
    setLook(chosen)
    later(() => {
      setPhase('to-inside')
      later(() => {
        setPhase('inside')
        setPressed(null)
      }, ENTER_MS)
    }, 160)
  }, [phase, later])

  /** From the era picker to that era's board of looks. */
  const chooseEra = useCallback((key: string, tileIndex: number | null) => {
    if (phase !== 'picker') return
    setPressed(tileIndex)
    later(() => {
      setEraKey(key)
      setPhase('board')
      setPressed(null)
    }, 180)
  }, [phase, later])

  /**
   * Step outside. The picture goes with it: walking back in, to the same
   * decade or another, is a fresh sitting with the live camera, not the
   * last photo restyled (asked for 2026-09-21 -- a guest choosing a new
   * era expects to be photographed again). Anything they wanted to keep
   * they will already have saved or put on the big screen.
   */
  const leave = useCallback(() => {
    if (busy || count !== null) return
    setPhase('to-outside')
    onDiscard()
    later(() => setPhase('board'), ARRIVE_MS)
  }, [busy, count, later, onDiscard])

  /**
   * "New decade": all the way back to the decade picker, not just to this
   * decade's board of looks. An event with one decade has no picker, so
   * it goes to the board instead.
   */
  const newDecade = useCallback(() => {
    if (busy || count !== null) return
    setCarousel(false)
    const target: Phase = eras.length > 1 ? 'picker' : 'board'
    if (phase === 'inside') {
      setPhase('to-outside')
      onDiscard()
      later(() => setPhase(target), ARRIVE_MS)
    } else {
      setPhase(target)
    }
  }, [busy, count, eras.length, phase, onDiscard, later])

  const capture = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.videoWidth) { onFallbackCamera(look); return }
    const aspect = (interior.window.w * interior.width) / (interior.window.h * interior.height)
    const crop = coverCrop(v.videoWidth, v.videoHeight, aspect)
    const scale = Math.min(1, 1600 / Math.max(crop.sw, crop.sh))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(crop.sw * scale)
    canvas.height = Math.round(crop.sh * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) { onFallbackCamera(look); return }
    // Mirrored, like the preview: the picture should be the one they saw.
    ctx.translate(canvas.width, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(v, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height)
    onCaptured(canvas.toDataURL('image/jpeg', 0.9), look)
  }, [interior, look, onCaptured, onFallbackCamera])

  /** The shutter, and the coin slot, which does the same thing. */
  const insertCoin = useCallback(() => {
    if (count !== null || shot) return
    if (cam === 'blocked') { onFallbackCamera(look); return }
    if (cam !== 'live') return
    // iOS can hold a stream paused until a gesture; this is one.
    videoRef.current?.play().catch(() => {})
    setCoinDrop(true)
    later(() => {
      setCoinDrop(false)
      setCount(COUNT_FROM)
      for (let i = 1; i < COUNT_FROM; i++) later(() => setCount(COUNT_FROM - i), i * COUNT_STEP_MS)
      later(() => {
        setCount(null)
        setFlash((f) => f + 1)
        capture()
      }, COUNT_FROM * COUNT_STEP_MS)
    }, COIN_MS)
  }, [count, shot, cam, look, later, capture, onFallbackCamera])

  const accept = useCallback(() => {
    onAccept()
    flashNotice('Sent to the big screen')
  }, [onAccept, flashNotice])

  // ── Layout ─────────────────────────────────────────────────────────

  const insideBox = stageRect(vp.w, vp.h, interior.width, interior.height, interior.focus_x)

  // Through the curtain: the board swells and darkens, then the interior
  // settles in from slightly too close.
  const outsideStyle = {
    transition: `transform ${ENTER_MS}ms cubic-bezier(.5,0,.75,0), opacity ${ENTER_MS}ms ease-in, filter ${ENTER_MS}ms ease-in`,
    transformOrigin: '12% 55%',
    transform: phase === 'to-inside' ? 'scale(2.4)' : 'scale(1)',
    opacity: phase === 'to-inside' || inside ? 0 : 1,
    filter: phase === 'to-inside' ? 'blur(6px) brightness(.4)' : 'none',
    pointerEvents: phase === 'picker' || phase === 'board' ? 'auto' : 'none',
  } as const
  const insideStyle = {
    transition: `transform ${ARRIVE_MS}ms cubic-bezier(.2,.7,.3,1), opacity ${ARRIVE_MS}ms ease-out`,
    transform: phase === 'inside' ? 'scale(1)' : 'scale(1.08)',
    opacity: phase === 'inside' ? 1 : 0,
    pointerEvents: phase === 'inside' ? 'auto' : 'none',
  } as const

  // "More looks": the reference faces, and any look no era offers.
  const eraLooks = new Set(eras.flatMap((e) => e.looks.map((l) => l.id)))
  const extraEffects = effects.filter((e) => !eraLooks.has(e.id))
  const hasMore = faces.length > 0 || extraEffects.length > 0
  const lookOf = (id: string): BoothLook => {
    const l = era.looks.find((x) => x.id === id)
    return { key: id, payload: { effect: id }, label: l?.label ?? effects.find((e) => e.id === id)?.label ?? id }
  }
  const onPicker = phase === 'picker'

  /** Artwork with tiles on it, laid out to fill the screen. */
  const painted = (art: Painted, labelOf: (key: string) => string, onTap: (key: string, i: number) => void) => (
    <div className="bx-abs" style={stageRect(vp.w, vp.h, art.width, art.height, art.focus_x)}>
      {/* eslint-disable-next-line @next/next/no-img-element -- themed artwork */}
      <img src={art.image} alt="" draggable={false} className="bx-art" />
      {art.tiles.map((t, i) => (
        <button
          key={`${t.key}-${i}`}
          type="button"
          aria-label={labelOf(t.key)}
          onClick={() => onTap(t.key, i)}
          className="bx-tile"
          style={{
            ...pctStyle(t),
            transform: pressed === i ? 'scale(.94)' : 'scale(1)',
            boxShadow: pressed === i ? '0 0 0 3px rgba(255,255,255,.9), 0 0 30px 8px rgba(255,80,200,.6)' : 'none',
          }}
        />
      ))}
    </div>
  )

  /** A board of cards, for when there is no painted artwork. */
  const cards = (
    backdrop: string,
    title: string,
    subtitle: string,
    items: Array<{ key: string; label: string; blurb: string; image: string | null; aria: string }>,
    onTap: (key: string, i: number) => void,
    more = false,
  ) => (
    <div className="bx-screen">
      {/* eslint-disable-next-line @next/next/no-img-element -- themed artwork, blurred */}
      <img src={backdrop} alt="" className="bx-screen-bg" draggable={false} />
      <div className="bx-screen-shade" />
      <div className="bx-screen-body">
        <p className="bx-h1">{title}</p>
        <p className="bx-sub">{subtitle}</p>
        <div className="bx-grid">
          {items.map((it, i) => (
            <button
              key={it.key}
              type="button"
              aria-label={it.aria}
              className={`bx-card${pressed === i ? ' bx-card-pressed' : ''}`}
              onClick={() => onTap(it.key, i)}
            >
              {it.image
                // eslint-disable-next-line @next/next/no-img-element -- sample picture
                ? <img src={it.image} alt="" draggable={false} />
                : <span className="bx-card-blank" />}
              <span className="bx-card-label">
                <b>{it.label}</b>
                <span>{it.blurb}</span>
              </span>
            </button>
          ))}
        </div>
        {/* At the end of the list rather than floating over its last row. */}
        {more && (
          <button type="button" onClick={() => setMoreOpen(true)} className="bx-more-inline bx-glass">
            More looks
          </button>
        )}
      </div>
    </div>
  )
  const result = shot ? shot.preview ?? shot.original : null
  const showControls = Boolean(shot) && !busy && !generating
  const topInset = 'calc(env(safe-area-inset-top, 0px) + 10px)'

  return (
    <div ref={rootRef} className="bx-root" data-event-media-overlay="" role="dialog" aria-modal="true" aria-label="Photo booth">
      <style>{STYLES}</style>

      {/* ── Outside: the era picker, or an era's board of looks ──── */}
      <div className="bx-fill" style={outsideStyle} aria-hidden={inside}>
        {onPicker
          ? booth.picker
            ? painted(booth.picker, (k) => `${eras.find((e) => e.key === k)?.label ?? k} photo booth`, chooseEra)
            : cards(
              eras[0]!.interior.image,
              'Choose your decade',
              'Step into a photo booth from another decade',
              eras.map((e) => ({
                key: e.key, label: e.label, blurb: e.blurb, aria: `${e.label} photo booth`,
                image: e.card ?? e.looks.find((l) => l.sample)?.sample ?? e.interior.image,
              })),
              chooseEra,
            )
          : era.board
            ? painted(era.board, (k) => `${lookOf(k).label} look`, (k, i) => enter(lookOf(k), i))
            : cards(
              era.interior.image,
              era.label,
              'Choose your look',
              era.looks.map((l) => ({ key: l.id, label: l.label, blurb: l.blurb, image: l.sample, aria: `${l.label} look` })),
              (k, i) => enter(lookOf(k), i),
              hasMore,
            )}

        {hasMore && phase === 'board' && era.board && (
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            className="bx-more bx-glass"
            style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 18px)' }}
          >
            More looks
          </button>
        )}
      </div>

      {/* ── Inside ───────────────────────────────────────────────── */}
      <div className="bx-fill" style={insideStyle} aria-hidden={!inside}>
        <div className="bx-abs" style={insideBox}>
          {/* eslint-disable-next-line @next/next/no-img-element -- themed artwork */}
          <img src={interior.image} alt="" draggable={false} className="bx-art" />

          {/* The window: live camera, then the picture developing in it. */}
          <div className="bx-window" style={pctStyle(interior.window)}>
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="bx-media"
              style={{ transform: 'scaleX(-1)', opacity: cam === 'live' && !result ? 1 : 0, transition: 'opacity 300ms' }}
            />

            {result && (
              // eslint-disable-next-line @next/next/no-img-element -- local data URL
              <img
                src={result}
                alt={shot?.filterLabel ? `Your ${shot.filterLabel} photo` : 'Your photo'}
                className="bx-media"
                style={{ filter: busy ? 'grayscale(.6) brightness(.55) blur(2px)' : 'none', transition: 'filter 500ms' }}
              />
            )}

            {!result && cam === 'starting' && <div className="bx-note">Warming up the camera…</div>}
            {!result && cam === 'blocked' && (
              <div className="bx-note">
                <p>The booth can&apos;t see you. Allow the camera for this site, or use your camera app instead.</p>
                <button
                  type="button"
                  onClick={() => onFallbackCamera(look)}
                  className="bx-pill"
                  style={{ backgroundColor: primaryColor }}
                >
                  Open camera
                </button>
              </div>
            )}

            {/* The shutter, where a phone's camera puts it. The coin slot
                does the same, for anyone who reads the instructions. */}
            {!result && count === null && !coinDrop && cam !== 'blocked' && (
              <button
                type="button"
                aria-label="Take the photo"
                onClick={insertCoin}
                disabled={cam !== 'live'}
                className="bx-shutter"
              />
            )}

            {count !== null && <div key={`count-${count}`} className="bx-count">{count}</div>}
            {flash > 0 && <div key={`flash-${flash}`} className="bx-flash" />}

            {(busy || generating) && (
              <div className="bx-dev" aria-live="polite">
                <p key={statusText} className="bx-status">{statusText}</p>
                <div className="bx-bar" role="progressbar" aria-label="Making your picture">
                  <div className="bx-bar-fill" style={{ width: `${progress}%`, backgroundColor: primaryColor }} />
                  {busy && <div className="bx-sheen" />}
                </div>
              </div>
            )}
          </div>

          {/* The coin slot is the shutter. */}
          {!shot && (
            <button
              type="button"
              aria-label="Insert a coin to take the photo"
              onClick={insertCoin}
              disabled={count !== null || cam === 'starting' || cam === 'off'}
              className={`bx-coin${cam === 'live' && count === null ? ' bx-coin-live' : ''}`}
              style={{ ...pctStyle(interior.coin), opacity: 1 }}
            >
              {coinDrop && <span className="bx-coin-drop">£1</span>}
            </button>
          )}

          {/* The machine panel: the controls once there is a picture. It
              covers the coin slot, so it only catches taps when it has
              controls to offer. */}
          <div className="bx-panel" style={pctStyle(interior.panel)}>
            {showControls && (
              <div className="bx-controls bx-glass">
                {shot?.error && <p className="bx-error">{shot.error}</p>}
                <button type="button" onClick={accept} className="bx-primary" style={{ backgroundColor: primaryColor }}>
                  Put it on the big screen
                </button>
                <div className="bx-row">
                  <button type="button" onClick={onSave} className="bx-btn">Save</button>
                  <button type="button" onClick={onDiscard} className="bx-btn">Retake</button>
                  <button type="button" onClick={newDecade} className="bx-btn">New decade</button>
                </div>
                {shot?.preview && (
                  <button type="button" onClick={onOriginal} className="bx-link">Use my original instead</button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Chrome ───────────────────────────────────────────────── */}
      <div className="bx-top" style={{ top: topInset, visibility: carousel ? 'hidden' : 'visible' }}>
        {inside ? (
          <button type="button" onClick={leave} disabled={busy || count !== null} className="bx-pill bx-glass">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Step outside
          </button>
        ) : phase === 'board' && eras.length > 1 ? (
          <button type="button" onClick={() => setPhase('picker')} className="bx-pill bx-glass" aria-label="Choose another decade">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
            Decades
          </button>
        ) : (
          <button type="button" onClick={onClose} disabled={busy} className="bx-pill bx-glass" aria-label="Leave the photo booth">
            <svg width="16" height="16" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
            Close
          </button>
        )}
        <span className="bx-top-right">
          {/* The era, which is also the way to change it: back out to the
              board of looks. */}
          {inside && look && (
            <button
              type="button"
              onClick={leave}
              disabled={busy || count !== null}
              className="bx-pill bx-glass"
              aria-label={`${look.label} — choose another look`}
            >
              {look.label}
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
              </svg>
            </button>
          )}
          {pictures.length > 0 && !busy && count === null && (
            <button type="button" onClick={() => { setSlide(0); setCarousel(true) }} className="bx-pill bx-glass" aria-label="My photos">
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0021.75 19.5V4.5A1.5 1.5 0 0020.25 3H3.75A1.5 1.5 0 002.25 4.5v15A1.5 1.5 0 003.75 21z" />
              </svg>
              {pictures.length}
            </button>
          )}
        </span>
      </div>

      {notice && (
        <div className="bx-toast bx-glass" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 62px)' }} role="status">
          {notice}
        </div>
      )}

      {/* ── The Polaroids ────────────────────────────────────────── */}
      {carousel && pictures.length > 0 && (() => {
        const room = inside ? interior : null
        const backdrop = room ? room.image : onPicker && booth.picker ? booth.picker.image : era.interior.image
        const aspect = room
          ? (room.window.w * room.width) / (room.window.h * room.height)
          : 0.72
        // Sized to the measured gap, with a little air for the tilt and
        // the shadow; until it is measured, a cautious guess.
        const pol = trackBox
          ? polaroidSize(trackBox.w, trackBox.h, aspect, 56)
          : polaroidSize(vp.w, vp.h, aspect, 380)
        const current = pictures[Math.min(slide, pictures.length - 1)]!
        const confirming = confirmDelete ? pictures.find((p) => p.id === confirmDelete) ?? null : null
        return (
          <div className="bx-car" role="region" aria-label="Your booth photos">
            {/* eslint-disable-next-line @next/next/no-img-element -- themed artwork, blurred */}
            <img src={backdrop} alt="" className="bx-car-bg" draggable={false} />
            <div className="bx-car-shade" />

            <div className="bx-top" style={{ top: topInset }}>
              <button type="button" onClick={() => setCarousel(false)} className="bx-pill bx-glass">
                <svg width="16" height="16" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
                </svg>
                {inside ? 'Back to the booth' : 'Back'}
              </button>
            </div>

            <div ref={trackRef} className="bx-track" onScroll={onTrackScroll}>
              {pictures.map((p, i) => (
                <div key={p.id} className="bx-slide" aria-hidden={i !== slide}>
                  <figure
                    className="bx-polaroid"
                    style={{
                      width: pol.frameW,
                      // No bottom padding: the caption below the photo IS the
                      // deep bottom border. Counting it twice made every
                      // Polaroid a quarter of its width too tall, which ran
                      // it under the header and buttons (2026-09-22).
                      padding: `${pol.side}px ${pol.side}px 0`,
                      transform: `rotate(${((i % 3) - 1) * 1.1}deg) scale(${fitScale})`,
                    }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
                    <img src={p.image} alt={p.label ? `Your ${p.label} photo` : 'Your photo'} style={{ width: pol.photoW, height: pol.photoH }} />
                    <figcaption style={{ height: pol.bottom }}>
                      {p.label && <span className="bx-hand">{p.label}</span>}
                      {p.note && <span className="bx-note-line">{p.note}</span>}
                      {p.posted && <span className="bx-posted">On the big screen</span>}
                    </figcaption>
                  </figure>
                </div>
              ))}
            </div>

            {slide > 0 && (
              <button type="button" className="bx-arrow bx-glass" style={{ left: 12 }} onClick={() => goTo(slide - 1)} aria-label="Newer photo">
                <svg width="22" height="22" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" /></svg>
              </button>
            )}
            {slide < pictures.length - 1 && (
              <button type="button" className="bx-arrow bx-glass" style={{ right: 12 }} onClick={() => goTo(slide + 1)} aria-label="Older photo">
                <svg width="22" height="22" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" /></svg>
              </button>
            )}

            <div className="bx-car-foot" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}>
              <p className="bx-counter">{Math.min(slide, pictures.length - 1) + 1} / {pictures.length}</p>
              {pictures.length <= 12 && (
                <div className="bx-dots">
                  {pictures.map((p, i) => (
                    <button key={p.id} type="button" className={`bx-dot${i === slide ? ' bx-dot-on' : ''}`} onClick={() => goTo(i)} aria-label={`Photo ${i + 1}`} />
                  ))}
                </div>
              )}
              {current.posted ? (
                // Unmistakably on, and just as easy to take off again.
                <div className="bx-live" role="status">
                  <span className="bx-live-dot" aria-hidden="true" />
                  <span className="bx-live-text">On the big screen</span>
                  {current.mediaId && (
                    <button
                      type="button"
                      className="bx-live-remove"
                      disabled={postingId === current.id}
                      onClick={() => unpostPicture(current)}
                    >
                      {postingId === current.id ? 'Removing…' : 'Remove'}
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  className="bx-primary"
                  style={{ backgroundColor: primaryColor }}
                  disabled={postingId === current.id}
                  onClick={() => postPicture(current)}
                >
                  {postingId === current.id ? 'Sending…' : 'Put it on the big screen'}
                </button>
              )}
              <div className="bx-icons">
                <IconButton label="Save to my phone" onClick={() => savePicture(current)} d={ICON.save} />
                {inside && <IconButton label="Retake" onClick={() => setCarousel(false)} d={ICON.retake} />}
                <IconButton label="New decade" onClick={newDecade} d={ICON.era} />
                <IconButton label="Delete" danger onClick={() => setConfirmDelete(current.id)} d={ICON.trash} />
              </div>
            </div>

            {confirming && (
              <div className="bx-sheet-wrap" onClick={() => setConfirmDelete(null)}>
                <div className="bx-scrim" />
                <div className="bx-sheet bx-glass" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)' }} onClick={(e) => e.stopPropagation()}>
                  <p className="bx-confirm-title">Delete this photo?</p>
                  <p className="bx-confirm-body">
                    {confirming.posted
                      ? 'It will be removed from your phone and taken off the big screen.'
                      : confirming.mediaId
                        ? 'It will be removed from your phone and from the event.'
                        : 'It will be removed from your phone.'}
                  </p>
                  <button type="button" className="bx-primary bx-danger" onClick={() => deletePicture(confirming)}>Delete</button>
                  <button type="button" className="bx-btn" onClick={() => setConfirmDelete(null)}>Keep it</button>
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* ── More looks: the faces, and any look not on the board ──── */}
      {moreOpen && (
        <div className="bx-sheet-wrap" onClick={() => setMoreOpen(false)}>
          <div className="bx-scrim" />
          <div
            className="bx-sheet bx-glass"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bx-grip" />
            {faces.length > 0 && (
              <div className="bx-faces">
                {faces.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => enter({
                      key: `filter:${f.id}`, payload: { filter_id: f.id }, label: `Be ${f.label}`,
                    }, null)}
                    className="bx-face"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- reference face */}
                    <img src={f.preview} alt="" />
                    Be {f.label}
                  </button>
                ))}
              </div>
            )}
            {extraEffects.length > 0 && (
              <div className="bx-looks">
                {extraEffects.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => enter({ key: e.id, payload: { effect: e.id }, label: e.label }, null)}
                    className="bx-look"
                  >
                    <b>{e.label}</b>
                    <span>{e.blurb}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
