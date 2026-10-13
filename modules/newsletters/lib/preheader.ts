/**
 * Set the inbox preview text (preheader) on already-rendered email HTML.
 *
 * The preheader reaches the inbox only as a hidden block at the top of the
 * body, which react-email's <Preview> emits at render time (EditionEmail
 * renders it only when the preheader is non-empty). A broadcast's HTML is
 * rendered when its content is saved, but its preheader is edited separately
 * in Email details, so a preheader added after the content never reached the
 * email. This rewrites the block to match the current preheader: it removes
 * any existing preview block and inserts one built exactly like <Preview>
 * (same hidden styles, same 150-character cap and whitespace padding).
 *
 * Pure string work, no DOM: the preview text is HTML-escaped, so the block
 * contains no nested tags beyond its padding div and a regex can match it.
 */

const PREVIEW_MAX_LENGTH = 150;
// The characters react-email pads with so clients don't pull body text into the preview.
const WHITESPACE_CODES = ' ‌​‍‎‏﻿';
const PREVIEW_STYLE = 'display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0';
// <div ...data-skip-in-text="true"...>escaped text<div>padding</div></div>
const PREVIEW_BLOCK_RX = /<div\b[^>]*\bdata-skip-in-text="true"[^>]*>[^<]*(?:<div>[^<]*<\/div>)?<\/div>/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

export function previewBlock(preheader: string): string {
  const text = preheader.slice(0, PREVIEW_MAX_LENGTH);
  const padding = text.length < PREVIEW_MAX_LENGTH ? `<div>${WHITESPACE_CODES.repeat(PREVIEW_MAX_LENGTH - text.length)}</div>` : '';
  return `<div style="${PREVIEW_STYLE}" data-skip-in-text="true">${escapeHtml(text)}${padding}</div>`;
}

/**
 * Return `html` with its preview block set to `preheader`. A blank preheader
 * removes the block (the send gate stops such a send anyway). HTML without a
 * <body> tag gets the block prepended.
 */
export function applyPreheader(html: string, preheader: string | null | undefined): string {
  const stripped = html.replace(PREVIEW_BLOCK_RX, '');
  const text = (preheader ?? '').trim();
  if (!text) return stripped;
  const block = previewBlock(text);
  const body = /<body\b[^>]*>/i.exec(stripped);
  if (!body) return block + stripped;
  const at = body.index + body[0].length;
  return stripped.slice(0, at) + block + stripped.slice(at);
}
