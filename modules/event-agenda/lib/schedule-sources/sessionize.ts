/**
 * Sessionize schedule source.
 *
 * Two ways a conference publishes with Sessionize, both read-only JSON:
 *
 *   hosted site   <event>.sessionize.com, a Vue app that reads its own
 *                 /api/schedule (sessions, speakers, rooms, categories,
 *                 questions) and /api/data (the event's timezone)
 *   API v2        sessionize.com/api/v2/<endpoint id>/view/All, the same
 *                 shape, embedded on a conference's own page by script tag
 *
 * Learned from the MCP Dev Summit Toronto 2026 site (2026-10-21): times are
 * naive local strings and the timezone is a Windows name ("Atlantic Standard
 * Time"); breaks are ordinary sessions with no speakers and a plain title
 * ("Registration", "Lunch"), isServiceSession is false for all of them;
 * role and company come as custom-question answers ("Company", "Speaker
 * Title") with the tagLine as a fallback; the track is an item of the
 * "All Sessions" category, beside an "Audience Level" category that is not
 * a track. Speaker ids are GUIDs and are the only stable identifier.
 */

import { stripSpeakerSuffix, extractSessionType, splitRoleCompany } from '../normalize-title.js';
import { toIanaZone, localToUtcIso } from '../tz.js';
import type {
  GuardedFetch, ParsedSchedule, ParsedSession, ParsedSpeaker, RawSchedule, ScheduleSource, SessionType,
} from './types.js';

const HOSTED_HOST_RE = /^[a-z0-9-]+\.sessionize\.com$/i;
const API_V2_RE = /sessionize\.com\/api\/v2\/([A-Za-z0-9]+)\/view\//i;

/** Titles that are logistics rather than programme, when nobody speaks. */
const BREAK_TITLE_RE = /^(registration|check[- ]?in|breakfast|coffee|break|lunch|dinner|networking|reception|happy hour|closing remarks|doors open|welcome reception|expo|showcase)\b/i;

const MAX_JSON_BYTES = 8 * 1024 * 1024;

interface SzSpeaker {
  id: string; firstName?: string; lastName?: string; fullName?: string; bio?: string | null; tagLine?: string | null;
  profilePicture?: string | null; questionAnswers?: Array<{ questionId: number; answerValue?: string | null }>;
}
interface SzSession {
  id: string | number; title: string; description?: string | null; startsAt?: string | null; endsAt?: string | null;
  isServiceSession?: boolean; isPlenumSession?: boolean; speakers?: string[]; categoryItems?: number[]; roomId?: number | null; status?: string;
}
interface SzSchedule {
  sessions?: SzSession[]; speakers?: SzSpeaker[];
  questions?: Array<{ id: number; question: string }>;
  categories?: Array<{ id: number; title: string; type?: string; items?: Array<{ id: number; name: string; sort?: number }> }>;
  rooms?: Array<{ id: number; name: string }>;
}

function text(v: unknown, max = 4000): string | null {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

/** Role and company from the custom answers first, the tag line second. */
export function speakerRoleCompany(
  sp: SzSpeaker,
  questions: Array<{ id: number; question: string }>,
): { role: string | null; company: string | null } {
  const byQ = new Map<number, string>();
  for (const q of questions) byQ.set(q.id, q.question.toLowerCase());
  let role: string | null = null;
  let company: string | null = null;
  for (const a of sp.questionAnswers ?? []) {
    const q = byQ.get(a.questionId) ?? '';
    const v = text(a.answerValue, 200);
    if (!v) continue;
    if (!company && /company|organi[sz]ation|employer|affiliation/.test(q)) company = v;
    else if (!role && /title|role|position|job/.test(q)) role = v;
  }
  if (role && company) return { role, company };
  const tag = text(sp.tagLine, 200);
  if (tag) {
    if (/, /.test(tag)) {
      const s = splitRoleCompany(tag);
      role ??= s.role; company ??= s.company;
    } else {
      const at = tag.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i) ?? tag.match(/^(.+?)\s+-\s+(.+)$/);
      if (at) { role ??= text(at[1], 200); company ??= text(at[2], 200); }
      else if (!company && !role) company = tag;
    }
  }
  return { role, company };
}

