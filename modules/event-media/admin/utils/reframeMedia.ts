/**
 * Putting a photograph into the shape a camera would have given it.
 *
 * Two ways, both from lib/framing.ts:
 *
 *   crop     take about a ninth off the width of a phone portrait. No
 *            model, no cost, nothing invented.
 *   expand   add the same amount instead, with a model drawing what lies
 *            outside the frame.
 *
 * The second is only allowed near photographs of real guests because of
 * what `laidOver` does: the original is drawn back on top of whatever
 * came back, at the offset it was expanded from. A generated pixel
 * cannot end up inside the original frame -- not because the model was
 * asked not to, but because it is painted over. That is a guarantee
 * about geometry rather than about a model's behaviour, which is the
 * only kind worth having on somebody's wedding photographs.
 */
import { CLASSIC, classicFor, cropTo, expandTo, worthReframing, type Box } from '../../lib/framing';

/** What an album asked for. */
export type FrameMode = 'as-shot' | 'classic' | 'expand';

/** A frame of pixels, as a canvas hands them out. */
export interface Frame { data: Uint8ClampedArray; w: number; h: number }

function frameFrom(canvas: HTMLCanvasElement): Frame {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data: d.data, w: canvas.width, h: canvas.height };
}

function canvasOf(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function put(frame: Frame): HTMLCanvasElement {
  const c = canvasOf(frame.w, frame.h);
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(frame.w, frame.h);
  img.data.set(frame.data);
  ctx.putImageData(img, 0, 0);
  return c;
}

/** The shape this photograph should be, or null to leave it alone. */
export function shapeFor(w: number, h: number): number | null {
  const want = classicFor(w, h);
  if (want === CLASSIC.square) return null;
  return worthReframing(w, h, want) ? want : null;
}

/** The photograph cropped to that shape. Nothing invented. */
export function cropped(frame: Frame, ratio: number): Frame {
  const box: Box = cropTo(frame.w, frame.h, ratio);
  if (box.w === frame.w && box.h === frame.h) return frame;
  const src = put(frame);
  const out = canvasOf(box.w, box.h);
  out.getContext('2d')!.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return frameFrom(out);
}

/** What the model should be asked to add, in pixels per side. */
export function marginsFor(w: number, h: number, ratio: number): {
  left: number; right: number; top: number; bottom: number;
  canvas: { w: number; h: number }; at: { x: number; y: number };
} | null {
  const { box, at } = expandTo(w, h, ratio);
  if (box.w === w && box.h === h) return null;
  return {
    left: at.x, right: box.w - w - at.x,
    top: at.y, bottom: box.h - h - at.y,
    canvas: { w: box.w, h: box.h }, at,
  };
}

/**
 * The expanded copy with the original laid back over it.
 *
 * `drawn` is what the model returned, at whatever size it returned it;
 * it is scaled to the canvas that was asked for, and then the original
 * is painted on top at the offset it was expanded from. Everything
 * inside the original frame is therefore the original, exactly.
 */
export function laidOver(
  original: Frame,
  drawn: HTMLImageElement,
  canvas: { w: number; h: number },
  at: { x: number; y: number },
): Frame {
  const out = canvasOf(canvas.w, canvas.h);
  const ctx = out.getContext('2d')!;
  // Whatever size came back, it represents this canvas.
  ctx.drawImage(drawn, 0, 0, canvas.w, canvas.h);
  ctx.drawImage(put(original), at.x, at.y);
  return frameFrom(out);
}
