/**
 * Deterministic counting + grouping for the buzzword leaderboard.
 *
 * The recipe extracts granular phrases; this module decides how they are
 * grouped and displayed on the board. Kept pure (no I/O) so it is testable
 * and never depends on the model doing arithmetic.
 *
 * Leaderboard policy (per product):
 *   1. Lower-case everything (the canonical is already lowercased).
 *   2. GROUP similar phrases: a phrase collapses into a shorter phrase that
 *      is its leading-word base — e.g. "harness engineering" → "harness"
 *      when bare "harness" was also submitted. Grouping only ever collapses
 *      toward a base form that people actually submitted, so it can't invent
 *      a root nobody wrote.
 *   3. Count once per GROUP per reply (a reply repeating a phrase, or
 *      submitting two phrases that group together, counts once).
 *   4. Display each group Title-Cased ("loop engineering" → "Loop
 *      Engineering"), preserving well-known acronyms ("mcp" → "MCP").
 */

import type {
  ExtractedPhrase,
  LeaderboardEntry,
  ReplyBuzzwordStamp,
  ReplyExtraction,
} from './types.js';

/** Acronyms kept upper-cased in the Title-Cased display form. */
const ACRONYMS = new Set([
  'ai', 'ml', 'mcp', 'rag', 'llm', 'llms', 'adlc', 'api', 'apis',
  'sdk', 'ui', 'ux', 'sql', 'gpu', 'cpu', 'rl', 'nlp', 'agi',
]);

/** Normalise a canonical for grouping: lowercased, whitespace-collapsed. */
export function normCanonical(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Capitalise a single token, upper-casing known acronyms whole. */
function capToken(token: string): string {
  if (!token) return token;
  if (ACRONYMS.has(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * Title-case a grouped phrase, keeping known acronyms upper-cased and
 * capitalising each part of a hyphenated compound ("multi-agent" →
 * "Multi-Agent", "load-bearing" → "Load-Bearing").
 */
export function titleCaseDisplay(canonical: string): string {
  return canonical
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.split('-').map(capToken).join('-'))
    .join(' ');
}

/** True when `base` tokens are a leading prefix of `phrase` tokens. */
function isLeadingBase(base: string[], phrase: string[]): boolean {
  if (base.length >= phrase.length) return false;
  return base.every((t, i) => t === phrase[i]);
}

/**
 * Map every canonical to its group representative. A phrase joins the
 * shortest existing phrase that is a leading-word base of it; otherwise it
 * starts its own group. Processing shortest-first guarantees representatives
 * are always real (submitted) base forms.
 */
export function groupCanonicals(canonicals: Iterable<string>): Map<string, string> {
  const uniq = [...new Set([...canonicals].map(normCanonical))].filter(Boolean);
  // Shortest (fewest words, then chars, then alpha) first so bases win.
  uniq.sort((a, b) => {
    const wa = a.split(' ').length;
    const wb = b.split(' ').length;
    return wa - wb || a.length - b.length || a.localeCompare(b);
  });

  const reps: string[] = [];
  const repTokens: string[][] = [];
  const map = new Map<string, string>();

  for (const c of uniq) {
    const tokens = c.split(' ');
    // Attach to the most specific (longest) existing base that leads this phrase.
    let chosen = -1;
    for (let i = 0; i < reps.length; i++) {
      if (isLeadingBase(repTokens[i], tokens)) {
        if (chosen === -1 || repTokens[i].length > repTokens[chosen].length) chosen = i;
      }
    }
    if (chosen === -1) {
      reps.push(c);
      repTokens.push(tokens);
      map.set(c, c);
    } else {
      map.set(c, reps[chosen]);
    }
  }
  return map;
}

/**
 * Convert a recipe extraction into the stamp we persist on the reply — both
 * the idempotency marker and the source of truth the board is tallied from.
 */
export function extractionToStamp(
  extraction: ReplyExtraction,
  runId: string,
  appliedAt: string,
): ReplyBuzzwordStamp {
  return {
    status: extraction.status,
    run_id: runId,
    ...(extraction.phrases ? { phrases: extraction.phrases } : {}),
    ...(extraction.note ? { note: extraction.note } : {}),
    applied_at: appliedAt,
  };
}

/** All normalised canonicals a single reply submitted (deduped). */
function replyCanonicals(phrases: ExtractedPhrase[]): string[] {
  const seen = new Set<string>();
  for (const p of phrases) {
    const c = normCanonical(p.canonical);
    if (c) seen.add(c);
  }
  return [...seen];
}

/**
 * Build the leaderboard from every applied reply's stamp. Only 'extracted'
 * stamps contribute. Phrases are grouped, then counted once per group per
 * reply. Rows sort by count desc, then display A→Z for stable ordering.
 */
export function buildLeaderboard(stamps: ReplyBuzzwordStamp[]): LeaderboardEntry[] {
  const extracted = stamps.filter((s) => s.status === 'extracted' && s.phrases && s.phrases.length > 0);

  // Pass 1: collect the global canonical set and group it.
  const allCanonicals = new Set<string>();
  for (const s of extracted) for (const c of replyCanonicals(s.phrases!)) allCanonicals.add(c);
  const groupOf = groupCanonicals(allCanonicals);

  // Pass 2: count once per group per reply.
  const counts = new Map<string, number>();
  for (const s of extracted) {
    const reps = new Set<string>();
    for (const c of replyCanonicals(s.phrases!)) reps.add(groupOf.get(c) ?? c);
    for (const rep of reps) counts.set(rep, (counts.get(rep) ?? 0) + 1);
  }

  const entries: LeaderboardEntry[] = [];
  for (const [canonical, count] of counts) {
    entries.push({ canonical, display: titleCaseDisplay(canonical), count });
  }
  entries.sort((a, b) => b.count - a.count || a.display.localeCompare(b.display));
  return entries;
}

/**
 * The current group representatives to feed the NEXT batch as
 * `known_phrases`, so the recipe reuses existing canonicals.
 */
export function knownPhrasesParam(
  board: LeaderboardEntry[],
): Array<{ canonical: string; display: string; count: number }> {
  return board.map((e) => ({ canonical: e.canonical, display: e.display, count: e.count }));
}