/** Which category carries the tracks: one named for tracks, else the first session category that is not a level or format. */
export function trackCategory(categories: SzSchedule['categories']): NonNullable<SzSchedule['categories']>[number] | null {
  const cats = (categories ?? []).filter((c) => (c.items ?? []).length > 0);
  return cats.find((c) => /track/i.test(c.title))
    ?? cats.find((c) => (c.type ?? 'session') === 'session' && !/level|audience|language|format|duration|type/i.test(c.title))
    ?? null;
}

function classify(rawTitle: string, speakerCount: number, trackName: string | null, s: SzSession): { kind: 'session' | 'break'; sessionType: SessionType } {
  const kind = s.isServiceSession === true || (speakerCount === 0 && BREAK_TITLE_RE.test(rawTitle)) ? 'break' : 'session';
  const { sessionType: fromPrefix } = extractSessionType(stripSpeakerSuffix(rawTitle));
  let sessionType: SessionType = fromPrefix ?? 'talk';
  if (!fromPrefix) {
    const t = trackName ?? '';
    if (/keynote/i.test(t) || (s.isPlenumSession === true && /keynote/i.test(rawTitle))) sessionType = 'keynote';
    else if (/workshop/i.test(t) || /\bworkshop\b/i.test(rawTitle)) sessionType = 'workshop';
    else if (/panel/i.test(t) || /\b(panel|ama)\b/i.test(rawTitle)) sessionType = 'panel';
    else if (/lightning/i.test(t) || /\blightning\b/i.test(rawTitle)) sessionType = 'lightning';
    else if (/fireside/i.test(t) || /\bfireside\b/i.test(rawTitle)) sessionType = 'fireside';
    else if (speakerCount >= 3) sessionType = 'panel';
  }
  return { kind, sessionType };
}

/** Pure: the two JSON documents to the importer's shape. Exported for fixture tests. */
export function parseSessionize(schedule: SzSchedule, data: { timezone?: string | null } | null, origin: string | null): ParsedSchedule {
  const zone = toIanaZone(data?.timezone ?? null);
  const questions = schedule.questions ?? [];
  const rooms = new Map((schedule.rooms ?? []).map((r) => [r.id, text(r.name, 200)]));
  const trackCat = trackCategory(schedule.categories);
  const trackItems = new Map<number, { ref: string; name: string }>();
  for (const it of trackCat?.items ?? []) {
    const name = text(it.name, 120);
    if (name) trackItems.set(it.id, { ref: String(it.id), name });
  }

  const speakers = new Map<string, ParsedSpeaker>();
  for (const sp of schedule.speakers ?? []) {
    const id = text(sp.id, 64);
    const name = text(sp.fullName, 200) ?? text(`${sp.firstName ?? ''} ${sp.lastName ?? ''}`, 200);
    if (!id || !name) continue;
    const { role, company } = speakerRoleCompany(sp, questions);
    const pic = text(sp.profilePicture, 500);
    speakers.set(id, {
      ref: id,
      name,
      role,
      company,
      bio: text(sp.bio, 4000),
      avatarUrl: pic && /^https:\/\//i.test(pic) ? pic : null,
      // A Sessionize speaker id is a GUID per speaker; prefixed so it can
      // never collide with sched's numeric account ids in the same column.
      sourceUserId: `sessionize:${id}`,
    });
  }

  const tracksUsed = new Map<string, string>();
  const sessions: ParsedSession[] = [];
  for (const s of schedule.sessions ?? []) {
    const rawTitle = text(s.title, 500);
    const ref = text(s.id, 64);
    if (!rawTitle || !ref) continue;
    if (s.status && !/^accepted$/i.test(s.status)) continue;
    const spk = (s.speakers ?? []).map((id) => speakers.get(String(id))).filter((x): x is ParsedSpeaker => Boolean(x));
    const track = (s.categoryItems ?? []).map((id) => trackItems.get(id)).find(Boolean) ?? null;
    const { kind, sessionType } = classify(rawTitle, spk.length, track?.name ?? null, s);
    if (track) tracksUsed.set(track.ref, track.name);
    const { title } = extractSessionType(stripSpeakerSuffix(rawTitle));
    sessions.push({
      ref,
      title: title || rawTitle,
      rawTitle,
      kind,
      sessionType,
      startsAt: s.startsAt ? localToUtcIso(String(s.startsAt), zone) : null,
      endsAt: s.endsAt ? localToUtcIso(String(s.endsAt), zone) : null,
      location: s.roomId != null ? rooms.get(s.roomId) ?? null : null,
      trackRef: track?.ref ?? null,
      description: text(s.description, 8000),
      language: null,
      speakers: kind === 'break' ? [] : spk,
      sourceUrl: origin ? `${origin}/session/${encodeURIComponent(ref)}` : null,
    });
  }

  return {
    tracks: [...tracksUsed.entries()].map(([ref, name]) => ({ ref, name })),
    sessions,
    diagnostics: {
      // One feed, so there is no skeleton to disagree with. The timezone
      // mattering is recorded through the "from" counts instead.
      skeletonMismatch: zone ? 0 : sessions.length,
      sessionsFromIcs: 0,
      sessionsFromHtml: sessions.length,
    },
  };
}

