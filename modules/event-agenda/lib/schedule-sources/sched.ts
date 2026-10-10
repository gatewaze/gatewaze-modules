/**
 * sched.com schedule source (spec-event-agenda-schedule-import §5.2, §5.3).
 *
 * Two public endpoints, both read-only:
 *   /all.ics              — the skeleton: UID, times (UTC), location, category
 *   /list/descriptions/   — the people: speakers with role, company, bio, avatar
 *
 * The join, verified against agntconmcpconeu26 (2026-10-10): the HTML's
 * `a.name` carries BOTH a short permalink (`href="event/2RBSv/..."`) and an
 * `id` attribute equal to the ICS `UID`. The spec said the join was on the
 * href id — it is not; it is the `id` attribute. 113 ids for 113 VEVENTs, 1:1.
 *
 * Also learned from that fixture: the `Presentation Language` custom field
 * Seoul carried is absent entirely here, so language is strictly optional.
 */

import * as cheerio from 'cheerio';
import {
  normalizeTitle,
  stripSpeakerSuffix,
  extractSessionType,
  splitRoleCompany,
} from '../normalize-title.js';
import type {
  GuardedFetch, ParsedSchedule, ParsedSession, ParsedSpeaker, RawSchedule, ScheduleSource, SessionType,
} from './types.js';

const SCHED_HOST_RE = /^[a-z0-9-]+\.sched\.com$/i;

/**
 * Categories that are logistics or expo rather than programme content.
 *
 * Deliberately unanchored: real sched tracks combine several words, e.g.
 * "MEALS / BREAKS / SPECIAL EVENTS", which an anchored pattern misses. The
 * sponsor/showcase terms are here because those slots carry no speakers and
 * are not talks — importing them as sessions would put expo stands into the
 * talks table and the speaker database.
 */
const BREAK_CATEGORIES =
  /(registration|breaks?|meals?|lunch|coffee|networking|reception|gathering|special\s*events?|cloak|transport|showcase|expo|sponsor\s*activit)/i;

/** RFC 5545 line unfolding: a CRLF followed by space/tab continues the line. */
function unfoldIcs(ics: string): string[] {
  return ics.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
}

