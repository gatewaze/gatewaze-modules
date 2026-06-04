import { describe, expect, it } from 'vitest';
import {
  mapLitellmRow,
  normalizeModelName,
  refreshFromLitellm,
  type SupabaseLike,
} from '../../../lib/prices/refresh-from-litellm.js';

const TODAY = '2026-06-04';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const FIXTURE_FULL: Record<string, unknown> = {
  // Anthropic — full row with caching + dated alias collapsing
  'claude-opus-4-5-20251022': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 15 / 1_000_000,
    output_cost_per_token: 75 / 1_000_000,
    cache_read_input_token_cost: 1.5 / 1_000_000,
    cache_creation_input_token_cost: 18.75 / 1_000_000,
    supports_function_calling: true,
    supports_web_search: true,
    display_name: 'Claude Opus 4.5',
  },
  'claude-sonnet-4-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 3 / 1_000_000,
    output_cost_per_token: 15 / 1_000_000,
    cache_read_input_token_cost: 0.3 / 1_000_000,
    supports_function_calling: true,
    display_name: 'Claude Sonnet 4.5',
  },
  'claude-haiku-4-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 0.8 / 1_000_000,
    output_cost_per_token: 4 / 1_000_000,
    cache_read_input_token_cost: 0.08 / 1_000_000,
    supports_function_calling: true,
    display_name: 'Claude Haiku 4.5',
  },
  'claude-opus-3-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 3 / 1_000_000,
    output_cost_per_token: 15 / 1_000_000,
    display_name: 'Claude Opus 3.5',
  },
  'claude-haiku-3-5': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 0.25 / 1_000_000,
    output_cost_per_token: 1.25 / 1_000_000,
    display_name: 'Claude Haiku 3.5',
  },
  // OpenAI
  'gpt-5': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 2.5 / 1_000_000,
    output_cost_per_token: 10 / 1_000_000,
    supports_function_calling: true,
  },
  'gpt-5-mini': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 0.4 / 1_000_000,
    output_cost_per_token: 1.6 / 1_000_000,
    supports_function_calling: true,
  },
  o3: {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 2 / 1_000_000,
    output_cost_per_token: 8 / 1_000_000,
    supports_function_calling: true,
  },
  'o3-mini': {
    litellm_provider: 'openai',
    mode: 'chat',
    input_cost_per_token: 1.1 / 1_000_000,
    output_cost_per_token: 4.4 / 1_000_000,
    supports_function_calling: true,
  },
  'text-embedding-3-small': {
    litellm_provider: 'openai',
    mode: 'embedding',
    input_cost_per_token: 0.02 / 1_000_000,
    output_cost_per_token: 0,
  },
  // Gemini
  'gemini-2.5-pro': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 1.25 / 1_000_000,
    output_cost_per_token: 5 / 1_000_000,
    supports_function_calling: true,
  },
  'gemini-2.5-flash': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 0.1 / 1_000_000,
    output_cost_per_token: 0.4 / 1_000_000,
  },
  'gemini-2.5-pro-preview-06-05': {
    // Date-suffixed alias of gemini-2.5-pro; should collapse onto it.
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 1.25 / 1_000_000,
    output_cost_per_token: 5 / 1_000_000,
  },
  'gemini-3-pro': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 1.25 / 1_000_000,
    output_cost_per_token: 5 / 1_000_000,
  },
  'gemini-flash-stub-1': {
    litellm_provider: 'gemini',
    mode: 'chat',
    input_cost_per_token: 0.05 / 1_000_000,
    output_cost_per_token: 0.2 / 1_000_000,
  },
  // Junk rows we should ignore
  'mistral-large': {
    litellm_provider: 'mistral',
    mode: 'chat',
    input_cost_per_token: 2 / 1_000_000,
    output_cost_per_token: 6 / 1_000_000,
  },
  'zero-cost-marker': {
    litellm_provider: 'anthropic',
    mode: 'chat',
    input_cost_per_token: 0,
    output_cost_per_token: 0,
  },
  sample_spec: { not_a_model: true },
};

// ─── Supabase stub ───────────────────────────────────────────────────────────

interface UpsertCall {
  rows: Array<Record<string, unknown>>;
  onConflict: string;
}

