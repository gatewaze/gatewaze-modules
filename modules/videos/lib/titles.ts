/**
 * The titles and copy a publication needs, drafted from fields rather than
 * written by a model (spec §18.3).
 *
 * Everything here is deterministic. The programme already holds the
 * authoritative talk title, the speakers with their roles and companies, and
 * the event name, so a template is both cheaper and more useful than a
 * generated sentence: a title is the one field an editor checks every time,
 * and a template they can predict is easier to correct than something that
 * changes on every run.
 *
 * An AI pass refines the post variants only, where a model genuinely helps.
 * It is not in this file.
 *
 * Nothing here touches the database or throws. Every input is treated as
 * untrusted: speaker names, companies and talk titles were typed into a
 * conference CMS by the speakers themselves.
 */

/** Platform title limits, from each platform's own documented maximum. */
export const TITLE_LIMITS: Record<string, number> = {
  youtube: 100,
  tiktok: 150,
  linkedin: 200,
  instagram: 125,
  x: 280,
  vimeo: 128,
  // Used when a platform is not listed, and as the limit for the stored draft.
  default: 100,
};

/**
 * The platforms a per-platform title is drafted for.
 *
 * This is not a constraint on what can be published. `video_publications.platform`
 * is free text on purpose, because a new platform is a new module. This is only
 * the set whose documented title limit we know, and it exists as a literal array
 * so that `generateCopy` builds its result keys from constants rather than from
 * the request. The platform list arrives on the query string, and using those
 * strings as object keys let a caller write `__proto__` or `constructor` on the
 * response object (CodeQL js/remote-property-injection, alert 261).
 */
export const COPY_PLATFORMS = ['youtube', 'tiktok', 'linkedin', 'instagram', 'x', 'vimeo'] as const;

/** YouTube's description maximum, the tightest of the long-form fields. */
export const DESCRIPTION_LIMIT = 5000;

export interface TitleSpeaker {
  name: string;
  role?: string | null;
  company?: string | null;
}

export interface TitleInput {
  /** The programme's title for the session. */
  talkTitle: string;
  speakers?: TitleSpeaker[];
  eventName?: string | null;
  /** 'full' | 'short' — a short gets a punchier title and a hook. */
  kind?: string | null;
  /** The recap's one-line takeaway, when one exists. */
  worthNoting?: string | null;
  /** A pull quote from the talk, when one exists. */
  quote?: string | null;
  /** Canonical watch URL, appended to descriptions when known. */
  url?: string | null;
}

/**
 * Strip control characters and collapse whitespace.
 *
 * Not HTML-escaping: these strings go to platform APIs as JSON values, not
 * into markup. What matters is that a newline or a tab cannot break a title
 * field, and that the length is bounded.
 */
