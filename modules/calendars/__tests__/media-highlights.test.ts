import { beforeEach, describe, expect, it, vi } from 'vitest';

// A chainable stand-in for the anon supabase client the portal helpers make.
const state: { links: unknown[]; media: unknown[]; bases: Record<string, string | null>; rpc: ReturnType<typeof vi.fn> } = {
  links: [],
  media: [],
  bases: {},
  rpc: vi.fn(),
};

function chain(result: () => unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'or', 'order', 'range', 'limit', 'like', 'neq']) q[m] = () => q;
  q.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve);
  return q;
}

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: (table: string) => chain(() => (table === 'calendars_events' ? { data: state.links } : { data: state.media, error: null })),
    rpc: state.rpc,
  }),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));

process.env.SUPABASE_URL = 'https://abc.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';

const EVENT = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  state.links = [{ events: { id: EVENT, event_id: 'e1', event_slug: 'party', event_title: 'Party' } }];
  state.bases = { 'r2|autodb-media': 'https://media.example.com' };
  state.rpc = vi.fn(async (_fn: string, args: { p_provider: string; p_bucket: string | null }) => ({
    data: state.bases[`${args.p_provider}|${args.p_bucket}`] ?? null,
    error: null,
  }));
});

const row = (id: string, over: Record<string, unknown>) => ({
  id,
  host_id: EVENT,
  mime_type: 'image/jpeg',
  caption: null,
  created_at: '2026-11-02T10:00:00Z',
  storage_path: `event/${EVENT}/${id}/a b.jpg`,
  storage_provider: 'supabase',
  storage_bucket: null,
  ...over,
});

describe('getCalendarMediaHighlights', () => {
  it('gives Supabase rows the Supabase address and R2 rows the R2 domain', async () => {
    state.media = [row('m1', {}), row('m2', { storage_provider: 'r2', storage_bucket: 'autodb-media' })];
    const { getCalendarMediaHighlights } = await import('../portal/lib/calendars');
    const out = await getCalendarMediaHighlights('cal');
    expect(out.map((i) => i.url)).toEqual([
      `https://abc.supabase.co/storage/v1/object/public/media/event/${EVENT}/m1/a b.jpg`,
      `https://media.example.com/event/${EVENT}/m2/a%20b.jpg`,
    ]);
    expect(out[1]!.thumbnail_url).toBe(out[1]!.url);
  });

  it('asks for each provider and bucket once', async () => {
    state.media = [
      row('m1', { storage_provider: 'r2', storage_bucket: 'autodb-media' }),
      row('m2', { storage_provider: 'r2', storage_bucket: 'autodb-media' }),
    ];
    const { getCalendarMediaHighlights } = await import('../portal/lib/calendars');
    await getCalendarMediaHighlights('cal');
    expect(state.rpc).toHaveBeenCalledTimes(1);
    expect(state.rpc).toHaveBeenCalledWith('host_media_public_base', { p_provider: 'r2', p_bucket: 'autodb-media' });
  });

  it('leaves out rows with no public address rather than linking the wrong host', async () => {
    state.media = [
      row('m1', { storage_provider: 'r2', storage_bucket: 'unknown-bucket' }),
      row('m2', { storage_bucket: 'another-supabase-bucket' }),
      row('m3', {}),
    ];
    state.bases['r2|evil'] = 'javascript:alert(1)';
    const { getCalendarMediaHighlights } = await import('../portal/lib/calendars');
    const out = await getCalendarMediaHighlights('cal');
    expect(out.map((i) => i.id)).toEqual(['m3']);
  });

  it('refuses a public base that is not a plain https origin', async () => {
    state.media = [row('m1', { storage_provider: 'r2', storage_bucket: 'evil' })];
    state.bases['r2|evil'] = 'https://media.example.com/../x';
    const { getCalendarMediaHighlights } = await import('../portal/lib/calendars');
    expect(await getCalendarMediaHighlights('cal')).toEqual([]);
  });
});