function parseJson(s: string, what: string): unknown {
  if (s.length > MAX_JSON_BYTES) throw new Error(`sessionize ${what} is over ${MAX_JSON_BYTES / 1048576} MB`);
  try {
    return JSON.parse(s);
  } catch {
    throw new Error(`sessionize ${what} is not JSON`);
  }
}

export const sessionizeSource: ScheduleSource = {
  kind: 'sessionize',

  detect(pageUrl: string, pageHtml?: string): { resolvedUrl: string } | null {
    try {
      const u = new URL(String(pageUrl ?? '').trim());
      if (HOSTED_HOST_RE.test(u.hostname)) return { resolvedUrl: `https://${u.hostname.toLowerCase()}` };
      const api = u.href.match(API_V2_RE);
      if (api && /(^|\.)sessionize\.com$/i.test(u.hostname)) return { resolvedUrl: `https://sessionize.com/api/v2/${api[1]}/view/All` };
    } catch {
      return null;
    }
    if (pageHtml) {
      const m = pageHtml.match(/(?:src|href)=["']?(?:https?:)?\/\/([a-z0-9-]+\.sessionize\.com)\b/i);
      if (m && !/^(www|cdn|api)\./i.test(m[1])) return { resolvedUrl: `https://${m[1].toLowerCase()}` };
      const api = pageHtml.match(API_V2_RE);
      if (api) return { resolvedUrl: `https://sessionize.com/api/v2/${api[1]}/view/All` };
    }
    return null;
  },

  async fetch(resolvedUrl: string, get: GuardedFetch): Promise<RawSchedule> {
    if (/\/api\/v2\//.test(resolvedUrl)) {
      const all = await get(resolvedUrl);
      if (!all.ok) throw new Error(`sessionize API returned ${all.status}`);
      return { kind: 'sessionize', resolvedUrl, parts: { schedule: all.text, data: '' } };
    }
    const schedule = await get(`${resolvedUrl}/api/schedule`);
    if (!schedule.ok) throw new Error(`sessionize /api/schedule returned ${schedule.status}`);
    // The timezone lives on a second call; losing it degrades to floating
    // times, so a failure here is logged by the counts, not fatal.
    const data = await get(`${resolvedUrl}/api/data`).catch(() => ({ ok: false, status: 0, text: '' }));
    return { kind: 'sessionize', resolvedUrl, parts: { schedule: schedule.text, data: data.ok ? data.text : '' } };
  },

  parse(raw: RawSchedule): ParsedSchedule {
    const schedule = parseJson(raw.parts.schedule ?? '', 'schedule') as SzSchedule;
    const data = raw.parts.data ? (parseJson(raw.parts.data, 'data') as { timezone?: string | null }) : null;
    const origin = /\/api\/v2\//.test(raw.resolvedUrl) ? null : raw.resolvedUrl;
    return parseSessionize(schedule, data, origin);
  },
};