function makeStub(existingRows: Array<Record<string, unknown>> = []): {
  supabase: SupabaseLike;
  upserts: UpsertCall[];
} {
  const upserts: UpsertCall[] = [];
  const supabase: SupabaseLike = {
    from: () => ({
      select: () => ({
        order: async () => ({ data: existingRows as never, error: null }),
      }),
      upsert: async (rows, opts) => {
        upserts.push({ rows: rows as Array<Record<string, unknown>>, onConflict: opts.onConflict });
        return { error: null };
      },
    }),
  };
  return { supabase, upserts };
}

// ─── Pure-fn tests ───────────────────────────────────────────────────────────

describe('normalizeModelName', () => {
  it('strips Anthropic date suffix', () => {
    expect(normalizeModelName('anthropic', 'claude-opus-4-5-20251022')).toBe('claude-opus-4-5');
  });
  it('keeps Anthropic version when no date present', () => {
    expect(normalizeModelName('anthropic', 'claude-sonnet-4-5')).toBe('claude-sonnet-4-5');
  });
  it('strips Gemini preview suffix', () => {
    expect(normalizeModelName('gemini', 'gemini-2.5-pro-preview-06-05')).toBe('gemini-2.5-pro');
  });
  it('strips vertex_ai/ prefix', () => {
    expect(normalizeModelName('anthropic', 'vertex_ai/claude-opus-4-5')).toBe('claude-opus-4-5');
  });
  it('passes OpenAI names through unchanged', () => {
    expect(normalizeModelName('openai', 'gpt-5-mini')).toBe('gpt-5-mini');
  });
});

describe('mapLitellmRow', () => {
  it('multiplies per-token cost by 1M', () => {
    const row = mapLitellmRow(
      'claude-sonnet-4-5',
      FIXTURE_FULL['claude-sonnet-4-5'] as Record<string, unknown>,
      TODAY,
    );
    expect(row?.input_per_million_usd).toBe(3);
    expect(row?.output_per_million_usd).toBe(15);
    expect(row?.cached_per_million_usd).toBe(0.3);
  });

  it('returns null for non-kept providers', () => {
    expect(
      mapLitellmRow('mistral-large', FIXTURE_FULL['mistral-large'] as Record<string, unknown>, TODAY),
    ).toBeNull();
  });

  it('returns null for zero-cost rows (capability markers)', () => {
    expect(
      mapLitellmRow('zero-cost-marker', FIXTURE_FULL['zero-cost-marker'] as Record<string, unknown>, TODAY),
    ).toBeNull();
  });

  it('sets supports_embeddings when mode=embedding', () => {
    const row = mapLitellmRow(
      'text-embedding-3-small',
      FIXTURE_FULL['text-embedding-3-small'] as Record<string, unknown>,
      TODAY,
    );
    expect(row?.supports_embeddings).toBe(true);
    expect(row?.supports_chat).toBe(false);
  });

  it('falls back to humanized model name when display_name absent', () => {
    const row = mapLitellmRow('o3', FIXTURE_FULL['o3'] as Record<string, unknown>, TODAY);
    expect(row?.label).toContain('O-3');
  });
});

// ─── refreshFromLitellm end-to-end ───────────────────────────────────────────

