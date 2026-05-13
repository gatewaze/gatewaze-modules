import { describe, expect, it, vi } from 'vitest';
import {
  walkPageVariants,
  parseFieldPath,
  setAtPath,
  scoreVariantEligibility,
} from '../walk-page-variants.js';

const baseVariant = {
  id: 'v1',
  priority: 100,
  updated_at: '2026-05-01T00:00:00Z',
} as const;

describe('parseFieldPath', () => {
  it('parses a top-level key', () => {
    expect(parseFieldPath('heroTitle')).toEqual([{ kind: 'key', value: 'heroTitle' }]);
  });
  it('parses nested keys', () => {
    expect(parseFieldPath('hero.title')).toEqual([
      { kind: 'key', value: 'hero' },
      { kind: 'key', value: 'title' },
    ]);
  });
  it('parses array indices', () => {
    expect(parseFieldPath('contentBlocks[2]')).toEqual([
      { kind: 'key', value: 'contentBlocks' },
      { kind: 'index', value: 2 },
    ]);
  });
  it('parses mixed nesting + indices', () => {
    expect(parseFieldPath('contentBlocks[2].title')).toEqual([
      { kind: 'key', value: 'contentBlocks' },
      { kind: 'index', value: 2 },
      { kind: 'key', value: 'title' },
    ]);
  });
  it('rejects empty path', () => {
    expect(parseFieldPath('')).toBeNull();
  });
  it('rejects malformed brackets', () => {
    expect(parseFieldPath('contentBlocks[abc]')).toBeNull();
    expect(parseFieldPath('contentBlocks[')).toBeNull();
  });
  it('rejects double dots / trailing dot', () => {
    expect(parseFieldPath('hero..title')).toBeNull();
    expect(parseFieldPath('hero.')).toBeNull();
  });
});

describe('setAtPath', () => {
  it('sets a top-level key', () => {
    const target = { a: 1, b: 2 };
    const r = setAtPath(target, 'a', 99);
    expect(r.ok).toBe(true);
    expect(target.a).toBe(99);
  });
  it('sets a nested key', () => {
    const target = { hero: { title: 'old', sub: 'unchanged' } };
    setAtPath(target, 'hero.title', 'new');
    expect(target.hero.title).toBe('new');
    expect(target.hero.sub).toBe('unchanged');
  });
  it('sets an array index', () => {
    const target = { items: ['a', 'b', 'c'] };
    setAtPath(target, 'items[1]', 'B');
    expect(target.items).toEqual(['a', 'B', 'c']);
  });
  it('replaces a whole array', () => {
    const target = { items: ['a', 'b'] };
    setAtPath(target, 'items', ['x', 'y', 'z']);
    expect(target.items).toEqual(['x', 'y', 'z']);
  });
  it('rejects index into a non-array', () => {
    const target = { a: { b: 'string' } };
    const r = setAtPath(target, 'a[0]', 'X');
    expect(r.ok).toBe(false);
  });
  it('rejects out-of-range write that would create a hole', () => {
    const target = { items: ['a'] };
    const r = setAtPath(target, 'items[5]', 'X');
    expect(r.ok).toBe(false);
  });
  it('rejects missing intermediate segment', () => {
    const target: Record<string, unknown> = {};
    const r = setAtPath(target, 'a.b.c', 1);
    expect(r.ok).toBe(false);
  });
});

describe('scoreVariantEligibility', () => {
  it('returns 0 for an empty match_context (matches always)', () => {
    expect(scoreVariantEligibility({}, { persona: 'developer' })).toBe(0);
  });
  it('returns the number of axes when all match', () => {
    expect(
      scoreVariantEligibility(
        { persona: 'enterprise', 'utm.campaign': 'mcp' },
        { persona: 'enterprise', 'utm.campaign': 'mcp', 'geo.country': 'GB' },
      ),
    ).toBe(2);
  });
  it('returns null when any axis is missing in the request', () => {
    expect(
      scoreVariantEligibility(
        { persona: 'enterprise', 'utm.campaign': 'mcp' },
        { persona: 'enterprise' },
      ),
    ).toBeNull();
  });
  it('returns null when any axis value mismatches', () => {
    expect(
      scoreVariantEligibility({ persona: 'enterprise' }, { persona: 'developer' }),
    ).toBeNull();
  });
  it('handles multi-value (OR) match context', () => {
    expect(
      scoreVariantEligibility(
        { persona: ['enterprise', 'developer'] },
        { persona: 'developer' },
      ),
    ).toBe(1);
    expect(
      scoreVariantEligibility(
        { persona: ['enterprise', 'developer'] },
        { persona: 'researcher' },
      ),
    ).toBeNull();
  });
  it('accepts boolean axis values stored as strings', () => {
    expect(
      scoreVariantEligibility(
        { 'viewer.authenticated': true },
        { 'viewer.authenticated': 'true' },
      ),
    ).toBe(1);
  });
});

