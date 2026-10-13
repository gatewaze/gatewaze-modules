import { afterEach, describe, expect, it, vi } from 'vitest';

// slackService imports the core supabase client; getSlackOAuthUrl does not
// use it, so it is stubbed to let the file load standalone.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { getSlackOAuthUrl } from '../slackService';

const ADMIN_ORIGIN = 'https://admin.example.test';
const SUPABASE_URL = 'https://project.supabase.co';
// Must equal the callback URL the server registers, `${SUPABASE_URL}/functions/v1/...`,
// or Slack rejects the authorize request with bad_redirect_uri.
const CALLBACK = `${SUPABASE_URL}/functions/v1/slack-oauth-callback`;

const redirect = (u: string) => new URL(u).searchParams.get('redirect_uri');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getSlackOAuthUrl', () => {
  it('host-session: uses the public URL for redirect_uri, not the admin origin', () => {
    vi.stubEnv('VITE_SLACK_CLIENT_ID', 'cid');
    vi.stubEnv('VITE_SUPABASE_URL', ADMIN_ORIGIN);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', SUPABASE_URL);
    expect(redirect(getSlackOAuthUrl('e1'))).toBe(CALLBACK);
  });

  it('older admin or local mode: falls back to VITE_SUPABASE_URL when the public URL is unset', () => {
    vi.stubEnv('VITE_SLACK_CLIENT_ID', 'cid');
    vi.stubEnv('VITE_SUPABASE_URL', SUPABASE_URL);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', undefined);
    expect(redirect(getSlackOAuthUrl('e1'))).toBe(CALLBACK);
  });

  it('strips a trailing slash so redirect_uri matches the server callback exactly', () => {
    vi.stubEnv('VITE_SLACK_CLIENT_ID', 'cid');
    vi.stubEnv('VITE_SUPABASE_URL', ADMIN_ORIGIN);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', `${SUPABASE_URL}/`);
    expect(redirect(getSlackOAuthUrl('e1'))).toBe(CALLBACK);
  });

  it('throws, naming both URL variables, when neither is set', () => {
    vi.stubEnv('VITE_SLACK_CLIENT_ID', 'cid');
    vi.stubEnv('VITE_SUPABASE_URL', undefined);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', undefined);
    expect(() => getSlackOAuthUrl('e1')).toThrow(/VITE_SUPABASE_PUBLIC_URL and VITE_SUPABASE_URL/);
  });
});
