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