describe('walkPageVariants', () => {
  it('returns defaults unchanged when no variants supplied', () => {
    const result = walkPageVariants({
      defaultContent: { heroTitle: 'Default' },
      variants: [],
      context: {},
    });
    expect(result.content).toEqual({ heroTitle: 'Default' });
    expect(result.overlayed).toBe(0);
  });

  it('overlays a field when one variant matches', () => {
    const result = walkPageVariants({
      defaultContent: { heroTitle: 'Default' },
      variants: [
        {
          ...baseVariant,
          field_path: 'heroTitle',
          match_context: { persona: 'enterprise' },
          value: 'Enterprise-grade headline',
        },
      ],
      context: { persona: 'enterprise' },
    });
    expect(result.content.heroTitle).toBe('Enterprise-grade headline');
    expect(result.applied.heroTitle).toBe('v1');
    expect(result.overlayed).toBe(1);
  });

  it('falls through to default when no variant matches', () => {
    const result = walkPageVariants({
      defaultContent: { heroTitle: 'Default' },
      variants: [
        {
          ...baseVariant,
          field_path: 'heroTitle',
          match_context: { persona: 'enterprise' },
          value: 'Enterprise',
        },
      ],
      context: { persona: 'developer' },
    });
    expect(result.content.heroTitle).toBe('Default');
    expect(result.applied.heroTitle).toBeNull();
  });

  it('picks the most-specific variant on tie', () => {
    const result = walkPageVariants({
      defaultContent: { heroTitle: 'Default' },
      variants: [
        {
          id: 'v-broad',
          priority: 100,
          updated_at: '2026-05-01T00:00:00Z',
          field_path: 'heroTitle',
          match_context: { persona: 'enterprise' },
          value: 'BROAD',
        },
        {
          id: 'v-specific',
          priority: 100,
          updated_at: '2026-05-01T00:00:00Z',
          field_path: 'heroTitle',
          match_context: { persona: 'enterprise', 'utm.campaign': 'mcp' },
          value: 'SPECIFIC',
        },
      ],
      context: { persona: 'enterprise', 'utm.campaign': 'mcp' },
    });
    expect(result.content.heroTitle).toBe('SPECIFIC');
  });

  it('uses priority as tiebreaker when specificity ties', () => {
    const result = walkPageVariants({
      defaultContent: { heroTitle: 'Default' },
      variants: [
        {
          id: 'v-low-priority',
          priority: 200,
          updated_at: '2026-05-01T00:00:00Z',
          field_path: 'heroTitle',
          match_context: { persona: 'enterprise' },
          value: 'Low priority',
        },
        {
          id: 'v-high-priority',
          priority: 50,
          updated_at: '2026-05-01T00:00:00Z',
          field_path: 'heroTitle',
          match_context: { persona: 'enterprise' },
          value: 'High priority',
        },
      ],
      context: { persona: 'enterprise' },
    });
    expect(result.content.heroTitle).toBe('High priority');
  });

  it('replaces a whole array (block reordering pattern)', () => {
    const result = walkPageVariants({
      defaultContent: {
        contentBlocks: [
          { id: 'a', kind: 'hero' },
          { id: 'b', kind: 'events' },
          { id: 'c', kind: 'cards' },
        ],
      },
      variants: [
        {
          ...baseVariant,
          field_path: 'contentBlocks',
          match_context: { persona: 'enterprise' },
          value: [
            { id: 'c', kind: 'cards' },
            { id: 'b', kind: 'events' },
          ],
        },
      ],
      context: { persona: 'enterprise' },
    });
    expect(result.content.contentBlocks).toEqual([
      { id: 'c', kind: 'cards' },
      { id: 'b', kind: 'events' },
    ]);
  });

  it('warns and skips when field_path is unresolvable', () => {
    const onWarning = vi.fn();
    const result = walkPageVariants({
      defaultContent: { heroTitle: 'Default' },
      variants: [
        {
          ...baseVariant,
          field_path: 'nonexistent.deep.path',
          match_context: {},
          value: 'X',
        },
      ],
      context: {},
      onWarning,
    });
    expect(result.content).toEqual({ heroTitle: 'Default' });
    expect(onWarning).toHaveBeenCalledOnce();
  });

  it('does not mutate the input defaultContent', () => {
    const defaults = { heroTitle: 'Default' };
    walkPageVariants({
      defaultContent: defaults,
      variants: [
        {
          ...baseVariant,
          field_path: 'heroTitle',
          match_context: {},
          value: 'Overlay',
        },
      ],
      context: {},
    });
    expect(defaults.heroTitle).toBe('Default');
  });

  it('handles multiple field paths in one pass', () => {
    const result = walkPageVariants({
      defaultContent: { heroTitle: 'Default', heroSub: 'Sub' },
      variants: [
        {
          ...baseVariant,
          id: 'v-title',
          field_path: 'heroTitle',
          match_context: { persona: 'enterprise' },
          value: 'Enterprise title',
        },
        {
          ...baseVariant,
          id: 'v-sub',
          field_path: 'heroSub',
          match_context: { persona: 'enterprise' },
          value: 'Enterprise sub',
        },
      ],
      context: { persona: 'enterprise' },
    });
    expect(result.content).toEqual({
      heroTitle: 'Enterprise title',
      heroSub: 'Enterprise sub',
    });
    expect(result.overlayed).toBe(2);
  });
});
