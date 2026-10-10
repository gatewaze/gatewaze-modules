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
 * The platform title.
 *
 * Shape: "<talk title> | <speakers>" for a full recording, because that is
 * what a viewer scanning a channel needs, in that order. The event name is
 * NOT in the title: it is in the playlist and the description, and spending
 * 25 of YouTube's 100 characters on it pushes the speaker out.
 *
 * A short leads with the hook instead, since it is consumed in a feed with no
 * surrounding context.
 */
export function buildTitle(input: TitleInput, platform = 'default'): string {
  const limit = TITLE_LIMITS[platform] ?? TITLE_LIMITS.default;
  const talk = cleanLine(input.talkTitle, 300);
  const names = speakerNames(input.speakers);
  const isShort = String(input.kind ?? '').toLowerCase() === 'short';

  if (!talk) {
    // No programme title. Fall back to the speaker, then to something honest.
    return truncateWords(names || 'Conference talk', limit);
  }

  if (isShort) {
    const hook = cleanLine(input.quote || input.worthNoting, 300);
    const lead = hook ? truncateWords(hook, Math.floor(limit * 0.7)) : talk;
    return truncateWords(names ? `${lead} — ${names}` : lead, limit);
  }

  if (!names) return truncateWords(talk, limit);

  // Give the talk title at least two thirds of the budget; it is the part
  // somebody searched for.
  const suffix = ` | ${names}`;
  if (talk.length + suffix.length <= limit) return `${talk}${suffix}`;
  const room = limit - suffix.length;
  if (room >= Math.floor(limit * 0.5)) return `${truncateWords(talk, room)}${suffix}`;
  // The names alone would eat the title. Drop them.
  return truncateWords(talk, limit);
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
  /** Per-platform titles, so the UI can show what each one will actually get. */
  titlesByPlatform: Record<string, string>;
}

/** Everything a publication needs, in one call. */
export function generateCopy(input: TitleInput, platforms: string[] = ['youtube']): GeneratedCopy {
  const titlesByPlatform: Record<string, string> = {};
  for (const p of platforms) titlesByPlatform[p] = buildTitle(input, p);
  return {
    title: buildTitle(input),
    description: buildDescription(input),
    posts: buildPostVariants(input),
    titlesByPlatform,
  };
}