export function cleanLine(value: unknown, max = 300): string {
  return String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Truncate on a word boundary, with an ellipsis, never mid-word.
 *
 * A hard slice at 100 characters is how "Agents Talking To Agents: MCP, A2A
 * and the Reality of Multi-Agent Orchestration in Produc" ends up on a
 * channel. Returns the input untouched when it already fits.
 */
export function truncateWords(text: string, max: number): string {
  const s = cleanLine(text, max * 4);
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  // Prefer a word boundary. The threshold is 40% rather than something
  // stricter: at 60% a 15-character budget refused to break "the quick brown"
  // at 9 characters, which is plainly readable, and hard-cut mid-word instead.
  const body = lastSpace >= Math.floor(max * 0.4) ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/** "Idit Levine", "Idit Levine & Jake Moghtader", "A, B & C". */
export function speakerNames(speakers: TitleSpeaker[] | undefined, max = 3): string {
  const names = (speakers ?? [])
    .map((s) => cleanLine(s?.name, 120))
    .filter(Boolean)
    .slice(0, max);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** "Director of Developer Relations, Snyk" for a single speaker. */
export function speakerCredit(speaker: TitleSpeaker | undefined): string {
  if (!speaker) return '';
  return [cleanLine(speaker.role, 120), cleanLine(speaker.company, 120)]
    .filter(Boolean)
    .join(', ');
}

/**
 * The fallback title, used when the AI copy recipe is unavailable.
 *
 * Measured against the two real AAIF channels on 2026-10-11 (30 recent
 * videos), because the shape this used to emit appears on NONE of them:
 *
 *   - 0 of 30 titles use a "Talk title | Speaker" separator.
 *   - Median length is 40 characters on @AgenticAI-Foundation and 42 on
 *     @AAIFLive, against a 100-character budget. Short, not truncated-long.
 *   - The speaker's name is never in the title on either channel.
 *   - The event name is never in the title either.
 *
 * The published titles are hooks: "We had to delete 40,000 lines of AI code",
 * "AI Agents Can Delete Everything". A template cannot invent a hook, which
 * is exactly why the AI recipe exists. What a template CAN do is stop making
 * the title worse, so this emits the cleanest honest thing available and
 * never appends a speaker.
 *
 * Order of preference:
 *   1. a short's pull quote or takeaway, which is already hook-shaped
 *   2. the programme's talk title
 *   3. the speaker name, when there is no title at all
 */
export function buildTitle(input: TitleInput, platform = 'default'): string {
  const limit = TITLE_LIMITS[platform] ?? TITLE_LIMITS.default;
  const talk = cleanLine(input.talkTitle, 300);
  const isShort = String(input.kind ?? '').toLowerCase() === 'short';

  // A short leads with the hook when one exists: it is consumed in a feed
  // with no surrounding page to explain it.
  if (isShort) {
    const hook = cleanLine(input.quote || input.worthNoting, 300);
    if (hook) return truncateWords(hook, limit);
  }

  if (talk) return truncateWords(talk, limit);

  // No programme title at all. The speaker is better than nothing here, and
  // this is the ONLY branch that uses a name.
  const names = speakerNames(input.speakers);
  return truncateWords(names || 'Conference talk', limit);
}

/**
 * The platform description.
 *
 * Deliberately plain and ordered most-useful-first: what the talk is, who
 * gave it, the takeaway, then the event and the link. No hashtags and no
 * marketing voice, because this text is also what a search engine indexes and
 * what a viewer reads to decide whether to watch.
 */
export function buildDescription(input: TitleInput): string {
  const lines: string[] = [];
  const talk = cleanLine(input.talkTitle, 300);
  if (talk) lines.push(talk);

  const credits = (input.speakers ?? [])
    .map((s) => {
      const name = cleanLine(s?.name, 120);
      if (!name) return '';
      const credit = speakerCredit(s);
      return credit ? `${name} — ${credit}` : name;
    })
    .filter(Boolean);
  if (credits.length) {
    lines.push('', credits.length === 1 ? 'Speaker' : 'Speakers', ...credits);
  }

  const takeaway = cleanLine(input.worthNoting, 1200);
  if (takeaway) lines.push('', takeaway);

  const quote = cleanLine(input.quote, 500);
  if (quote) lines.push('', `“${quote}”`);

  const event = cleanLine(input.eventName, 200);
  if (event) lines.push('', `Recorded at ${event}.`);

  const url = cleanLine(input.url, 500);
  if (url && /^https:\/\//i.test(url)) lines.push('', url);

  return lines.join('\n').slice(0, DESCRIPTION_LIMIT);
}

export interface PostVariant {
  key: 'professional' | 'technical' | 'community';
  text: string;
}

/**
 * The social post drafts.
 *
 * Three variants rather than four, and each is a template: the AI pass in
 * lf-agents' speaker-promo recipe is what produces genuinely different
 * phrasings. These exist so an editor is never blocked on a model being
 * available, and so there is always something to edit.
 */
export function buildPostVariants(input: TitleInput): PostVariant[] {
  const talk = cleanLine(input.talkTitle, 300);
  const names = speakerNames(input.speakers);
  const first = (input.speakers ?? [])[0];
  const credit = speakerCredit(first);
  const event = cleanLine(input.eventName, 200);
  const takeaway = cleanLine(input.worthNoting, 600);
  const rawUrl = cleanLine(input.url, 500);
  // Only an https link is ever appended. A javascript: or data: URL in a post
  // draft would be copied straight into a social composer by the editor.
  const url = /^https:\/\//i.test(rawUrl) ? rawUrl : '';

  const at = event ? ` at ${event}` : '';
  const by = names ? (credit ? `${names} (${credit})` : names) : 'A speaker';

  // Each paragraph is cleaned on its own, then the paragraphs are joined.
  // Cleaning the assembled string instead cost me twice: cleanLine strips
  // control characters, so a control character used as a newline sentinel was
  // removed and every paragraph break collapsed, and writing that sentinel as
  // a literal byte made this file register as binary in git.
  const paragraphs = (parts: Array<string | null | undefined>): string =>
    parts.map((x) => cleanLine(x, 1000)).filter(Boolean).join('\n\n').slice(0, 3000);

  return [
    {
      key: 'professional',
      text: paragraphs([`${by} on ${talk || 'their work'}${at}.`, takeaway, url]),
    },
    {
      key: 'technical',
      text: paragraphs([
        `${talk || 'New talk'}${at}.`,
        takeaway,
        names ? `Talk by ${names}.` : '',
        url,
      ]),
    },
    {
      key: 'community',
      text: paragraphs([
        `New talk up: ${talk || 'a session'}${names ? `, from ${names}` : ''}.`,
        at ? `Recorded${at}.` : '',
        url,
      ]),
    },
  ];
}

export interface GeneratedCopy {
  title: string;
  description: string;
  posts: PostVariant[];
  /**
   * Per-platform titles, so the UI can show what each one will actually get.
   *
   * Only the platforms in COPY_PLATFORMS appear. An unrecognised platform gets
   * no entry here, and the caller uses `title`, which is drafted at the default
   * 100-character limit.
   */
  titlesByPlatform: Record<string, string>;
}

/** Everything a publication needs, in one call. */
export function generateCopy(input: TitleInput, platforms: string[] = ['youtube']): GeneratedCopy {
  // Null prototype, and iterate the constant list rather than the caller's.
  // `platforms` is request data, so it is only ever read, never used as a key.
  const wanted = new Set((platforms ?? []).map((p) => String(p).trim().toLowerCase()));
  const titlesByPlatform: Record<string, string> = Object.create(null);
  for (const p of COPY_PLATFORMS) {
    if (wanted.has(p)) titlesByPlatform[p] = buildTitle(input, p);
  }
  return {
    title: buildTitle(input),
    description: buildDescription(input),
    posts: buildPostVariants(input),
    titlesByPlatform,
  };
}
