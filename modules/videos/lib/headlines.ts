/**
 * Headline drafts for a thumbnail: a short lead line over a two or three
 * word shout, three variants per video.
 *
 * The model is given the programme's own words and nothing else, and the
 * parse refuses any draft that contains a number the source does not: on the
 * AGNTCon test set the model invented "30 real drinks" and "14.8% best score"
 * from abstracts that had no numbers in them. A draft with no source for its
 * figure is worse than no draft, because it reads as a fact on a public
 * thumbnail.
 */

export interface HeadlineSource {
  title: string;
  speakers: Array<{ name?: string | null; company?: string | null; role?: string | null }>;
  description?: string | null;
  quote?: string | null;
  eventName?: string | null;
}

export interface Headline { lead: string; emph: string }

export const HEADLINE_SYSTEM = 'You write YouTube thumbnail text for recorded conference talks. Reply with JSON only.';

export function headlinePrompt(src: HeadlineSource): string {
  const who = src.speakers.map((s) => [s.name, s.role, s.company].filter(Boolean).join(', ')).join('; ');
  return [
    'Draft THREE thumbnail headlines for this talk. Each has a "lead" (3 to 6 words, sentence case, the setup) and an "emph" (2 to 4 words, the punchline, will be shown in huge capitals).',
    'Rules: use only facts that appear in the text below. Never invent a number, a percentage, a product name or a result. If the text has no numbers, the headlines have no numbers. Avoid the words "unlock", "secrets", "game-changer". No punctuation at the end. Plain English.',
    'Reply ONLY with JSON: {"variants":[{"lead":"...","emph":"..."},{"lead":"...","emph":"..."},{"lead":"...","emph":"..."}]}',
    '',
    `Title: ${src.title}`,
    who ? `Speakers: ${who}` : '',
    src.eventName ? `Event: ${src.eventName}` : '',
    src.description ? `Abstract: ${String(src.description).slice(0, 2500)}` : '',
    src.quote ? `A line from the talk: ${String(src.quote).slice(0, 400)}` : '',
  ].filter((l) => l !== '').join('\n');
}

const NUM_RE = /\d[\d,.]*%?/g;

/** Every number token in a text, normalised so "1,000" and "1000" agree. */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of String(text ?? '').match(NUM_RE) ?? []) out.add(m.replace(/[,%.]+$/, '').replace(/,/g, ''));
  return out;
}

function clean(s: unknown, max: number): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim().slice(0, max);
}

/**
 * Parse the model's reply into usable drafts. Drops a variant that is empty,
 * too long, or cites a number absent from the source; dedupes; caps at three.
 */
export function parseHeadlines(reply: string, src: HeadlineSource): Headline[] {
  const sourceText = [src.title, src.description, src.quote, ...src.speakers.map((s) => `${s.name ?? ''} ${s.company ?? ''}`)].join(' ');
  const allowed = numbersIn(sourceText);
  let parsed: unknown = null;
  const a = reply.indexOf('{'); const b = reply.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { parsed = JSON.parse(reply.slice(a, b + 1)); } catch { parsed = null; }
  }
  const variants = Array.isArray((parsed as { variants?: unknown })?.variants) ? (parsed as { variants: unknown[] }).variants : [];
  const out: Headline[] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    const lead = clean((v as { lead?: unknown })?.lead, 48);
    const emph = clean((v as { emph?: unknown })?.emph, 32);
    if (!lead || !emph) continue;
    if (emph.split(/\s+/).length > 5) continue;
    const nums = numbersIn(`${lead} ${emph}`);
    if ([...nums].some((n) => !allowed.has(n))) continue;
    const key = `${lead.toLowerCase()}|${emph.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lead, emph });
    if (out.length === 3) break;
  }
  return out;
}

/** A draft that needs no model: the speaker and the title's first clause. */
export function fallbackHeadline(src: HeadlineSource): Headline {
  const first = src.speakers[0];
  const lead = clean(first?.name ? `${first.name}${first.company ? `, ${first.company}` : ''}` : (src.eventName ?? 'Conference talk'), 48);
  const emph = clean(String(src.title ?? '').split(/[:?!]/)[0], 32) || 'Watch the talk';
  return { lead, emph };
}
