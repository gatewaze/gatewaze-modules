/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  WebhookHub,
  fillTemplate,
  type MutationEvent,
  type WebhookEventTopic,
  type WebhookSubscriptionRow,
} from '../../lib/webhook-hub.js';

// ---------------------------------------------------------------------------
// In-memory Supabase mock — captures table writes/reads. The hub only ever
// touches webhook_subscriptions and webhook_deliveries via .from() chains.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

class FakeSupabase {
  tables: Record<string, Row[]> = {
    webhook_subscriptions: [],
    webhook_deliveries: [],
    webhook_event_topics: [],
  };

  from(table: string) {
    if (!this.tables[table]) this.tables[table] = [];
    return new Q(this.tables, table);
  }
}

class Q {
  // 'pending' state: SELECT mode or UPDATE/INSERT mode
  private mode: 'select' | 'insert' | 'update' | 'delete' | null = null;
  private cols = '';
  private updates: Row | null = null;
  private inserts: Row[] = [];
  private filters: Array<(r: Row) => boolean> = [];

  constructor(private store: Record<string, Row[]>, private table: string) {}

  select(cols: string) { this.cols = cols; if (!this.mode) this.mode = 'select'; return this; }
  insert(values: Row | Row[]) { this.mode = 'insert'; this.inserts = Array.isArray(values) ? values : [values]; return this; }
  update(values: Row) { this.mode = 'update'; this.updates = values; return this; }
  delete() { this.mode = 'delete'; return this; }
  eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
  in(col: string, vals: unknown[]) {
    const set = new Set(vals);
    this.filters.push((r) => set.has(r[col]));
    return this;
  }
  contains() { return this; }
  or() { return this; }
  lt(col: string, val: unknown) { this.filters.push((r) => String(r[col]) < String(val)); return this; }
  limit() { return this; }

  private matchedRows(): Row[] {
    return (this.store[this.table] ?? []).filter((r) => this.filters.every((f) => f(r)));
  }

  async single<T>() {
    const rows = await this.run();
    return { data: (rows.data?.[0] as T) ?? null, error: rows.data && rows.data.length ? null : (rows.error ?? null) };
  }
  async maybeSingle<T>() {
    const rows = await this.run();
    return { data: (rows.data?.[0] as T) ?? null, error: null };
  }
  then<TResult>(onfulfilled: (v: { data: Row[] | null; error: { message: string } | null }) => TResult): Promise<TResult> {
    return this.run().then(onfulfilled) as Promise<TResult>;
  }

