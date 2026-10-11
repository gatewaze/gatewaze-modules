/**
 * How dark it is in front of the booth, and what to do about it.
 *
 * The booth's room at the wedding was very dark, and a dark selfie makes
 * a poor likeness: the model has less to work with, and what it has is
 * mostly sensor noise (reported 2026-09-28). Three things happen here,
 * all of them decided from the pixels rather than guessed at.
 *
 * WHY A BRIGHT SCREEN HELPS, AND WHAT IT DOES NOT DO. Holding the phone's
 * own screen white will not make the photograph brighter -- the camera
 * meters the new light and turns itself down, so the picture comes back
 * at much the same brightness. That is the point. The same brightness
 * backed by more light means the camera can drop its gain, and a frame at
 * low gain carries real detail where a frame at high gain carries grain.
 * It is the detail the model is short of, not the brightness.
 *
 * It is also worth being honest about the size of it: a phone screen at
 * arm's length is worth about a stop of extra light on a face, and
 * nothing at all from a metre away. The web cannot turn the backlight up
 * -- no browser ships an API for it and WebKit has formally objected to
 * the idea -- so a phone that has dimmed itself in a dark room stays
 * dimmed. This helps; it is not a flashgun.
 *
 * Deliberately pure and deliberately separate from lib/enhance.ts, whose
 * shape some of this borrows: a portal page must not import from the
 * module's lib/ at runtime. The bounds here are much wider than the ones
 * there, because this lifts a throwaway picture on its way to a model
 * rather than somebody's photograph on its way to a wall.
 */

/** What one look at the camera saw. */
export interface LightReading {
  /** Trimmed mean brightness of the middle of the frame, 0-255. */
  centre: number
  /** ...and of the whole of it, which a lamp behind them can flatter. */
  whole: number
}

export type LightLevel = 'fine' | 'dim' | 'dark'

/**
 * Where the line falls between a room that is fine and one that is not.
 *
 * A well-lit face sits around 110-160. These are a starting point rather
 * than a measurement: they want calibrating against the booth's own
 * pictures and the exposure the enhancement asked each one for. Named,
 * exported and tested so that calibration is one line.
 */
export const DIM_BELOW = 70
export const DARK_BELOW = 45

/** Rec. 709 luma, on the gamma-encoded bytes a canvas hands over. */
export function lumaAt(data: Uint8ClampedArray, i: number): number {
  return 0.2126 * data[i]! + 0.7152 * data[i + 1]! + 0.0722 * data[i + 2]!
}

/**
 * The average brightness of part of a frame, with the brightest and
 * darkest tenth left out.
 *
 * Trimmed because one candle, one doorway or one phone screen in shot
 * drags a plain mean a long way -- and it is the face this is about, not
 * the room's brightest object.
 */
export function regionLuma(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  box: { x: number; y: number; w: number; h: number },
): number {
  const values: number[] = []
  const x0 = Math.max(0, Math.floor(box.x))
  const y0 = Math.max(0, Math.floor(box.y))
  const x1 = Math.min(width, Math.ceil(box.x + box.w))
  const y1 = Math.min(height, Math.ceil(box.y + box.h))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) values.push(lumaAt(data, (y * width + x) * 4))
  }
  if (values.length === 0) return 128
  values.sort((a, b) => a - b)
  const cut = Math.floor(values.length / 10)
  const kept = values.length > 20 ? values.slice(cut, values.length - cut) : values
  return kept.reduce((n, v) => n + v, 0) / kept.length
}

/** The whole frame, and the middle of it where a face is. */
export function readFrame(data: Uint8ClampedArray, width: number, height: number): LightReading {
  const whole = regionLuma(data, width, height, { x: 0, y: 0, w: width, h: height })
  const centre = regionLuma(data, width, height, {
    x: width * 0.25, y: height * 0.2, w: width * 0.5, h: height * 0.6,
  })
  return { centre, whole }
}

/**
 * How dark it is, judged on the middle of the frame.
 *
 * The middle, not the whole: a dim room with a bright doorway behind
 * gives a perfectly respectable average while the face is in shadow, and
 * it is the face the model has to work from.
 */
