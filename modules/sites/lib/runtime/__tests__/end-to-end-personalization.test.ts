/**
 * End-to-end smoke test: persona resolution → variant walk.
 *
 * Wires the pure pieces of the personalization pipeline together to
 * prove that:
 *   1. A request context resolves to the correct persona (default
 *      fallback + explicit-condition match + self-select)
 *   2. Variants for that persona override the page's default content
 *      when applied via walkPageVariants
 *   3. Multi-axis match_context narrows correctly (a persona +
 *      utm.campaign match wins over persona-only)
 *
 * No DB. The test feeds in-memory fixtures shaped like the rows the
 * runtime endpoint loads.
 */

import { describe, expect, it } from 'vitest';
import { resolvePersonaFromContext, type StoredPersona } from '../../../api/personas-routes.js';
import { walkPageVariants, type PageVariantInput } from '../walk-page-variants.js';

const PERSONAS: StoredPersona[] = [
  {
    id: 'p1',
    site_id: 's1',
    name: 'general',
    label: 'General',
    description: null,
    is_default: true,
    priority: 100,
    conditions: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'p2',
    site_id: 's1',
    name: 'developer',
    label: 'Developer',
    description: null,
    is_default: false,
    priority: 50,
    conditions: [
      { axis: 'utm.source', operator: 'eq', value: 'dev-hub', persist: false },
    ],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'p3',
    site_id: 's1',
    name: 'enterprise',
    label: 'Enterprise',
    description: null,
    is_default: false,
    priority: 10,
    conditions: [
      { axis: 'utm.campaign', operator: 'in', value: ['enterprise-2026', 'q1-enterprise'], persist: false },
    ],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const DEFAULT_CONTENT = {
  heroTitle: 'Welcome',
  cta: 'Sign up',
  pricing: [
    { name: 'Free', price: 0 },
    { name: 'Pro', price: 99 },
  ],
};

const VARIANTS: PageVariantInput[] = [
  {
    id: 'v-dev',
    field_path: 'heroTitle',
    match_context: { persona: 'developer' },
    value: 'Build with our API',
    priority: 100,
    updated_at: '2026-01-02T00:00:00Z',
  },
  {
    id: 'v-ent',
    field_path: 'heroTitle',
    match_context: { persona: 'enterprise' },
    value: 'Enterprise-grade reliability',
    priority: 100,
    updated_at: '2026-01-02T00:00:00Z',
  },
  {
    id: 'v-ent-campaign',
    field_path: 'cta',
    match_context: { persona: 'enterprise', 'utm.campaign': 'enterprise-2026' },
    value: 'Book a demo',
    priority: 100,
    updated_at: '2026-01-02T00:00:00Z',
  },
  {
    id: 'v-ent-pricing',
    field_path: 'pricing',
    match_context: { persona: 'enterprise' },
    value: [{ name: 'Enterprise', price: 'Contact us' }],
    priority: 100,
    updated_at: '2026-01-02T00:00:00Z',
  },
];

describe('end-to-end personalization', () => {
  it('falls back to default persona when nothing matches', () => {
    const resolved = resolvePersonaFromContext(PERSONAS, { locale: 'en' });
    expect(resolved?.persona.name).toBe('general');
    expect(resolved?.matched_condition).toBeNull();
  });

  it('matches developer on utm.source', () => {
    const resolved = resolvePersonaFromContext(PERSONAS, { 'utm.source': 'dev-hub' });
    expect(resolved?.persona.name).toBe('developer');
    expect(resolved?.matched_condition?.axis).toBe('utm.source');
  });

  it('developer context replaces heroTitle but leaves cta + pricing intact', () => {
    const context = { persona: 'developer', 'utm.source': 'dev-hub' };
    const result = walkPageVariants({
      defaultContent: DEFAULT_CONTENT,
      variants: VARIANTS,
      context,
    });
    expect(result.content.heroTitle).toBe('Build with our API');
    expect(result.content.cta).toBe('Sign up');
    expect(result.content.pricing).toEqual(DEFAULT_CONTENT.pricing);
    expect(result.applied['heroTitle']).toBe('v-dev');
  });

  it('multi-axis variant beats persona-only when both match', () => {
    // Enterprise persona + utm.campaign — both heroTitle (persona-only)
    // and cta (persona + campaign) apply. heroTitle has only one matching
    // variant; cta picks the campaign-aware variant.
    const context = { persona: 'enterprise', 'utm.campaign': 'enterprise-2026' };
    const result = walkPageVariants({
      defaultContent: DEFAULT_CONTENT,
      variants: VARIANTS,
      context,
    });
    expect(result.content.heroTitle).toBe('Enterprise-grade reliability');
    expect(result.content.cta).toBe('Book a demo');
    expect(result.applied['cta']).toBe('v-ent-campaign');
  });

  it('array-replace variant rewrites the whole array', () => {
    const context = { persona: 'enterprise' };
    const result = walkPageVariants({
      defaultContent: DEFAULT_CONTENT,
      variants: VARIANTS,
      context,
    });
    expect(result.content.pricing).toEqual([{ name: 'Enterprise', price: 'Contact us' }]);
  });

  it('self-select persona cookie short-circuits resolution', () => {
    // Context already carries persona=developer (cookie path). Even with
    // no other matching axes, the persona is honoured.
    const resolved = resolvePersonaFromContext(PERSONAS, { persona: 'developer' });
    expect(resolved?.persona.name).toBe('developer');
  });

  it('persona claim for a deleted persona falls through to default', () => {
    const resolved = resolvePersonaFromContext(PERSONAS, { persona: 'phantom' });
    expect(resolved?.persona.name).toBe('general');
  });

  it('priority wins ties — enterprise (priority 10) beats developer (priority 50)', () => {
    // Both conditions match. enterprise has lower priority value (higher rank).
    const resolved = resolvePersonaFromContext(PERSONAS, {
      'utm.source': 'dev-hub',
      'utm.campaign': 'enterprise-2026',
    });
    expect(resolved?.persona.name).toBe('enterprise');
  });

  it('default content is never mutated', () => {
    const before = JSON.stringify(DEFAULT_CONTENT);
    walkPageVariants({
      defaultContent: DEFAULT_CONTENT,
      variants: VARIANTS,
      context: { persona: 'enterprise' },
    });
    expect(JSON.stringify(DEFAULT_CONTENT)).toBe(before);
  });
});
