import { describe, expect, it } from 'vitest';
import { toPublicImageUrl } from '../public-images';

const supabaseEnv = { SUPABASE_PUBLIC_URL: 'https://data.aaif.live/', SUPABASE_URL: 'http://supabase-kong:8000' };

describe('toPublicImageUrl', () => {
  it('builds the Supabase public URL from the public base, not the internal one', () => {
    expect(toPublicImageUrl('calendars/CAL-AAIFLONDON-cover.png', supabaseEnv))
      .toBe('https://data.aaif.live/storage/v1/object/public/media/calendars/CAL-AAIFLONDON-cover.png');
  });

  it('falls back to SUPABASE_URL when there is no public base', () => {
    expect(toPublicImageUrl('calendars/x.png', { SUPABASE_URL: 'https://data.example.org' }))
      .toBe('https://data.example.org/storage/v1/object/public/media/calendars/x.png');
  });

  it('uses STORAGE_PUBLIC_URL when the brand has moved off Supabase Storage', () => {
    expect(toPublicImageUrl('calendars/x.png', { ...supabaseEnv, STORAGE_PUBLIC_URL: 'https://media.example.org' }))
      .toBe('https://media.example.org/calendars/x.png');
  });

  it('passes absolute http(s) URLs through', () => {
    const url = 'https://images.lumacdn.com/calendar-cover-images/x.png';
    expect(toPublicImageUrl(url, supabaseEnv)).toBe(url);
  });

  it('encodes path segments and strips a leading slash', () => {
    expect(toPublicImageUrl('/calendars/a b#c.png', supabaseEnv))
      .toBe('https://data.aaif.live/storage/v1/object/public/media/calendars/a%20b%23c.png');
  });

  it('returns null for empty, non-string, traversal and non-http values', () => {
    for (const v of [null, undefined, '', '   ', 42, '../secret.png', 'calendars/../x', 'javascript:alert(1)', 'data:image/png;base64,AAAA']) {
      expect(toPublicImageUrl(v, supabaseEnv)).toBeNull();
    }
  });

  it('returns null when no base URL is configured', () => {
    expect(toPublicImageUrl('calendars/x.png', {})).toBeNull();
  });
});
