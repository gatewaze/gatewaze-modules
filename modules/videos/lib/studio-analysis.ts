/**
 * The decisions of the studio's analysis pass, without the I/O.
 *
 * What is a composite frame and where its slide and camera panels are; which
 * frames are worth a model call; which scored frame makes the best speaker
 * cut-out; which cut-outs pass Dan's three rules; which slides are panels.
 * The worker feeds these functions numbers and the model's answers and acts
 * on what comes back, so every threshold is in one file and under test.
 */

import type { FrameStats, Box } from './studio-pixels.js';

export type Layout = 'strip' | 'overlay' | null;

/** Source-pixel boxes at 1920x1080 for the two AAIF composite layouts. */
export const LAYOUTS: Record<'strip' | 'overlay', { slide: [number, number, number, number]; camera: [number, number, number, number] }> = {
  // The YouTube render: camera left, slide right, bright sponsor strip.
  strip: { slide: [648, 84, 1242, 753], camera: [31, 84, 616, 756] },
  // The stream: camera panel left, slide right, dark ticker along the bottom.
  overlay: { slide: [503, 130, 1369, 756], camera: [0, 130, 502, 756] },
};

/** Which composite layout a frame is in, or null for a plain camera shot. */
export function layoutOf(st: FrameStats): Layout {
  if (st.bottom > 190) return 'strip';
  // The slide's bottom edge against the ticker is the reliable overlay
  // signal (bright above, dark below); the vertical edge sits in a dark
  // margin and only confirms.
  if (st.h_in - st.h_out > 100 && (Math.abs(st.v_in - st.v_out) > 35 || st.h_in > 150)) return 'overlay';
  if (Math.abs(st.s_v_in - st.s_v_out) > 35 && Math.abs(st.s_h_in - st.s_h_out) > 35) return 'strip';
  return null;
}

/** n items spread evenly over a list, in the list's order. */
export function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]);
}

export interface SampledFrame { t: number; stats: FrameStats }

export interface CandidatePlan {
  /** Frames to ask the vision model about as speaker shots. */
  speaker: number[];
  /** Frames to ask about as slides. */
  slide: number[];
  /** The speaker is judged on the camera panel of a composite, not a wide shot. */
  cameraOnly: boolean;
  /** Share of frames in the stream overlay. */
  overlayShare: number;
  layouts: Record<number, Layout>;
}

/**
 * Which frames to spend model calls on. Twelve speaker candidates, ten
 * slide candidates, chosen by sharpness and spread over the talk.
 */
export function planCandidates(frames: SampledFrame[], opts: { preferCamera?: boolean } = {}): CandidatePlan {
  const layouts: Record<number, Layout> = {};
  for (const f of frames) layouts[f.t] = layoutOf(f.stats);
  const composite = frames.filter((f) => layouts[f.t]);
  const plain = frames.filter((f) => !layouts[f.t]);
  const bySharp = (a: SampledFrame, b: SampledFrame) => b.stats.sharp - a.stats.sharp;
  const overlayShare = frames.length ? composite.filter((f) => layouts[f.t] === 'overlay').length / frames.length : 0;
  const cameraOnly = plain.length === 0 || opts.preferCamera === true || overlayShare > 0.3;
  const speaker = cameraOnly
    ? spread([...composite].sort(bySharp).slice(0, 30).sort((a, b) => a.t - b.t), 12)
    : spread([...plain].sort(bySharp).slice(0, 40).sort((a, b) => a.t - b.t), 12);
  const slideSource = composite.length ? composite : frames;
  const slide = spread([...slideSource].sort(bySharp).slice(0, 30).sort((a, b) => a.t - b.t), 10);
  return { speaker: speaker.map((f) => f.t), slide: slide.map((f) => f.t), cameraOnly, overlayShare, layouts };
}

export interface SpeakerScore {
  kind?: string; face?: number; pose?: number; glare?: number; size?: string; lectern?: boolean; note?: string;
}

/** Rank the scored speaker frames: clear face, animated pose, no glare; tie on sharpness. */
export function rankSpeakerFrames(
  scored: Array<{ t: number; score: SpeakerScore; sharp: number }>,
): Array<{ t: number; score: SpeakerScore; sharp: number }> {
  const speakers = scored.filter((s) => s.score.kind === 'speaker');
  let pool = speakers.filter((s) => s.score.size !== 'small');
  if (!pool.length) pool = speakers;
  const value = (s: SpeakerScore) => (Number(s.face) || 0) * 0.5 + (Number(s.pose) || 0) * 0.3 + (10 - (Number(s.glare) || 0)) * 0.2;
  return [...pool].sort((a, b) => (value(b.score) - value(a.score)) || (b.sharp - a.sharp));
}

export interface SlideScore { kind?: string; legible?: number; interest?: number; note?: string; person?: boolean }

