'use client'

// @ts-nocheck — portal deps are resolved at build time via webpack alias

/**
 * The browse-screen overlay: a spoof streaming card laid over the
 * photo, which the cinematic renderer is moving underneath.
 *
 * Everything here is DOM, deliberately. The obvious alternative was to
 * have the image model draw the titles, and that was tried — it
 * produces typos ("diplomaciy"), invents cast names, and cannot be
 * corrected. Rendering text as HTML gives pixel-crisp type, the real
 * guest's name, and a per-show logotype for free.
 *
 * Each programme gets its own title treatment, the way a real service
 * gives every show its own logo. The style is chosen by the copy
 * generator from the tone of the title it wrote.
 */

import { useEffect, useRef, useState } from 'react'

export interface CardCopy {
  title: string
  words: string[]
  kind: string
  genre: string
  eyebrow: string
}

interface Props {
  copy: CardCopy
  /** Changes when the slide does, so the text can re-animate. */
  slideKey: string
  /** Roughly one card in three carries a chart position. */
  showRank?: boolean
}

/**
 * Per-show logotypes, one display face each, so consecutive cards do not
 * arrive looking like the same programme.
 *
 * These are Google Fonts. An earlier version used system stacks to avoid
 * depending on a font fetch at the venue, but that reasoning does not
 * hold: the display cannot show a single photograph without the network
 * either, so a webfont is no more fragile than the picture under it.
 * Every entry still ends in a real system fallback, so a blocked fetch
 * degrades to a plain face rather than to invisible text.
 */
const FONTS: Array<[string, string]> = [
  ['Creepster', ''], ['Bungee', ''], ['Oswald', ':wght@200;500'],
  ['Monoton', ''], ['Playfair+Display', ':ital,wght@0,600;1,600'],
  ['Parisienne', ''], ['Orbitron', ':wght@700'], ['Special+Elite', ''],
  ['Cinzel', ':wght@900'], ['Abril+Fatface', ''], ['Lobster', ''],
  ['Anton', ''], ['Rye', ''], ['Bebas+Neue', ''],
]

const GENRE_STYLE: Record<string, React.CSSProperties> = {
  horror: {
    fontFamily: '"Creepster", Impact, fantasy', color: '#d81f1f',
    letterSpacing: '.04em', textShadow: '0 0 30px rgba(216,31,31,.6)',
  },
  comedy: {
    fontFamily: '"Bungee", Impact, sans-serif', color: '#ffd21f',
    letterSpacing: '-.01em', textShadow: '0 .06em 0 #c78b00',
  },
  thriller: {
    fontFamily: '"Oswald", "Helvetica Neue", sans-serif', fontWeight: 200,
    color: '#fff', letterSpacing: '.38em', textTransform: 'uppercase',
  },
  eighties: {
    // Monoton is already striped, so the chrome gradient reads as the
    // airbrushed logos it is imitating.
    fontFamily: '"Monoton", Impact, sans-serif', textTransform: 'uppercase',
    background: 'linear-gradient(180deg,#fff 0%,#ffe9a8 42%,#c9962e 52%,#fff6cf 100%)',
    WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
    filter: 'drop-shadow(0 3px 2px rgba(0,0,0,.7))',
  },
  doc: {
    fontFamily: '"Playfair Display", Georgia, serif', fontWeight: 600,
    color: '#f2f2f2', letterSpacing: '.2em', textTransform: 'uppercase',
  },
  romance: {
    fontFamily: '"Parisienne", "Snell Roundhand", cursive', color: '#ffd9e2',
  },
  scifi: {
    fontFamily: '"Orbitron", Futura, sans-serif', fontWeight: 700,
    color: '#8fe8ff', letterSpacing: '.22em', textTransform: 'uppercase',
    textShadow: '0 0 24px rgba(80,200,255,.85)',
  },
  crime: {
    fontFamily: '"Special Elite", "Courier New", monospace', color: '#e8e8e8',
    letterSpacing: '.08em', textTransform: 'uppercase',
  },
  epic: {
    fontFamily: '"Cinzel", Georgia, serif', fontWeight: 900, color: '#fff',
    letterSpacing: '.06em', textTransform: 'uppercase',
    textShadow: '0 3px 20px rgba(0,0,0,.85)',
  },
  noir: {
    fontFamily: '"Abril Fatface", Georgia, serif', color: '#f5f0e6',
    letterSpacing: '.01em', textShadow: '0 4px 20px rgba(0,0,0,.9)',
  },
  musical: {
    fontFamily: '"Lobster", "Brush Script MT", cursive', color: '#ff7ab8',
    textShadow: '0 0 26px rgba(255,122,184,.5)',
  },
  reality: {
    fontFamily: '"Anton", Impact, sans-serif', color: '#fff',
    letterSpacing: '.02em', textTransform: 'uppercase',
    textShadow: '0 3px 16px rgba(0,0,0,.8)',
  },
  western: {
    fontFamily: '"Rye", Georgia, serif', color: '#e7c98a',
    letterSpacing: '.02em', textTransform: 'uppercase',
    textShadow: '0 3px 14px rgba(0,0,0,.8)',
  },
  heist: {
    fontFamily: '"Bebas Neue", Impact, sans-serif', color: '#fff',
    letterSpacing: '.09em', textTransform: 'uppercase',
    textShadow: '0 3px 16px rgba(0,0,0,.8)',
  },
}

