/**
 * Who uploaded a photo, when the event has an invitation list.
 *
 * Instead of typing any name, a guest picks themselves from the people
 * who accepted their invitation: they type a couple of letters and
 * choose from the matches ("da" -> Dan, David). Every upload and booth
 * picture then carries that invitation member's id, which is what lets an
 * organiser block one guest -- their uploads refused, their photos off the
 * projector -- without touching anyone else's.
 *
 * This is identification, not authentication: nothing stops a guest
 * picking someone else's name. It gives every photo an owner an organiser
 * can act on; it does not prove who holds the phone.
 *
 * The search runs on the server over the accepted list, and hands back a
 * handful of matches for at least two letters -- never the whole list.
 */

export interface GuestEntry {
  id: string;
  name: string;
}

export const GUEST_QUERY_MIN = 2;
export const GUEST_MATCH_LIMIT = 8;

/** Lower-case, accents off, single spaces: "Zoë  O'Neill" -> "zoe o'neill". */
export function foldName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function displayName(first: unknown, last: unknown): string | null {
  const f = typeof first === 'string' ? first.trim() : '';
  const l = typeof last === 'string' ? last.trim() : '';
  const name = `${f} ${l}`.trim().replace(/\s+/g, ' ');
  return name ? name.slice(0, 80) : null;
}

/**
 * Matches for what the guest has typed: a name matches when the whole
 * name, or any word in it, starts with the query -- "da" finds Dan and
 * David, "bak" finds Dan Baker, "dan b" finds Dan Baker. First names that
 * match come first, then alphabetical.
 */
export function matchGuests(list: readonly GuestEntry[], query: unknown, limit: number = GUEST_MATCH_LIMIT): GuestEntry[] {
  if (typeof query !== 'string') return [];
  const q = foldName(query).slice(0, 60);
  if (q.length < GUEST_QUERY_MIN) return [];
  const scored: Array<{ g: GuestEntry; rank: number; folded: string }> = [];
  for (const g of list) {
    const folded = foldName(g.name);
    let rank = -1;
    if (folded.startsWith(q)) rank = 0;
    else if (folded.split(/[ -]/).some((w) => w.startsWith(q))) rank = 1;
    if (rank >= 0) scored.push({ g, rank, folded });
  }
  scored.sort((a, b) => a.rank - b.rank || a.folded.localeCompare(b.folded));
  return scored.slice(0, Math.max(1, limit)).map((s) => s.g);
}
