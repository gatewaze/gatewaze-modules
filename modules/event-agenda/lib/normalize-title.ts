/**
 * Session-title normalisation (spec-event-agenda-schedule-import §7.1).
 *
 * One implementation shared by the schedule importer and by conference-recap's
 * video↔entry matching, because both sides compare the same two populations:
 * sched `SUMMARY` strings and YouTube video titles. Both carry a trailing
 * "- Name, Role, Company" suffix and both use "Keynote:" style prefixes, so a
 * normaliser that lives on only one side guarantees the two drift apart.
 *
 * Pure — no I/O, no module deps — so it is unit-testable and safe to import
 * from a worker, an API route or the recap pipeline.
 */

/** Session kinds a title prefix can declare. */
export type SessionType = 'talk' | 'keynote' | 'workshop' | 'panel' | 'lightning' | 'fireside';

const PREFIXES: Array<{ re: RegExp; type: SessionType }> = [
  { re: /^keynote\s*[:\-–]\s*/i, type: 'keynote' },
  { re: /^workshop\s*[:\-–]\s*/i, type: 'workshop' },
  { re: /^panel(?:\s+discussion)?\s*[:\-–]\s*/i, type: 'panel' },
  { re: /^lightning\s+talks?\s*[:\-–]\s*/i, type: 'lightning' },
  { re: /^fireside\s+chat\s*[:\-–]\s*/i, type: 'fireside' },
];

/**
 * Strip a trailing speaker suffix.
 *
 * Only the text after the LAST " - " is considered, and only when that text
 * looks like a person list — it contains a comma ("Name, Role, Company") or an
 * ampersand ("A, Org & B, Org"). Titles that merely contain a dash
 * ("Agents - From Prototype to Production") keep it, because the tail has no
 * comma or ampersand.
 */
export function stripSpeakerSuffix(title: string): string {
  const s = String(title ?? '');
  const idx = s.lastIndexOf(' - ');
  if (idx <= 0) return s.trim();
  const tail = s.slice(idx + 3);
  if (!/[,&]/.test(tail)) return s.trim();
  // A tail that is mostly prose (many words, no comma before the first 60
  // chars) is more likely part of the title than a speaker list.
  return s.slice(0, idx).trim();
}

/**
 * Pull a declared session type off the front of a title.
 * Returns the remaining title and the type, or null when no prefix matched.
 */
export function extractSessionType(title: string): { title: string; sessionType: SessionType | null } {
  let out = String(title ?? '').trim();
  for (const { re, type } of PREFIXES) {
    if (re.test(out)) return { title: out.replace(re, '').trim(), sessionType: type };
  }
  return { title: out, sessionType: null };
}

/**
 * The comparison key: speaker suffix and type prefix removed, diacritics
 * folded, punctuation collapsed, lowercased.
 */
export function normalizeTitle(title: string): string {
  const withoutSuffix = stripSpeakerSuffix(title);
  const { title: withoutPrefix } = extractSessionType(withoutSuffix);
  return withoutPrefix
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // fold diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Normalised token set, for the Dice coefficient below. */
export function titleTokens(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(' ').filter(Boolean));
}

/**
 * Token-set Dice coefficient: 2|A∩B| / (|A|+|B|). Used by the fuzzy tier of
 * video↔entry matching (§7.2). Returns 0 when either side is empty.
 */
export function diceCoefficient(a: string, b: string): number {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * Split sched's "Role, Company" into its two parts on the LAST comma — roles
 * themselves contain commas ("Organizer | Platform Engineer, AAIF Seoul").
 * A value with no comma is treated as a company, which is how sched renders a
 * speaker who gave only an employer.
 */
export function splitRoleCompany(value: string | null | undefined): { role: string | null; company: string | null } {
  const s = String(value ?? '').trim();
  if (!s) return { role: null, company: null };
  const idx = s.lastIndexOf(', ');
  if (idx < 0) return { role: null, company: s };
  const role = s.slice(0, idx).trim();
  const company = s.slice(idx + 2).trim();
  return { role: role || null, company: company || null };
}
