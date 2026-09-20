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
 * guest's name, and nine per-show logotypes for free.
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

/** Per-show logotypes. Font stacks only — a webfont fetch that fails at
 *  a venue would leave the title unstyled or invisible. */
const GENRE_STYLE: Record<string, React.CSSProperties> = {
  horror: {
    fontFamily: '"Times New Roman", Georgia, serif', fontWeight: 700,
    color: '#d81f1f', letterSpacing: '.05em', textTransform: 'uppercase',
    textShadow: '0 0 28px rgba(216,31,31,.55)',
  },
  comedy: {
    fontFamily: '"Arial Rounded MT Bold", "Helvetica Neue", sans-serif', fontWeight: 800,
    color: '#ffd21f', letterSpacing: '-.01em', textTransform: 'uppercase',
    textShadow: '0 .07em 0 #c78b00',
  },
  thriller: {
    fontFamily: '"Helvetica Neue", Helvetica, sans-serif', fontWeight: 300,
    color: '#fff', letterSpacing: '.36em', textTransform: 'uppercase',
  },
  eighties: {
    fontFamily: '"Helvetica Neue", Helvetica, sans-serif', fontWeight: 900,
    fontStyle: 'italic', textTransform: 'uppercase', letterSpacing: '-.01em',
    background: 'linear-gradient(180deg,#fff 0%,#ffe9a8 42%,#c9962e 52%,#fff6cf 100%)',
    WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent',
    filter: 'drop-shadow(0 3px 2px rgba(0,0,0,.6))',
  },
  doc: {
    fontFamily: 'Georgia, "Times New Roman", serif', fontWeight: 400,
    color: '#f2f2f2', letterSpacing: '.26em', textTransform: 'uppercase',
  },
  romance: {
    fontFamily: '"Snell Roundhand", "Apple Chancery", cursive', color: '#ffd9e2',
  },
  scifi: {
    fontFamily: 'Futura, "Century Gothic", "Helvetica Neue", sans-serif', fontWeight: 700,
    color: '#8fe8ff', letterSpacing: '.26em', textTransform: 'uppercase',
    textShadow: '0 0 22px rgba(80,200,255,.8)',
  },
  crime: {
    fontFamily: '"Courier New", monospace', fontWeight: 700, color: '#e8e8e8',
    letterSpacing: '.12em', textTransform: 'uppercase',
  },
  epic: {
    fontFamily: 'Impact, Haettenschweiler, "Arial Narrow", sans-serif',
    color: '#fff', letterSpacing: '.02em', textTransform: 'uppercase',
    textShadow: '0 3px 18px rgba(0,0,0,.8)',
  },
}

/** Longer titles step down so they never wrap past two lines. */
function titleSize(title: string): string {
  const n = title.length
  if (n <= 14) return 'clamp(44px, 5.4vw, 104px)'
  if (n <= 22) return 'clamp(36px, 4.4vw, 84px)'
  return 'clamp(28px, 3.4vw, 66px)'
}

export default function WedflixCard({ copy, slideKey, showRank = false }: Props) {
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
            ...enter(0),
            color: '#e2231a', fontWeight: 800, textTransform: 'uppercase',
            letterSpacing: '.005em', fontSize: 'clamp(15px, 1.6vw, 30px)',
            transform: `${shown ? 'translateY(0)' : 'translateY(14px)'} scaleY(1.3) scaleX(.94)`,
            transformOrigin: 'left bottom', marginBottom: '1.1em',
            textShadow: '0 .05em .09em rgba(0,0,0,.6)',
          }}
        >
          Wedflix
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

        <div style={{ ...style, ...enter(220), fontSize: titleSize(copy.title), lineHeight: 1.02 }}>
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

      <div
        style={{
          ...enter(0), position: 'absolute', right: '4.5%', bottom: '6.5%',
          color: '#e2231a', fontWeight: 800, textTransform: 'uppercase',
          letterSpacing: '.005em', fontSize: 'clamp(20px, 2.3vw, 46px)',
          transform: `${shown ? 'translateY(0)' : 'translateY(14px)'} scaleY(1.3) scaleX(.94)`,
          transformOrigin: 'right bottom',
          textShadow: '0 .05em .09em rgba(0,0,0,.6)',
        }}
      >
        Wedflix
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