  private async run(): Promise<{ data: Row[] | null; error: { message: string } | null }> {
    if (!this.store[this.table]) this.store[this.table] = [];
    const arr = this.store[this.table] as Row[];

    if (this.mode === 'insert') {
      for (const v of this.inserts) arr.push({ ...v });
      return { data: this.inserts, error: null };
    }
    if (this.mode === 'update') {
      const matched = this.matchedRows();
      for (const r of matched) Object.assign(r, this.updates ?? {});
      return { data: matched, error: null };
    }
    if (this.mode === 'delete') {
      const remaining = arr.filter((r) => !this.filters.every((f) => f(r)));
      this.store[this.table] = remaining;
      return { data: null, error: null };
    }
    // select
    return { data: this.matchedRows(), error: null };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const SAMPLE_TOPIC: WebhookEventTopic = {
  topic: 'daily_briefing_items',
  host_id_column: 'site_id',
  surrogate_key_template: 'daily-briefing',
  detail_key_template: 'daily-briefing:{slug}',
  notify_columns: ['slug'],
};

function makeSub(over: Partial<WebhookSubscriptionRow> = {}): WebhookSubscriptionRow {
  return {
    id: 'sub-1',
    host_kind: 'site',
    host_id: 'site-1',
    url: 'https://theme.example/api/revalidate',
    topics: [],
    secret: 'a'.repeat(64),
    secret_previous: null,
    status: 'enabled',
    consecutive_failures: 0,
    ...over,
  };
}

function makeEvent(over: Partial<MutationEvent> = {}): MutationEvent {
  return {
    topic: 'daily_briefing_items',
    op: 'update',
    row_id: '00000000-0000-0000-0000-00000000abcd',
    row: { slug: 'claude-managed-agents' },
    host_kind: 'site',
    host_id: 'site-1',
    ts: 1715000000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// fillTemplate
// ---------------------------------------------------------------------------

describe('fillTemplate', () => {
  it('returns the template unchanged when no placeholders', () => {
    expect(fillTemplate('daily-briefing', {})).toBe('daily-briefing');
  });
  it('substitutes a single placeholder', () => {
    expect(fillTemplate('blog:{slug}', { slug: 'hello' })).toBe('blog:hello');
  });
  it('substitutes multiple placeholders', () => {
    expect(fillTemplate('{a}:{b}', { a: 'x', b: 'y' })).toBe('x:y');
  });
  it('returns null when a required field is missing', () => {
    expect(fillTemplate('blog:{slug}', { other: 'x' })).toBeNull();
  });
  it('returns null when a required field is null', () => {
    expect(fillTemplate('blog:{slug}', { slug: null })).toBeNull();
  });
  it('returns null when a required field is empty string', () => {
    expect(fillTemplate('blog:{slug}', { slug: '' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WebhookHub — debounce + delivery
// ---------------------------------------------------------------------------

describe('WebhookHub.delivery', () => {
  let supabase: FakeSupabase;
  let logger: ReturnType<typeof makeLogger>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let hub: WebhookHub;

  beforeEach(() => {
    supabase = new FakeSupabase();
    logger = makeLogger();
    fetchMock = vi.fn();
  });

  function build(opts: Partial<ConstructorParameters<typeof WebhookHub>[0]> = {}) {
    hub = new WebhookHub({
      supabase: supabase as any,
      logger,
      cloudflarePurger: null,
      topicProvider: async (t) => (t === SAMPLE_TOPIC.topic ? SAMPLE_TOPIC : null),
      debounceMs: 10,
      fetchImpl: fetchMock as unknown as typeof fetch,
      ...opts,
    });
    return hub;
  }

  it('coalesces multiple events for the same host into one delivery', async () => {
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    build();
    hub.enqueue(makeEvent({ row: { slug: 'a' } }));
    hub.enqueue(makeEvent({ row: { slug: 'b' } }));
    hub.enqueue(makeEvent({ row: { slug: 'c' } }));
    await wait(40);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // Bulk key + 3 detail keys
    expect(new Set(body.surrogate_keys)).toEqual(
      new Set(['daily-briefing', 'daily-briefing:a', 'daily-briefing:b', 'daily-briefing:c']),
    );
    expect(supabase.tables['webhook_deliveries']).toHaveLength(1);
    expect(supabase.tables['webhook_deliveries'][0]!['status']).toBe('sent');
    hub.shutdown();
  });

  it('signs the request with HMAC-SHA256 and sets all required headers', async () => {
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    build();
    hub.enqueue(makeEvent());
    await wait(40);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers['x-gatewaze-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['x-gatewaze-timestamp']).toMatch(/^\d+$/);
    expect(headers['x-gatewaze-event-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers['x-gatewaze-delivery-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers['content-type']).toBe('application/json');
    hub.shutdown();
  });

  it('does NOT fan out when no subscriptions match', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    build();
    hub.enqueue(makeEvent());
    await wait(40);
    expect(fetchMock).not.toHaveBeenCalled();
    hub.shutdown();
  });

  it('skips delivery when topic is unknown', async () => {
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    build({ topicProvider: async () => null });
    hub.enqueue(makeEvent());
    await wait(40);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('webhooks.unknown_topic', expect.any(Object));
    hub.shutdown();
  });

  it('filters subscriptions by topics array', async () => {
    supabase.tables['webhook_subscriptions'] = [
      makeSub({ id: 'sub-match', topics: ['daily_briefing_items'] }),
      makeSub({ id: 'sub-miss', topics: ['blog_posts'] }),
    ];
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    build();
    hub.enqueue(makeEvent());
    await wait(40);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(supabase.tables['webhook_deliveries']).toHaveLength(1);
    expect(supabase.tables['webhook_deliveries'][0]!['subscription_id']).toBe('sub-match');
    hub.shutdown();
  });

  it('marks the delivery as failed and schedules a retry on 500', async () => {
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    build();
    hub.enqueue(makeEvent());
    await wait(40);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(supabase.tables['webhook_deliveries']).toHaveLength(1);
    const row = supabase.tables['webhook_deliveries'][0]!;
    expect(row['status']).toBe('failed');
    expect(row['attempt_count']).toBe(1);
    expect(row['next_retry_at']).toBeTruthy();
    expect(row['last_response_status']).toBe(500);
    hub.shutdown();
  });

  it('auto-suspends a subscription after 10 consecutive permanent failures', async () => {
    supabase.tables['webhook_subscriptions'] = [makeSub({ consecutive_failures: 9 })];
    fetchMock.mockResolvedValue(new Response('nope', { status: 500 }));
    // Force the single-attempt permanent path by overriding the retry
    // schedule: the hub reads RETRY_DELAYS_MS internally, so we simulate
    // by repeatedly enqueuing events; the simplest path is to make the
    // request fail enough times. Each enqueue is a new event_id, hence
    // a new delivery; we just need ONE delivery that runs out of
    // retries. Easier path: shrink RETRY_DELAYS by using the test
    // injection point — we don't have one, so instead drive 6 retries
    // by mocking setTimeout to fire immediately.
    vi.useFakeTimers();
    try {
      build({ debounceMs: 5 });
      hub.enqueue(makeEvent());
      // Drain debounce window + every retry (30s, 2m, 10m, 1h, 6h, 24h)
      await vi.advanceTimersByTimeAsync(6); // debounce
      // Allow the promise chain to flush
      await Promise.resolve();
      for (const ms of [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000]) {
        await vi.advanceTimersByTimeAsync(ms);
        await Promise.resolve();
      }
      // Allow final post-fetch micro-tasks
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
    const sub = supabase.tables['webhook_subscriptions'][0]!;
    expect(sub['status']).toBe('suspended');
    expect((sub['consecutive_failures'] as number)).toBeGreaterThanOrEqual(10);
    hub.shutdown();
  });

  it('writes pending row BEFORE the HTTP call (idempotency baseline)', async () => {
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    let observedAtFetchTime: number | null = null;
    fetchMock.mockImplementation(async () => {
      observedAtFetchTime = supabase.tables['webhook_deliveries']?.length ?? 0;
      return new Response('ok', { status: 200 });
    });
    build();
    hub.enqueue(makeEvent());
    await wait(40);
    expect(observedAtFetchTime).toBe(1);
    hub.shutdown();
  });

  it('auto-disables on 410 Gone', async () => {
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    fetchMock.mockResolvedValue(new Response('gone', { status: 410 }));
    build();
    hub.enqueue(makeEvent());
    await wait(40);
    const sub = supabase.tables['webhook_subscriptions'][0]!;
    expect(sub['status']).toBe('disabled');
    expect(supabase.tables['webhook_deliveries'][0]!['status']).toBe('permanently_failed');
    hub.shutdown();
  });

  it('skips the detail key when notify_columns are missing from row', async () => {
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    build();
    hub.enqueue(makeEvent({ row: {} })); // no slug
    await wait(40);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // Only the bulk key — no detail key.
    expect(body.surrogate_keys).toEqual(['daily-briefing']);
    hub.shutdown();
  });

  it('uses op=burst when more than 5 events coalesce', async () => {
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }));
    build();
    for (let i = 0; i < 6; i++) {
      hub.enqueue(makeEvent({ row: { slug: `slug-${i}` } }));
    }
    await wait(40);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.op).toBe('burst');
    expect(body.burst.event_count).toBe(6);
    hub.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Cloudflare purge
// ---------------------------------------------------------------------------

describe('WebhookHub.cloudflare', () => {
  it('invokes the purger with the unioned surrogate keys', async () => {
    const supabase = new FakeSupabase();
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    const purgeSpy = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const hub = new WebhookHub({
      supabase: supabase as any,
      logger: makeLogger(),
      cloudflarePurger: { purgeTags: purgeSpy },
      topicProvider: async () => SAMPLE_TOPIC,
      debounceMs: 5,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    hub.enqueue(makeEvent({ row: { slug: 'a' } }));
    hub.enqueue(makeEvent({ row: { slug: 'b' } }));
    await wait(30);
    expect(purgeSpy).toHaveBeenCalledOnce();
    const tags = purgeSpy.mock.calls[0]![0];
    expect(new Set(tags)).toEqual(
      new Set(['daily-briefing', 'daily-briefing:a', 'daily-briefing:b']),
    );
    hub.shutdown();
  });

  it('continues delivery when the purger rejects', async () => {
    const supabase = new FakeSupabase();
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const logger = makeLogger();
    const hub = new WebhookHub({
      supabase: supabase as any,
      logger,
      cloudflarePurger: { purgeTags: async () => { throw new Error('cf down'); } },
      topicProvider: async () => SAMPLE_TOPIC,
      debounceMs: 5,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    hub.enqueue(makeEvent());
    await wait(30);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('webhooks.cloudflare_purge_failed', expect.any(Object));
    hub.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Recovery sweep
// ---------------------------------------------------------------------------

describe('WebhookHub.runRecoverySweep', () => {
  it('re-enqueues pending rows older than 10s + failed rows whose retry has passed', async () => {
    const supabase = new FakeSupabase();
    const past = new Date(Date.now() - 60_000).toISOString();
    supabase.tables['webhook_subscriptions'] = [makeSub()];
    supabase.tables['webhook_deliveries'] = [
      {
        id: 'd-pending',
        subscription_id: 'sub-1',
        event_id: 'ev-1',
        topic: 'daily_briefing_items',
        op: 'update',
        row_id: null,
        payload: {
          id: 'd-pending',
          event_id: 'ev-1',
          delivered_at: 1715000000,
          host_kind: 'site',
          host_id: 'site-1',
          topic: 'daily_briefing_items',
          op: 'update',
          row_id: null,
          row: {},
          surrogate_keys: ['daily-briefing'],
        },
        surrogate_keys: ['daily-briefing'],
        status: 'pending',
        attempt_count: 0,
        next_retry_at: null,
        created_at: past,
      },
      {
        id: 'd-failed',
        subscription_id: 'sub-1',
        event_id: 'ev-2',
        topic: 'daily_briefing_items',
        op: 'update',
        row_id: null,
        payload: {
          id: 'd-failed',
          event_id: 'ev-2',
          delivered_at: 1715000000,
          host_kind: 'site',
          host_id: 'site-1',
          topic: 'daily_briefing_items',
          op: 'update',
          row_id: null,
          row: {},
          surrogate_keys: ['daily-briefing'],
        },
        surrogate_keys: ['daily-briefing'],
        status: 'failed',
        attempt_count: 1,
        next_retry_at: past,
        created_at: past,
      },
    ];
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const hub = new WebhookHub({
      supabase: supabase as any,
      logger: makeLogger(),
      cloudflarePurger: null,
      topicProvider: async () => SAMPLE_TOPIC,
      debounceMs: 5,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const out = await hub.runRecoverySweep();
    expect(out.recovered).toBe(2);
    // Wait for jittered retries to fire (max RECOVERY_JITTER_MS = 60_000;
    // we don't want a 60s test, so we just assert the counter and trust
    // the timer was registered).
    hub.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------------

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
