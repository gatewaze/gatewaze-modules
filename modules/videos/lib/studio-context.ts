// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * What the programme says about a video: its title, the people who gave the
 * talk, the event, and the abstract. The headline drafts and the talk card
 * are built from this and nothing else, so a wrong name is the programme's
 * wrong name, which an editor can fix in one place.
 *
 * Every read is best-effort: a brand without the agenda or speakers modules
 * still gets a title from the video row.
 */

export interface StudioSpeaker {
  name: string;
  role: string | null;
  company: string | null;
  companyLogoUrl: string | null;
}

export interface StudioContext {
  title: string;
  description: string | null;
  eventName: string | null;
  speakers: StudioSpeaker[];
  /** The first speaker's company, short enough to sit as a mark. */
  org: string | null;
}

/** One company name, short enough to sit as a mark on the thumbnail. */
export function shortOrg(company: string | null | undefined): string | null {
  let org = String(company ?? '').split('(')[0].split('/')[0].trim();
  if (!org) return null;
  if (org.length > 18) org = org.slice(0, 18).replace(/\s+\S*$/, '');
  return org || null;
}

export async function loadStudioContext(supabase, videoId: string): Promise<StudioContext> {
  const ctx: StudioContext = { title: '', description: null, eventName: null, speakers: [], org: null };
  const { data: video } = await supabase.from('videos').select('title, description').eq('id', videoId).maybeSingle();
  ctx.title = String(video?.title ?? '');
  ctx.description = video?.description ?? null;
  try {
    const { data: sub } = await supabase
      .from('video_subjects').select('subject_type, subject_id').eq('video_id', videoId)
      .in('subject_type', ['agenda_entry', 'podcast_episode']).limit(1).maybeSingle();
    if (!sub) return ctx;
    if (sub.subject_type === 'agenda_entry') {
      const { data: entry } = await supabase
        .from('events_agenda_entries').select('title, description, talk_id, event_uuid').eq('id', sub.subject_id).maybeSingle();
      if (entry?.title) ctx.title = entry.title;
      if (entry?.description && !ctx.description) ctx.description = entry.description;
      if (entry?.event_uuid) {
        const { data: ev } = await supabase.from('events').select('event_title').eq('id', entry.event_uuid).maybeSingle();
        ctx.eventName = ev?.event_title ?? null;
      }
      if (entry?.talk_id) {
        const { data: talk } = await supabase.from('events_talks_with_speakers').select('description, speakers').eq('id', entry.talk_id).maybeSingle();
        if (talk?.description && !ctx.description) ctx.description = talk.description;
        ctx.speakers = (Array.isArray(talk?.speakers) ? talk.speakers : [])
          .map((s) => ({
            name: String(s?.full_name ?? '').trim(),
            role: s?.job_title ?? s?.speaker_title ?? null,
            company: s?.company ?? null,
            companyLogoUrl: typeof s?.company_logo_url === 'string' && /^https:\/\//.test(s.company_logo_url) ? s.company_logo_url : null,
          }))
          .filter((s) => s.name);
      }
    } else {
      const { data: ep } = await supabase.from('podcast_episodes').select('title, description, podcast_id').eq('id', sub.subject_id).maybeSingle();
      if (ep?.title) ctx.title = ep.title;
      if (ep?.description && !ctx.description) ctx.description = ep.description;
      if (ep?.podcast_id) {
        const { data: pod } = await supabase.from('podcasts').select('name').eq('id', ep.podcast_id).maybeSingle();
        ctx.eventName = pod?.name ?? null;
      }
    }
  } catch {
    /* best effort by design */
  }
  ctx.org = shortOrg(ctx.speakers[0]?.company);
  return ctx;
}
