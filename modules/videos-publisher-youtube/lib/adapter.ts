/**
 * The YouTube adapter: publish one video, and collect its numbers back.
 *
 * Both directions live here because they share the credential, the rate
 * limit and the auth-failure handling, and splitting them means two places
 * learn separately that a channel has been de-authorised.
 *
 * Stateless by design, like sites-publisher-netlify: every function takes
 * already-resolved credentials as an argument. Nothing here reads the
 * database, reads an env var, or logs a token.
 */

import { isAuthFailure, type ClientCredentials, refreshAccessToken } from './oauth.js';

const UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/youtube/v3/videos';
const DATA_ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos';
const TIMEOUT_MS = 60_000;

/** YouTube's own vocabulary. video_publications.requested_visibility mirrors it. */
export type Visibility = 'public' | 'unlisted' | 'private';

export interface PublishInput {
  title: string;
  description: string;
  visibility: Visibility;
  /** ISO timestamp. Only meaningful when visibility is 'private'. */
  publishAt?: string | null;
  tags?: string[];
  /** A signed, time-limited URL the uploader streams FROM. Never a local path. */
  sourceUrl: string;
  bytes?: number | null;
  /** YouTube's own category id. 28 is Science & Technology. */
  categoryId?: string;
}

export interface PublishResult {
  ok: boolean;
  externalId?: string;
  externalUrl?: string;
  visibility?: Visibility;
  /** 'auth' is terminal and must stop; 'transient' should be retried. */
  errorKind?: 'auth' | 'transient' | 'permanent';
  error?: string;
}

/**
 * Scheduled publishing is a privacy status, not a separate call.
 *
 * YouTube only honours publishAt when the video is uploaded `private`. Upload
 * it `public` with a publishAt and it goes live immediately and the schedule
 * is ignored — which looks like it worked right up until the embargo is
 * already broken.
 */
export function statusBody(input: PublishInput): Record<string, unknown> {
  const scheduled = Boolean(input.publishAt) && input.visibility === 'public';
  return {
    privacyStatus: scheduled ? 'private' : input.visibility,
    ...(scheduled ? { publishAt: new Date(String(input.publishAt)).toISOString() } : {}),
    selfDeclaredMadeForKids: false,
  };
}

async function withAccessToken<T>(
  client: ClientCredentials,
  refreshToken: string,
  fn: (accessToken: string) => Promise<T>,
): Promise<T> {
  const tokens = await refreshAccessToken(client, refreshToken);
  return fn(tokens.accessToken);
}

/**
 * Upload a master and create the video.
 *
 * Streams from the signed URL rather than buffering: a conference talk is
 * routinely over a gigabyte, and holding one in the worker's heap is how a
 * single upload takes the worker down. `duplex: 'half'` is required by
 * undici whenever a request body is a stream.
 */
export async function publishVideo(
  client: ClientCredentials,
  refreshToken: string,
  input: PublishInput,
): Promise<PublishResult> {
  try {
    return await withAccessToken(client, refreshToken, async (accessToken) => {
      const source = await fetch(input.sourceUrl);
      if (!source.ok || !source.body) {
        return { ok: false, errorKind: 'transient', error: `could not read the master (${source.status})` };
      }

      const metadata = {
        snippet: {
          title: input.title.slice(0, 100),
          description: input.description.slice(0, 5000),
          tags: (input.tags ?? []).slice(0, 30),
          categoryId: input.categoryId ?? '28',
        },
        status: statusBody(input),
      };

      // Resumable would survive a dropped connection mid-gigabyte, which
      // matters here, but it needs a session store the worker does not have
      // yet. Single-request upload with a long timeout is the honest version
      // of what is built; a failed upload retries from the start.
      const params = new URLSearchParams({ part: 'snippet,status', uploadType: 'multipart' });
      const boundary = `gw${Date.now().toString(36)}`;
      const head = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        `${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: video/*\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(head);
          const reader = source.body!.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.enqueue(tail);
          controller.close();
        },
      });

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS * 30);
      let res: Response;
      try {
        res = await fetch(`${UPLOAD_ENDPOINT}?${params.toString()}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body,
          // Required by undici for a streamed request body.
          duplex: 'half',
          signal: ctl.signal,
        } as RequestInit);
      } finally {
        clearTimeout(timer);
      }

      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          errorKind: isAuthFailure(res.status, text) ? 'auth' : res.status >= 500 || res.status === 429 ? 'transient' : 'permanent',
          error: `upload returned ${res.status}`,
        };
      }

      const json = JSON.parse(text) as { id?: string; status?: { privacyStatus?: string } };
      if (!json.id) return { ok: false, errorKind: 'permanent', error: 'upload returned no video id' };
      return {
        ok: true,
        externalId: json.id,
        externalUrl: `https://www.youtube.com/watch?v=${json.id}`,
        visibility: (json.status?.privacyStatus as Visibility) ?? input.visibility,
      };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errorKind: /invalid_grant|no refresh token/i.test(msg) ? 'auth' : 'transient', error: msg };
  }
}