/**
 * Display faces differ enormously in cap height, so a single font size
 * makes Creepster tower over Oswald. These nudge each back to roughly
 * the same optical weight on screen.
 */
const GENRE_SCALE: Record<string, number> = {
  horror: 1.15, comedy: 0.88, thriller: 0.92, eighties: 0.82,
  doc: 0.9, romance: 1.35, scifi: 0.82, crime: 0.95,
  epic: 0.95, noir: 1.0, musical: 1.2, reality: 1.05,
  western: 0.9, heist: 1.15,
}

/**
 * The Wedflix wordmark, drawn rather than set.
 *
 * It was faked in CSS before — a bold sans squeezed with
 * `scaleY(1.3) scaleX(.94)` — which only ever approximated the real
 * letterforms. This is the actual artwork, inlined rather than fetched
 * so it cannot fail to load at the venue and needs no asset hosting.
 *
 * Sized by height; the width follows the 1694:472 aspect.
 */
function Wordmark({ height }: { height: string }) {
  return (
    <svg
      viewBox="239 125 1694 472"
      role="img"
      aria-label="Wedflix"
      style={{ height, width: 'auto', display: 'block' }}
    >
      <path
        fill="#e8121c"
        fillRule="evenodd"
        d="M1689,126 1763,348 1684,553 1766,566 1804,450 1843,577 1930,596 1846,351 1932,127 1847,127 1808,246 1772,127Z M1567,126 1567,541 1645,550 1645,126Z M1350,126 1350,521 1525,537 1525,466 1428,457 1428,126Z M1303,126 1129,126 1129,514 1209,517 1209,359 1284,358 1284,287 1209,286 1209,197 1303,196Z M879,125 877,514 997,516 1019,514 1040,508 1061,495 1073,481 1081,465 1087,442 1088,218 1081,176 1071,158 1060,146 1049,138 1027,129 1003,125Z M958,196 993,197 1005,206 1009,218 1009,426 1005,437 991,446 957,445Z M649,125 649,533 832,519 833,452 727,456 727,358 803,356 803,287 727,286 727,196 832,195 833,126Z M239,125 303,593 387,572 423,347 457,563 545,546 611,125 534,125 500,383 464,125 383,125 347,381 315,125Z"
      />
    </svg>
  )
}

/** One stylesheet for every logotype, injected once per page. */
function useLogotypeFonts(): void {
  useEffect(() => {
    const ID = 'wedflix-logotypes'
    if (document.getElementById(ID)) return
    for (const host of ['https://fonts.googleapis.com', 'https://fonts.gstatic.com']) {
      const pre = document.createElement('link')
      pre.rel = 'preconnect'
      pre.href = host
      if (host.includes('gstatic')) pre.crossOrigin = 'anonymous'
      document.head.appendChild(pre)
    }
    const link = document.createElement('link')
    link.id = ID
    link.rel = 'stylesheet'
    // display=swap shows the fallback immediately rather than blank text
    // while a face loads, which matters on a slideshow that never waits.
    link.href = 'https://fonts.googleapis.com/css2?' +
      FONTS.map(([f, w]) => `family=${f}${w}`).join('&') + '&display=swap'
    document.head.appendChild(link)
  }, [])
}