/** Unescape an ICS text value: \n \, \; \\ */
function unescapeIcs(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_m, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** `20260917T053000Z` or `TZID=...:20260917T090000` → ISO 8601, or null. */
function icsDateToIso(raw: string): string | null {
  const m = raw.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  // A value with no Z is floating local time; sched's all.ics is UTC in
  // practice, and treating a floating value as UTC keeps ordering correct.
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : 'Z'}`;
}

interface IcsEvent {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  categories: string | null;
  startsAt: string | null;
  endsAt: string | null;
  url: string | null;
}

/** Parse the VEVENTs we care about. Exported for fixture tests. */
export function parseIcs(ics: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let cur: Partial<IcsEvent> | null = null;
  for (const line of unfoldIcs(ics)) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur?.uid && cur.summary) {
        out.push({
          uid: cur.uid,
          summary: cur.summary,
          description: cur.description ?? null,
          location: cur.location ?? null,
          categories: cur.categories ?? null,
          startsAt: cur.startsAt ?? null,
          endsAt: cur.endsAt ?? null,
          url: cur.url ?? null,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).split(';')[0].toUpperCase();
    const value = line.slice(idx + 1);
    switch (key) {
      case 'UID': cur.uid = value.trim(); break;
      case 'SUMMARY': cur.summary = unescapeIcs(value).trim(); break;
      case 'DESCRIPTION': { const d = unescapeIcs(value).trim(); cur.description = d || null; break; }
      case 'LOCATION': cur.location = unescapeIcs(value).trim() || null; break;
      case 'CATEGORIES': cur.categories = unescapeIcs(value).trim() || null; break;
      case 'DTSTART': cur.startsAt = icsDateToIso(line); break;
      case 'DTEND': cur.endsAt = icsDateToIso(line); break;
      case 'URL': cur.url = value.trim() || null; break;
    }
  }
  return out;
}

export interface HtmlSession {
  /** The ICS UID, from a.name's id attribute. */
  uid: string;
  permalink: string | null;
  rawTitle: string;
  location: string | null;
  description: string | null;
  language: string | null;
  speakers: ParsedSpeaker[];
}

/** Parse the descriptions listing. Exported for fixture tests. */
export function parseDescriptionsHtml(html: string): HtmlSession[] {
  const $ = cheerio.load(html);
  const out: HtmlSession[] = [];

  $('.sched-container').each((_i, el) => {
    const container = $(el);
    const anchor = container.find('a.name').first();
    const uid = (anchor.attr('id') ?? '').trim();
    if (!uid) return; // not a session block

    const rawTitle = anchor.find('.session-title').first().text().trim()
      || anchor.text().trim();

    const location = container.find('.list-single__location').first().text().trim() || null;

    // The description cell is often an empty <strong>/<br> shell.
    const descText = container.find('.tip-description').first().text().replace(/\s+/g, ' ').trim();

    // Custom fields render as a labelled block; Presentation Language is one
    // of them and is absent on many events, so this stays best-effort.
    let language: string | null = null;
    container.find('.sched-event-details-cf, .tip-custom-field, .sched-custom-field').each((_j, cf) => {
      const t = $(cf).text().replace(/\s+/g, ' ').trim();
      const m = t.match(/Presentation Language\s*:?\s*(.+)$/i);
      if (m && !language) language = m[1].trim() || null;
    });

    const speakers: ParsedSpeaker[] = [];
    const seen = new Set<string>();
    container.find('.sched-person-session').each((_j, ps) => {
      const block = $(ps);
      const link = block.find('h2 a[href^="speaker/"]').first();
      const href = link.attr('href') ?? '';
      const ref = href.replace(/^speaker\//, '').trim();
      const name = (link.attr('title') ?? link.text()).trim();
      if (!ref || !name || seen.has(ref)) return;
      seen.add(ref);

      const roleCompanyRaw = block.find('.sched-event-details-role-company').first().text().replace(/\s+/g, ' ').trim();
      const { role, company } = splitRoleCompany(roleCompanyRaw);
      const bio = block.find('.sched-person-session-role').first().text().replace(/\s+/g, ' ').trim() || null;
      const avatarStyle = block.find('a.sched-avatar').first().attr('style') ?? '';
      const avatarImg = block.find('a.sched-avatar img').first().attr('src') ?? '';
      const bgMatch = avatarStyle.match(/url\((['"]?)(.*?)\1\)/);
      const avatarUrl = (avatarImg || (bgMatch ? bgMatch[2] : '')).trim() || null;

      speakers.push({ ref, name, role, company, bio, avatarUrl });
    });

    out.push({
      uid,
      permalink: anchor.attr('href') ?? null,
      rawTitle,
      location,
      description: descText || null,
      language,
      speakers,
    });
  });

  return out;
}

/** Category → track label, and whether the slot is programme content. */
function classify(categories: string | null, rawTitle: string, speakerCount: number): {
  kind: 'session' | 'break';
  sessionType: SessionType;
  trackRef: string | null;
} {
  const cat = (categories ?? '').trim();
  const kind = BREAK_CATEGORIES.test(cat) ? 'break' : 'session';

  const { sessionType: fromPrefix } = extractSessionType(stripSpeakerSuffix(rawTitle));
  let sessionType: SessionType = fromPrefix ?? 'talk';
  if (!fromPrefix) {
    if (/keynote/i.test(cat)) sessionType = 'keynote';
    else if (/workshop/i.test(cat)) sessionType = 'workshop';
    else if (/panel|ama/i.test(cat) || /\b(panel|ama)\b/i.test(rawTitle)) sessionType = 'panel';
    else if (speakerCount >= 3) sessionType = 'panel';
  }
  return { kind, sessionType, trackRef: cat || null };
}

/** Title-case a SHOUTED category for display ("REGISTRATION" → "Registration"). */
function trackName(ref: string): string {
  if (ref !== ref.toUpperCase()) return ref;
  return ref.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export const schedSource: ScheduleSource = {
  kind: 'sched',

  detect(pageUrl: string, pageHtml?: string): { resolvedUrl: string } | null {
    try {
      const u = new URL(String(pageUrl ?? '').trim());
      if (SCHED_HOST_RE.test(u.hostname)) {
        return { resolvedUrl: `https://${u.hostname.toLowerCase()}` };
      }
    } catch {
      return null;
    }
    // Not a sched URL itself — look for the embed script or an iframe on the
    // page we were given. The host is never derived from the event slug.
    if (pageHtml) {
      const m = pageHtml.match(/(?:src|href)=["']?(?:https?:)?\/\/([a-z0-9-]+\.sched\.com)/i);
      if (m) return { resolvedUrl: `https://${m[1].toLowerCase()}` };
    }
    return null;
  },

  async fetch(resolvedUrl: string, get: GuardedFetch): Promise<RawSchedule> {
    const ics = await get(`${resolvedUrl}/all.ics`);
    if (!ics.ok) throw new Error(`sched all.ics returned ${ics.status}`);
    const html = await get(`${resolvedUrl}/list/descriptions/`);
    if (!html.ok) throw new Error(`sched list/descriptions returned ${html.status}`);
    return { kind: 'sched', resolvedUrl, parts: { ics: ics.text, html: html.text } };
  },

  parse(raw: RawSchedule): ParsedSchedule {
    const icsEvents = parseIcs(raw.parts.ics ?? '');
    const htmlSessions = parseDescriptionsHtml(raw.parts.html ?? '');
    const htmlByUid = new Map(htmlSessions.map((h) => [h.uid, h]));

    const tracks = new Map<string, string>();
    const sessions: ParsedSession[] = [];
    let matchedHtml = 0;

    for (const ev of icsEvents) {
      const h = htmlByUid.get(ev.uid);
      if (h) matchedHtml++;
      const speakers = h?.speakers ?? [];
      const rawTitle = h?.rawTitle || ev.summary;
      const { kind, sessionType, trackRef } = classify(ev.categories, rawTitle, speakers.length);
      if (trackRef) tracks.set(trackRef, trackName(trackRef));

      // HTML location is already the room ("Auditorium (Ground Floor)");
      // the ICS value appends venue and city, so take its first segment.
      const location = h?.location ?? (ev.location ? ev.location.split(',')[0].trim() : null);

      const { title } = extractSessionType(stripSpeakerSuffix(rawTitle));

      sessions.push({
        ref: ev.uid,
        title: title || rawTitle,
        rawTitle,
        kind,
        sessionType,
        startsAt: ev.startsAt,
        endsAt: ev.endsAt,
        location,
        trackRef,
        description: h?.description ?? ev.description ?? null,
        language: h?.language ?? null,
        speakers: kind === 'break' ? [] : speakers,
        sourceUrl: ev.url,
      });
    }

    // Sessions the HTML lists but the ICS omits (rare; counted, not dropped).
    for (const h of htmlSessions) {
      if (icsEvents.some((e) => e.uid === h.uid)) continue;
      const { kind, sessionType, trackRef } = classify(null, h.rawTitle, h.speakers.length);
      const { title } = extractSessionType(stripSpeakerSuffix(h.rawTitle));
      sessions.push({
        ref: h.uid, title: title || h.rawTitle, rawTitle: h.rawTitle, kind, sessionType,
        startsAt: null, endsAt: null, location: h.location, trackRef,
        description: h.description, language: h.language, speakers: h.speakers, sourceUrl: null,
      });
    }

    return {
      tracks: [...tracks.entries()].map(([ref, name]) => ({ ref, name })),
      sessions,
      diagnostics: {
        skeletonMismatch: (icsEvents.length - matchedHtml) + (htmlSessions.length - matchedHtml),
        sessionsFromIcs: icsEvents.length,
        sessionsFromHtml: htmlSessions.length,
      },
    };
  },
};

export { normalizeTitle };
