import { afterEach, describe, expect, it, vi } from 'vitest';
import { publicSupabaseUrl } from '../publicSupabaseUrl';

const ADMIN_ORIGIN = 'https://admin.example.test';
const SUPABASE_URL = 'https://project.supabase.co';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('publicSupabaseUrl', () => {
  it('host-session: returns VITE_SUPABASE_PUBLIC_URL, not the admin origin', () => {
    vi.stubEnv('VITE_SUPABASE_URL', ADMIN_ORIGIN);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', SUPABASE_URL);
    expect(publicSupabaseUrl()).toBe(SUPABASE_URL);
  });

  it('older admin or local mode: falls back to VITE_SUPABASE_URL when the public URL is unset', () => {
    vi.stubEnv('VITE_SUPABASE_URL', SUPABASE_URL);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', undefined);
    expect(publicSupabaseUrl()).toBe(SUPABASE_URL);
  });

  it('falls back to VITE_SUPABASE_URL when the public URL is set but empty', () => {
    vi.stubEnv('VITE_SUPABASE_URL', SUPABASE_URL);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', '');
    expect(publicSupabaseUrl()).toBe(SUPABASE_URL);
  });

  it('strips trailing slashes from the public URL', () => {
    vi.stubEnv('VITE_SUPABASE_URL', ADMIN_ORIGIN);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', `${SUPABASE_URL}//`);
    expect(publicSupabaseUrl()).toBe(SUPABASE_URL);
  });

  it('strips trailing slashes from the fallback URL', () => {
    vi.stubEnv('VITE_SUPABASE_URL', `${SUPABASE_URL}/`);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', undefined);
    expect(publicSupabaseUrl()).toBe(SUPABASE_URL);
  });

  it.each([
    ['plain http on a public host', 'http://project.supabase.co'],
    ['a non-http scheme', 'javascript:alert(1)'],
    ['a relative value', '/supabase'],
    ['an unparseable value', 'not a url'],
  ])('ignores a public URL that is %s and falls back', (_label, value) => {
    vi.stubEnv('VITE_SUPABASE_URL', ADMIN_ORIGIN);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', value);
    expect(publicSupabaseUrl()).toBe(ADMIN_ORIGIN);
  });

  it.each([
    'http://localhost:54321',
    'http://127.0.0.1:54321',
    'http://supabase.gatewaze.localhost',
  ])('allows http on a loopback host: %s', (value) => {
    vi.stubEnv('VITE_SUPABASE_URL', ADMIN_ORIGIN);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', value);
    expect(publicSupabaseUrl()).toBe(value);
  });

  it('returns an empty string, without throwing, when neither is set', () => {
    vi.stubEnv('VITE_SUPABASE_URL', undefined);
    vi.stubEnv('VITE_SUPABASE_PUBLIC_URL', undefined);
    expect(publicSupabaseUrl()).toBe('');
  });
});
