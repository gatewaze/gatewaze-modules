/**
 * The thumbnail artboard: one HTML/CSS description used in two places.
 *
 * The admin renders it live in the browser while the editor picks a frame
 * and a headline; the worker renders the very same markup in Chromium at
 * 1280x720 when the editor approves. Keeping one source for the layout is
 * what makes "what you see is what you get" true, so this file has no
 * imports and no Node API: it is plain strings and numbers that both the
 * Vite bundle and the worker can load.
 *
 * Sizes are container-query units (cqw) against the `.art` box, so the
 * same CSS lays out at 420px in a sidebar and at 1280px in the render.
 */

export interface ArtboardSelection {
  /** Speaker scale, 0.7 to 1.5 (1 = the cut-out at its natural size). */
  scale: number;
  /** Where the speaker's centre sits across the frame, 0.4 to 0.85. */
  x: number;
  lead: string;
  emph: string;
  /** Show the slide panels behind the speaker. */
  panels: boolean;
}

export const DEFAULT_SELECTION: ArtboardSelection = { scale: 1, x: 0.62, lead: '', emph: '', panels: true };

export const ARTBOARD_WIDTH = 1280;
export const ARTBOARD_HEIGHT = 720;

/** Clamp an editor's numbers to the ranges the layout was designed for. */
export function clampSelection(sel: Partial<ArtboardSelection>): ArtboardSelection {
  const n = (v: unknown, lo: number, hi: number, d: number) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    scale: n(sel.scale, 0.7, 1.5, 1),
    x: n(sel.x, 0.4, 0.85, 0.62),
    lead: String(sel.lead ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
    emph: String(sel.emph ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
    panels: sel.panels !== false,
  };
}

export const ARTBOARD_CSS = `
.art { position: relative; aspect-ratio: 16 / 9; width: 100%; max-width: 100%; overflow: hidden;
  container-type: inline-size; background: #0b0a10; user-select: none; }
.art .bgd { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; max-width: none; }
.art .tint { position: absolute; inset: 0; background: rgba(8,6,14,.28); }
.art .card { position: absolute; aspect-ratio: 16 / 9; object-fit: cover; max-width: none;
  border-radius: 1.1cqw; box-shadow: 0 1.2cqw 3.6cqw rgba(0,0,0,.6); filter: saturate(.85) brightness(.82); }
.art .card.a { left: 2.5%; top: 6%; width: 50%; }
.art .card.b { right: 2.5%; top: 11%; width: 46%; filter: saturate(.8) brightness(.7); }
.art .card.solo { left: 50%; top: 5%; width: 62%; transform: translateX(-50%); }
.art .cut { position: absolute; left: 0; top: 0; width: 100%; height: 100%; max-width: none;
  object-fit: contain; transform-origin: 50% 100%;
  filter: brightness(1.14) contrast(1.1) saturate(1.06) drop-shadow(0 .8cqw 2.4cqw rgba(0,0,0,.7)); }
.art .scrim { position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,0) 26%, rgba(0,0,0,0) 44%, rgba(0,0,0,.42) 66%, rgba(0,0,0,.74) 100%); }
.art .txt { position: absolute; left: 4%; right: 4%; bottom: 4.5%; color: #fff;
  font-family: "Archivo", "Arial Black", Impact, sans-serif;
  text-shadow: 0 .4cqw 1.6cqw rgba(0,0,0,.75); display: grid; grid-template-columns: minmax(0, 1fr); gap: .6cqw; }
.art .txt > * { min-width: 0; }
.art .lead { font-weight: 500; font-size: 6cqw; line-height: 1.02; letter-spacing: -.01em; text-wrap: balance; }
.art .emph { font-weight: 900; font-size: 14cqw; line-height: .88; letter-spacing: -.025em; text-transform: uppercase; white-space: normal; text-wrap: balance; }
.art .brand { position: absolute; left: 0; top: 0; z-index: 2; background: #000;
  padding: 1.3cqw 2cqw 1.2cqw 2.4cqw; border-bottom-right-radius: 1.6cqw; }
.art .brand img { display: block; width: 16cqw; height: auto; max-width: none; }
.art .mark { position: absolute; z-index: 2; top: 30%; max-width: 30%; height: 9cqw; width: auto;
  filter: brightness(0) invert(1) drop-shadow(0 .5cqw 1.4cqw rgba(0,0,0,.7)); opacity: .96; object-fit: contain; }
.art .mark.name { height: auto; font-family: "Archivo", "Arial Black", Impact, sans-serif; font-weight: 700; font-size: 4cqw; letter-spacing: .06em;
  text-transform: uppercase; color: #fff; filter: drop-shadow(0 .4cqw 1.2cqw rgba(0,0,0,.7)); top: 32%; }
.art .mark.l { left: 4.5%; } .art .mark.r { right: 4.5%; }
.art .mark.tr { top: 6%; right: 4%; height: 7cqw; }
`;

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export interface ArtboardInput {
  /** URLs or data URIs. */
  backgroundSrc: string;
  logoSrc: string;
  cutSrc: string | null;
  panelSrcs: string[];
  /** The company mark: an image, or a name set in type. */
  markSrc?: string | null;
  markName?: string | null;
  /** Cut-out bounds as fractions of the frame, for placing the mark away from the speaker. */
  cutBounds?: [number, number, number, number] | null;
  selection: ArtboardSelection;
}

/** Where the company mark goes: top right over a wide figure, else the side away from the speaker. */
export function markPosition(sel: ArtboardSelection, cutBounds?: [number, number, number, number] | null): 'tr' | 'l' | 'r' {
  if (cutBounds && cutBounds[2] - cutBounds[0] > 0.6) return 'tr';
  return sel.x > 0.5 ? 'l' : 'r';
}

export function cutTransform(sel: ArtboardSelection): string {
  return `translateX(${((sel.x - 0.5) * 100).toFixed(2)}%) scale(${sel.scale.toFixed(3)})`;
}

/** The artboard's inner markup. The caller wraps it in a sized box and the CSS. */
export function artboardHtml(input: ArtboardInput): string {
  const sel = clampSelection(input.selection);
  const panels = sel.panels ? input.panelSrcs.filter(Boolean) : [];
  const panelHtml = panels.length >= 2
    ? `<img class="card b" src="${escapeHtml(panels[1])}" alt=""><img class="card a" src="${escapeHtml(panels[0])}" alt="">`
    : panels.length === 1 ? `<img class="card solo" src="${escapeHtml(panels[0])}" alt="">` : '';
  const pos = markPosition(sel, input.cutBounds);
  const mark = input.markSrc
    ? `<img class="mark ${pos}" src="${escapeHtml(input.markSrc)}" alt="">`
    : input.markName ? `<span class="mark name ${pos}">${escapeHtml(input.markName)}</span>` : '';
  return `<div class="art">
  <img class="bgd" src="${escapeHtml(input.backgroundSrc)}" alt="">
  <div class="tint"></div>
  ${panelHtml}
  ${input.cutSrc ? `<img class="cut" src="${escapeHtml(input.cutSrc)}" alt="" style="transform:${cutTransform(sel)}">` : ''}
  <div class="scrim"></div>
  <div class="txt"><span class="lead">${escapeHtml(sel.lead)}</span><span class="emph">${escapeHtml(sel.emph)}</span></div>
  <span class="brand"><img src="${escapeHtml(input.logoSrc)}" alt=""></span>
  ${mark}
</div>`;
}

/** A whole page for Chromium: fonts as data URIs, the board at render size. */
export function artboardPage(input: ArtboardInput, fonts: { archivo: string }): string {
  return `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: "Archivo"; font-style: normal; font-weight: 100 900; src: url("${fonts.archivo}") format("woff2"); }
html, body { margin: 0; background: #000; }
#board { width: ${ARTBOARD_WIDTH}px; height: ${ARTBOARD_HEIGHT}px; overflow: hidden; }
${ARTBOARD_CSS}
</style><div id="board">${artboardHtml(input)}</div>`;
}
