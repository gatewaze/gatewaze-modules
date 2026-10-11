/**
 * The YouTube adapter and OAuth helpers.
 *
 * Two behaviours here are worth more than the rest, because both fail
 * silently in production:
 *
 *   - a scheduled publish must upload PRIVATE. Upload it public with a
 *     publishAt and YouTube ignores the schedule and goes live immediately,
 *     which nobody notices until the embargo is already broken.
 *   - a video the API does not return is no_data, never zero. Recording it
 *     as zero shows a real audience vanishing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { collectMetrics, statusBody, type PublishInput } from '../lib/adapter';
import { authorizeUrl, isAuthFailure, redirectUri, SCOPES } from '../lib/oauth';

const client = { clientId: '1-abc.apps.googleusercontent.com', clientSecret: 's3cret' };

const base: PublishInput = {
  title: 'AI Agents Can Delete Everything',
  description: 'Body',
  visibility: 'public',
  sourceUrl: 'https://storage.test/master.mp4',
};

afterEach(() => { vi.restoreAllMocks(); });

describe('statusBody — scheduling is a privacy status, not a flag', () => {
  it('uploads a SCHEDULED video as private, with publishAt', () => {
    const s = statusBody({ ...base, publishAt: '2026-12-01T10:00:00Z' });
    // The trap: 'public' + publishAt goes live immediately and the schedule
    // is silently ignored.
    expect(s.privacyStatus).toBe('private');
    expect(s.publishAt).toBe('2026-12-01T10:00:00.000Z');
  });

  it('publishes immediately when there is no schedule', () => {
    const s = statusBody(base);
    expect(s.privacyStatus).toBe('public');
    expect(s.publishAt).toBeUndefined();
  });

  it('does not schedule an unlisted or private video', () => {
    // publishAt only means anything on the way to public.
    expect(statusBody({ ...base, visibility: 'unlisted', publishAt: '2026-12-01T10:00:00Z' }))
      .toMatchObject({ privacyStatus: 'unlisted' });
    expect(statusBody({ ...base, visibility: 'private', publishAt: '2026-12-01T10:00:00Z' }).publishAt)
      .toBeUndefined();
  });

  it('never declares a video made for kids', () => {
    expect(statusBody(base).selfDeclaredMadeForKids).toBe(false);
  });
});

describe('collectMetrics', () => {
  function mockApi(items: Array<{ id: string; statistics: Record<string, string> }>, ok = true, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'at', expires_in: 3600, scope: '' }) } as never;
      }
      return { ok, status, text: async () => JSON.stringify({ items }) } as never;
    }));
  }

  it('reads statistics for the ids it was given', async () => {
    mockApi([{ id: 'v1', statistics: { viewCount: '1200', likeCount: '34', commentCount: '5' } }]);
    const m = await collectMetrics(client, 'rt', ['v1']);
    expect(m.get('v1')).toMatchObject({ status: 'ok', views: 1200, likes: 34, comments: 5 });
  });

  it('records a MISSING video as no_data, never as zero', async () => {
    // The API omits deleted and newly-private videos. Writing 0 views for one
    // of those shows a real audience disappearing.
    mockApi([{ id: 'v1', statistics: { viewCount: '10' } }]);
    const m = await collectMetrics(client, 'rt', ['v1', 'gone']);
    expect(m.get('gone')).toMatchObject({ status: 'no_data' });
    expect(m.get('gone')?.views).toBeUndefined();
  });

  it('marks an auth failure as auth, so the caller stops instead of retrying', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'at', expires_in: 3600 }) } as never;
      }
      return { ok: false, status: 401, text: async () => 'invalid credentials' } as never;
    }));
    const m = await collectMetrics(client, 'rt', ['v1']);
    expect(m.get('v1')?.status).toBe('auth');
  });

  it('treats a quota 403 as a retryable error, not a dead credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'at', expires_in: 3600 }) } as never;
      }
      return { ok: false, status: 403, text: async () => '{"error":{"reason":"quotaExceeded"}}' } as never;
    }));
    const m = await collectMetrics(client, 'rt', ['v1']);
    expect(m.get('v1')?.status).toBe('error');
  });

  it('batches in 50s, because the API costs a unit per call not per id', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('oauth2.googleapis.com')) {
        return { ok: true, json: async () => ({ access_token: 'at', expires_in: 3600 }) } as never;
      }
      calls.push(String(url));
      return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) } as never;
    }));
    await collectMetrics(client, 'rt', Array.from({ length: 120 }, (_, i) => `v${i}`));
    expect(calls).toHaveLength(3);
  });

  it('does nothing at all for an empty list', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect((await collectMetrics(client, 'rt', [])).size).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });
});

describe('oauth', () => {
  it('asks for offline access AND consent, or no refresh token comes back', () => {
    const u = new URL(authorizeUrl(client, 'https://api.aaif.live', 'nonce'));
    // Both are needed. With only access_type a re-authorisation returns an
    // access token alone and the connection dies in an hour.
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    expect(u.searchParams.get('state')).toBe('nonce');
  });

  it('asks for upload, management and read-only analytics, and nothing wider', () => {
    const scopes = SCOPES.join(' ');
    expect(scopes).toContain('youtube.upload');
    expect(scopes).toContain('yt-analytics.readonly');
    // Never the full-account scope.
    expect(scopes).not.toContain('https://www.googleapis.com/auth/youtube ');
  });

  it('builds a redirect URI off the public API base', () => {
    expect(redirectUri('https://api.aaif.live/')).toBe(
      'https://api.aaif.live/api/modules/videos-publisher-youtube/oauth/callback',
    );
  });

  it('separates a dead credential from a transient failure', () => {
    expect(isAuthFailure(401, '')).toBe(true);
    expect(isAuthFailure(403, 'invalid_grant')).toBe(true);
    // Quota is transient and must NOT disconnect the channel.
    expect(isAuthFailure(403, '{"reason":"quotaExceeded"}')).toBe(false);
    expect(isAuthFailure(500, '')).toBe(false);
    expect(isAuthFailure(429, '')).toBe(false);
  });
});