/** Slide candidates worth cropping at full resolution, best first. */
export function rankSlideFrames(scored: Array<{ t: number; score: SlideScore }>): Array<{ t: number; score: SlideScore }> {
  return scored
    .filter((s) => (s.score.kind === 'slide' || s.score.kind === 'code') && (Number(s.score.legible) || 0) >= 5)
    .sort((a, b) => ((Number(b.score.interest) || 0) + (Number(b.score.legible) || 0)) - ((Number(a.score.interest) || 0) + (Number(a.score.legible) || 0)));
}

/** A panel at full resolution: nobody in it, a slide or code, legible and interesting. */
export function panelPasses(v: SlideScore): boolean {
  return !v.person && (v.kind === 'slide' || v.kind === 'code') && (Number(v.legible) || 0) >= 6 && (Number(v.interest) || 0) >= 5;
}

export interface CutGate { bbox: Box | null; glare: number; screen: number }

export const CUT_MIN_HEIGHT = 0.5;
export const CUT_MIN_WIDTH = 0.08;
export const CUT_MAX_GLARE = 0.10;
export const CUT_MAX_SCREEN = 0.35;

/** Dan's rules for a usable cut-out: a close shot, no projector on the face, no screen behind the head. */
export function cutPasses(c: CutGate, width = 1920, height = 1080): boolean {
  return isCloseShot(c.bbox, width, height) && c.glare <= CUT_MAX_GLARE && c.screen <= CUT_MAX_SCREEN;
}

/** The figure fills at least half the frame's height and is not a sliver. */
export function isCloseShot(bb: Box | null, width = 1920, height = 1080): boolean {
  if (!bb) return false;
  return (bb.y1 - bb.y0) / height >= CUT_MIN_HEIGHT && (bb.x1 - bb.x0) / width >= CUT_MIN_WIDTH;
}

/** Among cut-outs that fail the gates, the least bad to show flagged. */
export function leastBad<T extends CutGate>(cuts: T[], width = 1920, height = 1080): T | null {
  const close = cuts.filter((c) => isCloseShot(c.bbox, width, height));
  if (!close.length) return null;
  return close.reduce((best, c) => (c.glare * 2 + c.screen < best.glare * 2 + best.screen ? c : best));
}

/**
 * When fewer than three cut-outs pass, more candidates come from the frames
 * with the least near-white (the projector showing something dark, or the
 * speaker standing clear of the screen), skipping composites and frames
 * already tried.
 */
export function lowGlareCandidates(frames: SampledFrame[], layouts: Record<number, Layout>, tried: Set<number>, n = 12): number[] {
  const plain = frames.filter((f) => !layouts[f.t] && !tried.has(f.t));
  const pool = plain.length ? plain : frames.filter((f) => !tried.has(f.t));
  return [...pool].sort((a, b) => a.stats.white - b.stats.white).slice(0, n).map((f) => f.t);
}

/** The camera-panel crop for a composite frame, scaled to the source size. */
export function cameraCrop(layout: Layout, width: number): [number, number, number, number] | null {
  if (!layout) return null;
  const k = width / 1920;
  return LAYOUTS[layout].camera.map((v) => Math.round(v * k)) as [number, number, number, number];
}

export function slideCrop(layout: Layout, width: number): [number, number, number, number] | null {
  if (!layout) return null;
  const k = width / 1920;
  return LAYOUTS[layout].slide.map((v) => Math.round(v * k)) as [number, number, number, number];
}

export const SPEAKER_RUBRIC = 'Answer ONLY JSON: {"kind":"speaker"|"slide"|"audience"|"other","face":0-10,"pose":0-10,"glare":0-10,"size":"small"|"medium"|"large","lectern":true|false,"note":"<8 words"}. '
  + 'kind=speaker when one presenter is the main subject (not a wide audience shot, not a composite with a slide). '
  + 'face: how clearly the face is visible and sharp. pose: how animated or expressive the gesture is. '
  + 'glare: how much the face or head is washed out by projector light or overlaps a bright white screen (0 none, 10 unusable). '
  + 'size: how much of the frame height the person fills (small under a third, large over two thirds). '
  + 'lectern: a lectern or podium directly in front of them.';

export const SLIDE_RUBRIC = 'Answer ONLY JSON: {"kind":"slide"|"code"|"speaker"|"other","legible":0-10,"interest":0-10,"note":"<8 words"}. '
  + 'kind=slide for a presentation slide with no person visible, code for on-screen code or a terminal, speaker if any person is visible. '
  + 'legible: readability of the slide text. interest: would it grab attention as a thumbnail background (diagrams, code, bold claims high; title, blank, sponsor slides low).';

export const PANEL_VERIFY_RUBRIC = 'Answer ONLY JSON: {"person":true|false,"kind":"slide"|"code"|"photo"|"other","legible":0-10,"interest":0-10,"note":"<8 words"}. '
  + 'person is true if ANY human being, face or body is visible anywhere, even small or partial. kind=slide for presentation content, code for code or a terminal.';
