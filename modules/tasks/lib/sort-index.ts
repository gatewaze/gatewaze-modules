/**
 * Fractional sort-index helper (spec §5.1).
 *
 * Linear/Notion-style. Each sibling group is ordered by lexical
 * comparison of sort_index strings. Inserts pick a midpoint string
 * that lies strictly between two existing siblings (or extends
 * beyond an endpoint), so no renumbering is needed on insert/delete.
 *
 * Alphabet: base62 ('0'-'9', 'A'-'Z', 'a'-'z'). '0' is reserved as
 * the "less than anything else" placeholder used during
 * `before()` extension.
 */

const ALPHABET =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const FIRST = ALPHABET[1]!;          // 'A' — smallest legal leading char
const MIDDLE = ALPHABET[Math.floor(ALPHABET.length / 2)]!; // 'V'
const LAST = ALPHABET[ALPHABET.length - 1]!;               // 'z'

function charIndex(c: string): number {
  return ALPHABET.indexOf(c);
}

function charAt(i: number): string {
  return ALPHABET[i] ?? FIRST;
}

/** First sort-index in an empty sibling group. */
export function initial(): string {
  return MIDDLE;
}

/** A string strictly less than `s`. */
export function before(s: string): string {
  if (!s) return MIDDLE;
  const first = s[0]!;
  const firstIdx = charIndex(first);
  if (firstIdx > 1) {
    return charAt(firstIdx - 1);
  }
  // First char is at index ≤ 1 — go shorter by prepending '0'.
  return '0' + MIDDLE;
}

/** A string strictly greater than `s` (as short as possible). */
export function after(s: string): string {
  if (!s) return MIDDLE;
  const first = s[0]!;
  const firstIdx = charIndex(first);
  if (firstIdx < ALPHABET.length - 1) {
    // We can pick a char between first and LAST.
    return charAt(firstIdx + 1);
  }
  // First char is LAST — extend by appending.
  return s[0] + after(s.slice(1));
}

/**
 * A string strictly between `a` and `b` (a < b lexically). Throws if
 * `a >= b`. Handles null endpoints (= unbounded on that side).
 */
export function between(a: string | null, b: string | null): string {
  if (a === null && b === null) return MIDDLE;
  if (a === null) return before(b!);
  if (b === null) return after(a);
  if (a >= b) {
    throw new Error(`sort-index between: expected a<b but got a=${JSON.stringify(a)}, b=${JSON.stringify(b)}`);
  }

  let i = 0;
  const out: string[] = [];
  while (true) {
    const ca = i < a.length ? a[i]! : '0';
    const cb = i < b.length ? b[i]! : LAST;
    if (ca === cb) {
      out.push(ca);
      i += 1;
      continue;
    }
    // ca < cb (we know a < b and prefix is identical so far).
    const ia = charIndex(ca);
    const ib = charIndex(cb);
    if (ib - ia > 1) {
      // Pick a char strictly between.
      out.push(charAt(Math.floor((ia + ib) / 2)));
      return out.join('');
    }
    // ib === ia + 1: emit ca, then any string strictly greater than
    // the rest of a (no upper bound from b: b[i] is already strictly
    // greater than what we're producing because ca < cb).
    out.push(ca);
    i += 1;
    out.push(strictlyGreater(a.slice(i)));
    return out.join('');
  }
}

/**
 * Any string lexically > s (as short as possible). Internal helper.
 */
function strictlyGreater(s: string): string {
  if (!s) return MIDDLE;
  const first = s[0]!;
  const firstIdx = charIndex(first);
  if (firstIdx < ALPHABET.length - 1) {
    // We can pick a char strictly between first and LAST → between
    // (first+1) and LAST inclusive.
    return charAt(firstIdx + 1);
  }
  // first === LAST — keep it and extend.
  return first + strictlyGreater(s.slice(1));
}