describe('refreshFromLitellm', () => {
  it('writes new models with effective_from=today', async () => {
    const { supabase, upserts } = makeStub();
    const res = await refreshFromLitellm(supabase, {
      today: TODAY,
      fetcher: async () => FIXTURE_FULL,
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].onConflict).toBe('provider,model,effective_from');
    for (const row of upserts[0].rows) {
      expect(row.effective_from).toBe(TODAY);
    }
    expect(res.written).toBe(upserts[0].rows.length);
    expect(res.changedModels.length).toBe(upserts[0].rows.length);
  });

  it('collapses dated aliases onto the canonical model id', async () => {
    const { supabase, upserts } = makeStub();
    await refreshFromLitellm(supabase, { today: TODAY, fetcher: async () => FIXTURE_FULL });
    const opus = upserts[0].rows.filter(
      (r) => r.provider === 'anthropic' && r.model === 'claude-opus-4-5',
    );
    expect(opus).toHaveLength(1);
    const geminiPro = upserts[0].rows.filter(
      (r) => r.provider === 'gemini' && r.model === 'gemini-2.5-pro',
    );
    expect(geminiPro).toHaveLength(1);
  });

  it('skips models whose pricing matches the latest existing row', async () => {
    // Pre-seed prod with exact same prices for gpt-5; the refresh should
    // leave it alone (history rows are precious — only write on change).
    const existing = [
      {
        provider: 'openai',
        model: 'gpt-5',
        effective_from: '2026-05-20',
        input_per_million_usd: 2.5,
        output_per_million_usd: 10,
        cached_per_million_usd: null,
        cache_creation_per_million_usd: null,
        image_per_image_usd: null,
        supports_chat: true,
        supports_tools: true,
        supports_web_search: false,
        supports_image_gen: false,
        supports_embeddings: false,
        label: 'GPT-5',
      },
    ];
    const { supabase, upserts } = makeStub(existing);
    await refreshFromLitellm(supabase, { today: TODAY, fetcher: async () => FIXTURE_FULL });
    const wroteGpt5 = upserts[0]?.rows.some(
      (r) => r.provider === 'openai' && r.model === 'gpt-5',
    );
    expect(wroteGpt5).toBe(false);
  });

  it('writes a new effective-dated row when a price changes', async () => {
    const existing = [
      {
        provider: 'openai',
        model: 'gpt-5',
        effective_from: '2026-05-20',
        input_per_million_usd: 5, // different from fixture
        output_per_million_usd: 10,
        cached_per_million_usd: null,
        cache_creation_per_million_usd: null,
        image_per_image_usd: null,
        supports_chat: true,
        supports_tools: true,
        supports_web_search: false,
        supports_image_gen: false,
        supports_embeddings: false,
        label: 'GPT-5',
      },
    ];
    const { supabase, upserts } = makeStub(existing);
    const res = await refreshFromLitellm(supabase, { today: TODAY, fetcher: async () => FIXTURE_FULL });
    const gpt5 = upserts[0].rows.find(
      (r) => r.provider === 'openai' && r.model === 'gpt-5',
    );
    expect(gpt5).toBeDefined();
    expect(gpt5?.effective_from).toBe(TODAY);
    expect(res.changedModels.some((c) => c.model === 'gpt-5' && /input_per_million_usd/.test(c.reason))).toBe(true);
  });

  it('refuses to write when a kept provider returns <5 rows (poisoned feed guard)', async () => {
    const poisoned: Record<string, unknown> = {
      // Only ONE OpenAI entry — below the threshold
      'gpt-5': FIXTURE_FULL['gpt-5'],
      // ... pad the others so only OpenAI trips the check
      'claude-opus-4-5-20251022': FIXTURE_FULL['claude-opus-4-5-20251022'],
      'claude-sonnet-4-5': FIXTURE_FULL['claude-sonnet-4-5'],
      'claude-haiku-4-5': FIXTURE_FULL['claude-haiku-4-5'],
      'claude-opus-3-5': FIXTURE_FULL['claude-opus-3-5'],
      'claude-haiku-3-5': FIXTURE_FULL['claude-haiku-3-5'],
      'gemini-2.5-pro': FIXTURE_FULL['gemini-2.5-pro'],
      'gemini-2.5-flash': FIXTURE_FULL['gemini-2.5-flash'],
      'gemini-3-pro': FIXTURE_FULL['gemini-3-pro'],
      'gemini-flash-stub-1': FIXTURE_FULL['gemini-flash-stub-1'],
      'gemini-2.5-pro-preview-06-05': FIXTURE_FULL['gemini-2.5-pro-preview-06-05'],
    };
    const { supabase, upserts } = makeStub();
    await expect(
      refreshFromLitellm(supabase, { today: TODAY, fetcher: async () => poisoned }),
    ).rejects.toThrow(/refusing to write/);
    expect(upserts).toHaveLength(0);
  });

  it('throws if the upstream payload is not an object', async () => {
    const { supabase } = makeStub();
    await expect(
      refreshFromLitellm(supabase, { today: TODAY, fetcher: async () => null }),
    ).rejects.toThrow(/non-object/);
  });

  it('passes the supabase read error through', async () => {
    const supabase: SupabaseLike = {
      from: () => ({
        select: () => ({
          order: async () => ({ data: null, error: { message: 'db down' } }),
        }),
        upsert: async () => ({ error: null }),
      }),
    };
    await expect(
      refreshFromLitellm(supabase, { today: TODAY, fetcher: async () => FIXTURE_FULL }),
    ).rejects.toThrow(/db down/);
  });
});