export interface MetricsResult {
  status: 'ok' | 'no_data' | 'auth' | 'error';
  detail?: string;
  views?: number;
  likes?: number;
  comments?: number;
  raw?: Record<string, unknown>;
}

/**
 * Statistics for up to 50 videos in one call.
 *
 * Batched because the Data API costs a quota unit per call regardless of how
 * many ids it carries, and a channel with 160 videos polled one at a time
 * burns the daily quota before lunch.
 *
 * A video the API does not return is 'no_data', NOT zero. It usually means
 * deleted or made private, and recording it as zero would show a real
 * audience vanishing.
 */
export async function collectMetrics(
  client: ClientCredentials,
  refreshToken: string,
  videoIds: string[],
): Promise<Map<string, MetricsResult>> {
  const out = new Map<string, MetricsResult>();
  const ids = [...new Set(videoIds.filter(Boolean))];
  if (ids.length === 0) return out;

  try {
    await withAccessToken(client, refreshToken, async (accessToken) => {
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50);
        const params = new URLSearchParams({ part: 'statistics,status', id: batch.join(',') });
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(`${DATA_ENDPOINT}?${params.toString()}`, {
            headers: { Authorization: `Bearer ${accessToken}` },
            signal: ctl.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        const text = await res.text();
        if (!res.ok) {
          const kind: MetricsResult['status'] = isAuthFailure(res.status, text) ? 'auth' : 'error';
          for (const id of batch) out.set(id, { status: kind, detail: `HTTP ${res.status}` });
          // An auth failure will not fix itself on the next batch.
          if (kind === 'auth') return;
          continue;
        }

        const json = JSON.parse(text) as { items?: Array<{ id?: string; statistics?: Record<string, string> }> };
        const seen = new Set<string>();
        for (const item of json.items ?? []) {
          if (!item.id) continue;
          seen.add(item.id);
          const s = item.statistics ?? {};
          const n = (v: unknown) => (v === undefined || v === null ? undefined : Number(v));
          out.set(item.id, {
            status: 'ok',
            views: n(s.viewCount),
            likes: n(s.likeCount),
            comments: n(s.commentCount),
            raw: s,
          });
        }
        // Asked about, not returned. Deleted or made private — not zero.
        for (const id of batch) {
          if (!seen.has(id)) out.set(id, { status: 'no_data', detail: 'not returned by the API' });
        }
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const kind: MetricsResult['status'] = /invalid_grant/i.test(msg) ? 'auth' : 'error';
    for (const id of ids) if (!out.has(id)) out.set(id, { status: kind, detail: msg });
  }
  return out;
}

export interface DiscoveredVideo {
  externalId: string;
  title: string;
  description: string;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  /** 'short' when YouTube classifies it as a Short, else 'master'. */
  kind: 'master' | 'short';
  raw: Record<string, unknown>;
}

/**
 * Every video already on the channel.
 *
 * This is the adoption path: an account like @AgenticAI-Foundation has years
 * of video Gatewaze never uploaded, and the point of connecting is to take
 * responsibility for all of it rather than only for what we publish next.
 *
 * Walks the channel's uploads playlist, which is the only listing that
 * reliably contains everything — `search.list` is capped, ranked and costs
 * 100 quota units per call against playlistItems' 1.
 *
 * `cap` exists because a first connection on a large channel would otherwise
 * run until the daily quota is gone. The caller resumes on the next run.
 */
export async function listChannelVideos(
  client: ClientCredentials,
  refreshToken: string,
  opts: { cap?: number; since?: string | null } = {},
): Promise<{ videos: DiscoveredVideo[]; truncated: boolean; error?: string }> {
  const cap = Math.max(1, Math.min(5000, opts.cap ?? 1000));
  const out: DiscoveredVideo[] = [];

  try {
    return await withAccessToken(client, refreshToken, async (accessToken) => {
      const auth = { Authorization: `Bearer ${accessToken}` };

      // The uploads playlist id, which is the channel id with the second
      // character changed. Documented, but read it rather than derive it:
      // the derivation is folklore and breaks on some legacy channels.
      const chRes = await fetch(
        'https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true',
        { headers: auth },
      );
      if (!chRes.ok) return { videos: [], truncated: false, error: `channels returned ${chRes.status}` };
      const ch = (await chRes.json()) as {
        items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }>;
      };
      const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!uploads) return { videos: [], truncated: false, error: 'the channel has no uploads playlist' };

      let pageToken: string | undefined;
      let truncated = false;
      for (;;) {
        const params = new URLSearchParams({
          part: 'snippet,contentDetails',
          playlistId: uploads,
          maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        });
        const res = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`, { headers: auth });
        if (!res.ok) {
          const text = await res.text();
          return {
            videos: out,
            truncated: true,
            error: isAuthFailure(res.status, text) ? 'auth' : `playlistItems returned ${res.status}`,
          };
        }
        const json = (await res.json()) as {
          nextPageToken?: string;
          items?: Array<{
            snippet?: { title?: string; description?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }> };
            contentDetails?: { videoId?: string; videoPublishedAt?: string };
          }>;
        };

        for (const item of json.items ?? []) {
          const id = item.contentDetails?.videoId;
          if (!id) continue;
          const t = item.snippet?.thumbnails ?? {};
          out.push({
            externalId: id,
            title: String(item.snippet?.title ?? '').slice(0, 300),
            description: String(item.snippet?.description ?? '').slice(0, 5000),
            publishedAt: item.contentDetails?.videoPublishedAt ?? item.snippet?.publishedAt ?? null,
            thumbnailUrl: t.maxres?.url ?? t.high?.url ?? t.medium?.url ?? t.default?.url ?? null,
            // playlistItems does not carry duration; the metrics pass fills it.
            durationSeconds: null,
            kind: 'master',
            raw: { snippet: item.snippet ?? {}, contentDetails: item.contentDetails ?? {} },
          });
          if (out.length >= cap) { truncated = true; break; }
        }

        if (truncated) break;
        pageToken = json.nextPageToken;
        if (!pageToken) break;
      }

      return { videos: out, truncated };
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { videos: out, truncated: true, error: /invalid_grant/i.test(msg) ? 'auth' : msg };
  }
}

/**
 * Durations and the Short/long distinction, for videos we already know of.
 *
 * Separate from listChannelVideos because playlistItems does not return
 * either, and `videos.list` takes 50 ids per quota unit — so this is one
 * extra unit per 50 videos rather than a call each.
 */
export async function fetchVideoDetails(
  client: ClientCredentials,
  refreshToken: string,
  videoIds: string[],
): Promise<Map<string, { durationSeconds: number | null; kind: 'master' | 'short' }>> {
  const out = new Map<string, { durationSeconds: number | null; kind: 'master' | 'short' }>();
  const ids = [...new Set(videoIds.filter(Boolean))];
  if (ids.length === 0) return out;

  try {
    await withAccessToken(client, refreshToken, async (accessToken) => {
      for (let i = 0; i < ids.length; i += 50) {
        const params = new URLSearchParams({ part: 'contentDetails', id: ids.slice(i, i + 50).join(',') });
        const res = await fetch(`${DATA_ENDPOINT}?${params}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          items?: Array<{ id?: string; contentDetails?: { duration?: string } }>;
        };
        for (const item of json.items ?? []) {
          if (!item.id) continue;
          const secs = parseIsoDuration(item.contentDetails?.duration);
          out.set(item.id, {
            durationSeconds: secs,
            // YouTube's own Shorts rule: 3 minutes or less. Classifying by
            // length is what the API allows; there is no isShort field.
            kind: secs !== null && secs <= 180 ? 'short' : 'master',
          });
        }
      }
    });
  } catch {
    // Details are an enrichment. A failure here must not lose the discovery.
  }
  return out;
}

/** ISO 8601 duration (PT1H2M3S) to seconds. Returns null for anything else. */
export function parseIsoDuration(value: string | null | undefined): number | null {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(value ?? ''));
  if (!m) return null;
  const [, d, h, min, s] = m;
  const total = Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Math.floor(Number(s ?? 0));
  return Number.isFinite(total) ? total : null;
}
