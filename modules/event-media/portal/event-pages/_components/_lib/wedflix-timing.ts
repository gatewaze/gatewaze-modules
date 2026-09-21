/**
 * When each part of a Wedflix card appears and disappears.
 *
 * The photograph arrives first, already moving. Then, one beat at a
 * time, a second apart:
 *
 *   title  the Wedflix mark, the eyebrow and the programme title
 *   words  the three-word description
 *   rank   the Top 10 flag, on the cards that carry one
 *
 * They leave in the opposite order and faster -- half a second apart --
 * finishing exactly as the slide ends, so the next photograph arrives
 * to a clean frame.
 */

export type Beat = 'title' | 'words' | 'rank'

export interface WedflixSchedule {
  /** When each beat starts to fade in, ms from the start of the slide. */
  in: Partial<Record<Beat, number>>
  /** When each beat starts to fade out. */
  out: Partial<Record<Beat, number>>
  inFadeMs: number
  outFadeMs: number
}

/** Let the photograph and its movement establish before any text. */
const FIRST_MS = 1000
/** Between beats on the way in. */
const IN_STEP_MS = 1000
const IN_FADE_MS = 700
/** Between beats on the way out: quicker than the way in. */
const OUT_STEP_MS = 500
const OUT_FADE_MS = 400
/** The least time the whole card should sit complete and readable. */
const HOLD_MIN_MS = 1000

export function wedflixSchedule(durationMs: number, hasRank: boolean): WedflixSchedule {
  const beats: Beat[] = hasRank ? ['title', 'words', 'rank'] : ['title', 'words']
  const n = beats.length
  const needed = FIRST_MS + (n - 1) * IN_STEP_MS + IN_FADE_MS
    + HOLD_MIN_MS
    + (n - 1) * OUT_STEP_MS + OUT_FADE_MS

  // A short slide cannot fit the full sequence. Compress every interval in
  // proportion rather than let the way out begin before the way in has
  // finished, which would flicker text on and straight off again.
  const d = Math.max(0, durationMs)
  const k = d >= needed ? 1 : d / needed

  const first = FIRST_MS * k
  const inStep = IN_STEP_MS * k
  const inFade = IN_FADE_MS * k
  const outStep = OUT_STEP_MS * k
  const outFade = OUT_FADE_MS * k

  const schedule: WedflixSchedule = { in: {}, out: {}, inFadeMs: inFade, outFadeMs: outFade }
  beats.forEach((beat, i) => {
    schedule.in[beat] = first + i * inStep
    // Reverse order out: the last beat in is the first beat out, and the
    // title leaves last, its fade ending as the slide does.
    schedule.out[beat] = d - outFade - i * outStep
  })
  return schedule
}
