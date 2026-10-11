/**
 * Publication copy (lib/publication-copy.ts).
 *
 * Two things matter here. The fallback must always produce something, because
 * an editor with no title has nothing to edit. And renderChapters must refuse
 * an almost-valid list, because YouTube silently declines to draw a chapter
 * bar rather than telling anyone.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  applyRecipeResult,
  generatePublicationCopy,
  renderChapters,
  resolveProfile,
  templateCopy,
} from '../lib/publication-copy.js';

const ctx = {
  talkTitle: 'Most MCP Servers are Empty',
  speakers: [{ name: 'Liran Tal', role: 'Developer Advocate', company: 'Snyk' }],
  eventName: 'AGNTCon Europe',
  platform: 'youtube',
  profile: 'foundation',
};

/** A supabase double for the two tables this file reads. */
function db(rows: Record<string, unknown[]>) {
  return {
    from: (t: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = () => q;
      q.maybeSingle = async () => ({ data: (rows[t] ?? [])[0] ?? null, error: null });
      return q;
    },
  };
}

describe('templateCopy', () => {
  it('always returns something to edit', () => {
    const c = templateCopy(ctx as never, 'use_case_unbound');
    expect(c.title).toBe('Most MCP Servers are Empty');
    expect(c.description.length).toBeGreaterThan(0);
    expect(c.source).toBe('template');
    expect(c.fallbackReason).toBe('use_case_unbound');
  });

  it('never invents hashtags', () => {
    // @AgenticAI-Foundation uses none on any of its 15 most recent videos,
    // and choosing topical tags is a judgement the recipe makes, not a
    // template.
    expect(templateCopy(ctx as never, 'x').hashtags).toEqual([]);
    expect(templateCopy({ ...ctx, profile: 'live' } as never, 'x').hashtags).toEqual([]);
  });

  it('still produces a title with no programme data at all', () => {
    expect(templateCopy({ talkTitle: '', platform: 'youtube' } as never, 'x').title).toBeTruthy();
  });
});

describe('generatePublicationCopy', () => {
  it('falls back to the template when the use case is unbound', async () => {
    const c = await generatePublicationCopy(db({ ai_use_cases: [] }) as never, ctx as never, {
      dispatch: async () => ({ ok: true, runId: 'r1' }),
    });
    expect(c.source).toBe('template');
    expect(c.fallbackReason).toBe('use_case_unbound');
  });

  it('falls back when there is no dispatcher, without touching the database', async () => {
    const from = vi.fn();
    const c = await generatePublicationCopy({ from } as never, ctx as never, {});
    expect(c.fallbackReason).toBe('no_dispatcher');
    expect(from).not.toHaveBeenCalled();
  });

  it('falls back when the dispatch fails rather than throwing', async () => {
    const bound = db({ ai_use_cases: [{ recipe_source_id: 's', recipe_file_path: 'recipes/x/recipe.yaml' }] });
    const c = await generatePublicationCopy(bound as never, ctx as never, {
      dispatch: async () => ({ ok: false, reason: 'recipe_missing' }),
    });
    expect(c.source).toBe('template');
    expect(c.fallbackReason).toBe('recipe_missing');
  });

  it('falls back when the dispatcher throws', async () => {
    const bound = db({ ai_use_cases: [{ recipe_source_id: 's', recipe_file_path: 'recipes/x/recipe.yaml' }] });
    const c = await generatePublicationCopy(bound as never, ctx as never, {
      dispatch: async () => { throw new Error('queue is down'); },
    });
    expect(c.source).toBe('template');
    expect(c.fallbackReason).toContain('queue is down');
  });

  it('sends the channel profile to the recipe, because the channels differ', async () => {
    const bound = db({ ai_use_cases: [{ recipe_source_id: 's', recipe_file_path: 'recipes/x/recipe.yaml' }] });
    const dispatch = vi.fn(async () => ({ ok: true, runId: 'r1' }));
    await generatePublicationCopy(bound as never, { ...ctx, profile: 'live' } as never, { dispatch });
    expect(dispatch.mock.calls[0][0].channel_profile).toBe('live');
  });

  it('returns the template immediately rather than waiting on the model', async () => {
    const bound = db({ ai_use_cases: [{ recipe_source_id: 's', recipe_file_path: 'recipes/x/recipe.yaml' }] });
    const c = await generatePublicationCopy(bound as never, ctx as never, {
      dispatch: async () => ({ ok: true, runId: 'r1' }),
    });
    // An editor should never sit on a spinner for a model call.
    expect(c.title).toBeTruthy();
    expect(c.fallbackReason).toBe('awaiting_recipe');
    expect(c.runId).toBe('r1');
  });
});

describe('resolveProfile', () => {
  it('resolves from the ACCOUNT, because one platform has two house styles', async () => {
    const d = db({ video_channel_profiles: [{ profile: 'live' }] });
    expect(await resolveProfile(d as never, 'youtube', 'UCLAh-x7caEkg2jsbhNmg-3Q')).toBe('live');
  });

  it('falls back to foundation when nothing is configured', async () => {
    expect(await resolveProfile(db({}) as never, 'youtube', null)).toBe('foundation');
  });
});

describe('applyRecipeResult', () => {
  it('writes what the recipe produced', () => {
    const p = applyRecipeResult({}, { title: 'A hook', description: 'Body', hashtags: ['#ai'] });
    expect(p).toMatchObject({ title: 'A hook', description: 'Body', hashtags: ['#ai'], copy_source: 'recipe' });
  });

  it('NEVER overwrites a field a human has edited', () => {
    const p = applyRecipeResult(
      { title: 'Mine', copy_edited_fields: ['title'] },
      { title: 'The model wins', description: 'Body' },
    );
    expect(p.title).toBeUndefined();
    expect(p.description).toBe('Body');
  });
});

describe('renderChapters', () => {
  const ok = [
    { seconds: 0, label: 'Cold open' },
    { seconds: 33, label: 'Meet Jason Ward from C.H. Robinson' },
    { seconds: 78, label: 'AI use cases in logistics' },
  ];

  it('renders a valid list in the published format', () => {
    expect(renderChapters(ok)).toBe(
      'Timestamps:\n[0:00] Cold open\n[0:33] Meet Jason Ward from C.H. Robinson\n[1:18] AI use cases in logistics',
    );
  });

  it('uses H:MM:SS past an hour', () => {
    const out = renderChapters([...ok, { seconds: 3725, label: 'Closing' }]);
    expect(out).toContain('[1:02:05] Closing');
  });

  it('refuses a list that does not start at 0:00', () => {
    // YouTube draws no chapter bar at all, silently. An almost-valid list is
    // worse than none because nobody notices it did nothing.
    expect(renderChapters([{ seconds: 1, label: 'a' }, ...ok.slice(1)])).toBe('');
  });

  it('refuses fewer than three chapters', () => {
    expect(renderChapters(ok.slice(0, 2))).toBe('');
  });

  it('refuses a gap under ten seconds', () => {
    expect(renderChapters([ok[0], { seconds: 5, label: 'too soon' }, ok[2]])).toBe('');
  });

  it('sorts before judging, so an out-of-order list is still usable', () => {
    expect(renderChapters([ok[2], ok[0], ok[1]])).toContain('[0:00] Cold open');
  });

  it('is empty for nothing', () => {
    expect(renderChapters([])).toBe('');
    expect(renderChapters(null)).toBe('');
    expect(renderChapters(undefined)).toBe('');
  });
});