/** Longer titles step down so they never wrap past two lines. */
function titleSize(title: string, scale: number): string {
  const n = title.length
  const [min, vw, max] = n <= 14 ? [44, 5.4, 104]
    : n <= 22 ? [36, 4.4, 84]
      : [28, 3.4, 66]
  const r = (v: number) => Math.round(v * scale * 10) / 10
  return `clamp(${r(min)}px, ${r(vw)}vw, ${r(max)}px)`
}

export default function WedflixCard({ copy, slideKey, showRank = false }: Props) {
  useLogotypeFonts()
  // Re-run the entrance animation on every slide without remounting the
  // renderer underneath.
  const [shown, setShown] = useState(false)
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  useEffect(() => {
    setShown(false)
    timers.current.forEach(clearTimeout)
    timers.current = [setTimeout(() => setShown(true), 260)]
    return () => timers.current.forEach(clearTimeout)
  }, [slideKey])

  const style = GENRE_STYLE[copy.genre] ?? GENRE_STYLE['doc']!
  const scale = GENRE_SCALE[copy.genre] ?? 1
  const enter = (delay: number): React.CSSProperties => ({
    opacity: shown ? 1 : 0,
    transform: shown ? 'translateY(0)' : 'translateY(14px)',
    transition: `opacity 700ms ease ${delay}ms, transform 700ms cubic-bezier(.2,.7,.3,1) ${delay}ms`,
  })

  return (
    <div className="absolute inset-0 pointer-events-none select-none">
      {/* Legibility scrim: dark to the left and along the bottom, clear
          over the middle so it never veils a face. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to right, rgba(0,0,0,.86) 0%, rgba(0,0,0,.55) 30%, rgba(0,0,0,0) 60%),' +
            'linear-gradient(to top, rgba(0,0,0,.78) 0%, rgba(0,0,0,0) 36%)',
        }}
      />

      <div className="absolute" style={{ left: '5%', bottom: '13%', maxWidth: '48%' }}>
        <div
          style={{
            ...enter(0), marginBottom: '1.1em',
            filter: 'drop-shadow(0 .05em .09em rgba(0,0,0,.6))',
          }}
        >
          <Wordmark height="clamp(17px, 1.85vw, 34px)" />
        </div>

        {copy.eyebrow && (
          <div
            style={{
              ...enter(120),
              color: 'rgba(255,255,255,.82)', textTransform: 'uppercase',
              letterSpacing: '.4em', fontSize: 'clamp(11px, 1.15vw, 24px)',
              marginBottom: '.5em',
            }}
          >
            {copy.eyebrow}
          </div>
        )}

        <div style={{ ...style, ...enter(220), fontSize: titleSize(copy.title, scale), lineHeight: 1.06 }}>
          {copy.title}
        </div>

        <div
          style={{
            ...enter(420),
            marginTop: '.8em', color: 'rgba(255,255,255,.92)',
            fontSize: 'clamp(13px, 1.25vw, 25px)',
          }}
        >
          {copy.words.map((w, i) => (
            <span key={w + i}>
              {i > 0 && <span style={{ opacity: .6, margin: '0 .6em' }}>•</span>}
              {w}
            </span>
          ))}
        </div>

        {showRank && (
          <div
            style={{
              ...enter(600), marginTop: '.9em', display: 'flex',
              alignItems: 'center', gap: '.6em',
              color: '#fff', fontSize: 'clamp(12px, 1.2vw, 24px)',
            }}
          >
            <span
              style={{
                background: '#e2231a', fontWeight: 800, borderRadius: 3,
                padding: '.25em .4em', lineHeight: 1.05, textAlign: 'center',
                fontSize: '.62em',
              }}
            >
              TOP<br />10
            </span>
            <span>No. {(hashRank(slideKey) % 9) + 2} in {copy.kind} Today</span>
          </div>
        )}
      </div>

      {/* Wordmark, bottom right — where a streaming service signs off.
          The upload QR moved to the top right to leave it this corner. */}
      <div
        style={{
          ...enter(0), position: 'absolute', right: '4.5%', bottom: '6.5%',
          filter: 'drop-shadow(0 .05em .09em rgba(0,0,0,.6))',
        }}
      >
        <Wordmark height="clamp(23px, 2.6vw, 52px)" />
      </div>
    </div>
  )
}

/** Stable pseudo-random rank per photo, so it does not flicker. */
function hashRank(key: string): number {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0
  return Math.abs(h)
}
