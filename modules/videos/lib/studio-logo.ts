// @ts-nocheck — supabase-js is resolved at module-host install time.

/**
 * The company logo for a video's thumbnail, and where it came from.
 *
 * Order: a logo uploaded for the talk (video_talk_logos, keyed by the unit
 * the video is attached to), then the logo on the speaker's company record
 * from the programme, then nothing. Nothing means no mark on the thumbnail;
 * the company name is never set in its place.
 */

import { mediaUrl, getMedia } from './studio-media.js';
import type { StudioContext } from './studio-context.js';

export interface LogoInfo {
  url: string | null;
  source: 'talk' | 'speaker' | null;
  company: string | null;
  /** The talk unit a logo would be stored against, when the video has one. */
  subject: { type: string; id: string } | null;
  /** Set when the logo is one of ours, for the renderer. */
  path?: string | null;
}

export async function talkSubject(supabase, videoId: string): Promise<{ type: string; id: string } | null> {
  const { data } = await supabase
    .from('video_subjects').select('subject_type, subject_id').eq('video_id', videoId)
    .in('subject_type', ['agenda_entry', 'podcast_episode', 'talk']).limit(1).maybeSingle();
  return data ? { type: String(data.subject_type), id: String(data.subject_id) } : null;
}

export async function resolveLogo(supabase, videoId: string, context: Partial<StudioContext> | null | undefined): Promise<LogoInfo> {
  const subject = await talkSubject(supabase, videoId);
  const company = context?.speakers?.[0]?.company ?? context?.org ?? null;
  if (subject) {
    const { data } = await supabase
      .from('video_talk_logos').select('storage_path').eq('subject_type', subject.type).eq('subject_id', subject.id).maybeSingle();
    if (data?.storage_path) return { url: mediaUrl(supabase, data.storage_path), source: 'talk', company, subject, path: data.storage_path };
  }
  const fromSpeaker = context?.speakers?.find((s) => s.companyLogoUrl)?.companyLogoUrl ?? null;
  if (fromSpeaker && /^https:\/\//.test(fromSpeaker)) return { url: fromSpeaker, source: 'speaker', company, subject, path: null };
  return { url: null, source: null, company, subject, path: null };
}

const MAX_LOGO_BYTES = 5 * 1024 * 1024;

/** The logo as a data URI for the renderer, or null. Our own object by path, or the speaker record's https URL. */
export async function logoDataUri(supabase, logo: LogoInfo): Promise<string | null> {
  try {
    if (logo.path) {
      const bytes = await getMedia(supabase, logo.path);
      return `data:${mimeFromPath(logo.path)};base64,${bytes.toString('base64')}`;
    }
    if (logo.url && logo.source === 'speaker') {
      const r = await fetch(logo.url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      const type = String(r.headers.get('content-type') ?? '').split(';')[0].trim();
      if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(type)) return null;
      if (Number(r.headers.get('content-length') ?? 0) > MAX_LOGO_BYTES) return null;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_LOGO_BYTES) return null;
      return `data:${type};base64,${buf.toString('base64')}`;
    }
  } catch {
    /* no logo is a fine outcome */
  }
  return null;
}

function mimeFromPath(p: string): string {
  const ext = (p.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();
  return ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
}
