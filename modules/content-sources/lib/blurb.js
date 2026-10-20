/**
 * Blurb rules for the compact digest line, ported from the harvest's
 * render.py (entry_blurb / one_sentence / _BOILER / _JUNK / _RELEASE).
 *
 * A blurb is the first sentence of the excerpt (at least 40 characters, else
 * the whole excerpt), capped at 150 characters. There is no blurb when it
 * would repeat the title, when it matches a junk pattern (feed footers,
 * author-bio openers, table-of-contents dumps) or when the title is a plain
 * version release ("Node.js 26.9.0 (Current)").
 */

import { stripHtml, MAX_FIELD_CHARS } from './feed-parser.js';

export const BLURB_LIMIT = 150;

const RELEASE = /(\bv?\d+\.\d+(\.\d+)?\b.*\b(release|released|announcing|current|lts)\b|\b(release|released|announcing)\b.*\bv?\d+\.\d+(\.\d+)?\b|\bends on\b)/i;

const BOILER = [
  /^(Agentic AI Foundation( New York City)?( · Agentic AI Foundation & Linux Foundation)?\s+)+/,
  /^(Highlights|Why we did this at all|Overview|Introduction|Why [A-Z][\w ]+\?|TL;DR|Scope)\s+/,
  /^Download this case study in PDF version\s+(Overview\s+)?/,
  /^[A-Z][\w.-]+ [A-Z][\w.-]+ Co-founder[^.]*?\bBy /,
];

const JUNK = /(appeared first on|All BlogsBlogs|Table of contents|^\w+ \w+ \w+ is the |^[A-Z]\w+ [A-Z]\w+ [A-Z]\w+ is |^[A-Z]\w+ [A-Z]\w+ (VP|Head|Executive Director) of )/i;

/** Tags out, entities decoded (the common five plus numeric), whitespace collapsed, boilerplate prefixes removed. */
export function cleanText(s) {
  // Linear: the tag class excludes '<' so an unclosed tag ends at the next
  // one, and stripHtml decodes entities exactly once (after tags are gone).
  let t = stripHtml(String(s ?? '').slice(0, MAX_FIELD_CHARS));
  for (const re of BOILER) t = t.replace(re, '');
  return t;
}

/** First sentence, with the 40/150 rules. */
export function oneSentence(s, limit = BLURB_LIMIT) {
  const t = cleanText(s);
  if (!t) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  let sent = m && m[1].length >= 40 ? m[1] : t;
  if (sent.length > limit) {
    sent = sent.slice(0, limit);
    const cut = sent.lastIndexOf(' ');
    if (cut > 0) sent = sent.slice(0, cut);
    sent = sent.replace(/[,;:]+$/, '') + '…';
  }
  return sent;
}

const core = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** True when the title is a plain version-release line and wants no blurb. */
export function isReleaseTitle(title) {
  return RELEASE.test(String(title ?? ''));
}

/**
 * The blurb for an entry, or '' when none should be shown.
 * @param {{title: string, excerpt?: string|null}} entry
 * @param {string} [fallbackDescription] og:description or meta description
 */
export function entryBlurb(entry, fallbackDescription) {
  const title = String(entry?.title ?? '');
  if (isReleaseTitle(title)) return '';
  const src = (entry?.excerpt ?? '').trim() || (fallbackDescription ?? '').trim();
  const b = oneSentence(src);
  if (!b || JUNK.test(b)) return '';
  const titleCore = core(title.split(' - Agentic')[0]).slice(0, 40);
  if (titleCore && core(b).startsWith(titleCore) && b.length < title.length + 30) return '';
  return b;
}

/** The feed summary truncated for storage as blog_posts.excerpt (220 chars, word boundary). */
export function excerptForStorage(summary, max = 220) {
  const t = stripHtml(String(summary ?? '').slice(0, MAX_FIELD_CHARS));
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > 0 ? cut.slice(0, sp) : cut) + '…';
}
