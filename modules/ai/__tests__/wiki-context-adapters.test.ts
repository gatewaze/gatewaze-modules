import { describe, it, expect } from 'vitest';
import {
  renderWikiContext,
  readWikiUseCaseConfig,
  registerWikiContextAdapter,
  getWikiContextAdapter,
  type WikiContextAdapter,
} from '../lib/wiki/context-adapters.js';
import type { SearchResult } from '../lib/wiki/repository.js';

function hit(slug: string, title: string, summary: string): SearchResult {
  return { use_case: 'uc', slug, kind: 'page', title, summary, snippet: summary, score: 1 };
}

/** Minimal ai_use_cases mock: from().select().eq().maybeSingle() → row. */
function mockUseCase(row: Record<string, unknown> | null, opts: { throwOnMode?: boolean } = {}) {
  return {
    from() {
      return {
        select(cols: string) {
          // Simulate the pre-migration case: selecting wiki_mode errors.
          const willThrow = opts.throwOnMode && cols.includes('wiki_mode');
          return {
            eq() {
              return {
                maybeSingle: () =>
                  willThrow
                    ? Promise.reject(new Error('column wiki_mode does not exist'))
                    : Promise.resolve({ data: row, error: null }),
              };
            },
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('renderWikiContext', () => {
  it('returns (none) when there are no hits', () => {
    expect(renderWikiContext([], 2000)).toBe('(none)');
  });

  it('formats a heading + one entry per hit', () => {
    const out = renderWikiContext([hit('lunch-and-learn/sessions/s15', 'Session 15', 'Stateful agents.')], 2000);
    expect(out).toContain('## Related prior write-ups');
    expect(out).toContain('### Session 15 — [lunch-and-learn/sessions/s15]');
    expect(out).toContain('Stateful agents.');
  });

  it('truncates to the token budget and appends an omitted-count line', () => {
    const many = Array.from({ length: 20 }, (_, i) => hit(`s/${i}`, `Title ${i}`, 'x'.repeat(300)));
    const out = renderWikiContext(many, 200); // tiny budget → few shown
    expect(out).toMatch(/> \(\d+ older matches? omitted\)/);
    // at least the heading + one entry survive
    expect(out).toContain('## Related prior write-ups');
    expect(out.length).toBeLessThan(many.reduce((n, h) => n + h.summary!.length, 0));
  });

  it('caps each excerpt at 300 chars', () => {
    const out = renderWikiContext([hit('s/1', 'T', 'y'.repeat(500))], 5000);
    const excerpt = out.split('\n').pop() ?? '';
    expect(excerpt.length).toBeLessThanOrEqual(300);
  });
});

describe('readWikiUseCaseConfig — effective mode precedence', () => {
  it('wiki_enabled=false forces off regardless of wiki_mode', async () => {
    const cfg = await readWikiUseCaseConfig(mockUseCase({ wiki_enabled: false, wiki_mode: 'context' }), 'uc');
    expect(cfg.mode).toBe('off');
  });
  it('wiki_mode=context is honoured when enabled', async () => {
    const cfg = await readWikiUseCaseConfig(mockUseCase({ wiki_enabled: true, wiki_mode: 'context', wiki_persist_enabled: true }), 'uc');
    expect(cfg.mode).toBe('context');
    expect(cfg.persistEnabled).toBe(true);
  });
  it('defaults to tools when wiki_mode is null', async () => {
    const cfg = await readWikiUseCaseConfig(mockUseCase({ wiki_enabled: true, wiki_mode: null }), 'uc');
    expect(cfg.mode).toBe('tools');
  });
  it('pre-migration (wiki_mode column missing) falls back to the legacy boolean', async () => {
    const off = await readWikiUseCaseConfig(mockUseCase({ wiki_enabled: false }, { throwOnMode: true }), 'uc');
    expect(off.mode).toBe('off');
    const on = await readWikiUseCaseConfig(mockUseCase({ wiki_enabled: true }, { throwOnMode: true }), 'uc');
    expect(on.mode).toBe('tools');
  });
  it('WIKI_RUNTIME_DISABLED=1 forces off', async () => {
    const prev = process.env.WIKI_RUNTIME_DISABLED;
    process.env.WIKI_RUNTIME_DISABLED = '1';
    try {
      const cfg = await readWikiUseCaseConfig(mockUseCase({ wiki_enabled: true, wiki_mode: 'tools' }), 'uc');
      expect(cfg.mode).toBe('off');
    } finally {
      if (prev === undefined) delete process.env.WIKI_RUNTIME_DISABLED;
      else process.env.WIKI_RUNTIME_DISABLED = prev;
    }
  });
});

describe('WikiContextAdapter registry', () => {
  it('registers and retrieves by use case; unknown → null', () => {
    const adapter: WikiContextAdapter = { recallQuery: () => null, persistPage: () => null };
    registerWikiContextAdapter('test-uc', adapter);
    expect(getWikiContextAdapter('test-uc')).toBe(adapter);
    expect(getWikiContextAdapter('nope')).toBeNull();
  });
});