export function lightLevel(reading: LightReading): LightLevel {
  if (reading.centre < DARK_BELOW) return 'dark'
  if (reading.centre < DIM_BELOW) return 'dim'
  return 'fine'
}

export interface FlashPlan {
  on: boolean
  /** Warm rather than pure white: a panel at 6500K against tungsten
   *  hands the camera two colour temperatures and it picks badly. */
  colour: string
  /** Scaled to how dark it is: a room a stop under does not want all of it. */
  alpha: number
  /** Hold at least this long before even looking, for the pipeline. */
  minHoldMs: number
  /** ...and give up waiting after this, so the booth never hangs. */
  maxHoldMs: number
  /** Two readings this close together count as settled. */
  settleDelta: number
}

export const FLASH_COLOUR = '#fff1e2'

/**
 * Whether to light the screen for this one, and how brightly.
 *
 * A room that is fine gets nothing: a flash nobody needed is worse than
 * no flash at all, and this is the guard that has to hold.
 */
export function flashPlan(reading: LightReading): FlashPlan {
  const level = lightLevel(reading)
  const off: FlashPlan = {
    on: false, colour: FLASH_COLOUR, alpha: 0, minHoldMs: 0, maxHoldMs: 0, settleDelta: 0,
  }
  if (level === 'fine') return off
  return {
    on: true,
    colour: FLASH_COLOUR,
    // A room only a stop under blows out at full brightness, which costs
    // the likeness in the other direction.
    alpha: level === 'dark' ? 1 : 0.7,
    // Nothing useful before the camera pipeline has turned over a few
    // frames; the danger window is the middle, part-adapted and with the
    // white balance halfway between the room and the screen.
    minHoldMs: 250,
    maxHoldMs: 1200,
    settleDelta: 2.5,
  }
}

/**
 * Has the camera finished re-metering?
 *
 * The web gives no way to ask, so this watches instead: when two
 * readings in a row agree, the camera has stopped moving. A series still
 * climbing, or one overshooting and coming back, is not settled -- and
 * grabbing the frame there is the one outcome worse than not flashing.
 */
export function hasSettled(recent: readonly number[], delta: number): boolean {
  if (recent.length < 2) return false
  const [a, b] = [recent[recent.length - 2]!, recent[recent.length - 1]!]
  return Math.abs(a - b) <= delta
}

/** What a face should average out at, once it is lit. */
const TARGET = 118
/** The most this will add on its own, in levels out of 255. */
const MAX_OFFSET = 70
/** ...and the most it will multiply by, which is where noise lives. */
const MAX_GAIN = 1.6

/**
 * The lift to put through the captured frame before it is encoded.
 *
 * On the canvas, before toDataURL, and that placement is the whole value
 * of it: a JPEG quantises a near-black frame's facial texture to nothing,
 * and no amount of work afterwards brings it back. Lifting first spreads
 * the face over enough code values for the encoder to keep it.
 *
 * It recovers no light -- the photons were never there -- so it is
 * bounded: past these, a dark frame only gets louder.
 */
export function liftFor(reading: LightReading): { multiplier: number; offset: number } {
  const level = lightLevel(reading)
  if (level === 'fine') return { multiplier: 1, offset: 0 }
  const want = TARGET - reading.centre
  // Half from an offset, half from a gain: an offset alone flattens the
  // blacks, a gain alone pulls the noise up with everything else.
  const offset = Math.min(MAX_OFFSET, Math.max(0, want * 0.5))
  const after = reading.centre + offset
  const multiplier = after > 0
    ? Math.min(MAX_GAIN, Math.max(1, TARGET / after))
    : 1
  return { multiplier: Number(multiplier.toFixed(3)), offset: Number(offset.toFixed(1)) }
}

/**
 * Something to tell the guest, or nothing.
 *
 * Only where it can still help: if the screen has already been lit and
 * the frame is still dark, the room is the problem and moving is the
 * only thing left that works.
 */
export function guidanceFor(reading: LightReading, flashed: boolean): string | null {
  const level = lightLevel(reading)
  if (level === 'fine') return null
  if (!flashed) return 'It is dark in here — the screen will light up for the photo.'
  return level === 'dark'
    ? 'Still very dark. Try standing nearer a light.'
    : null
}
