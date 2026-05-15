// @ts-nocheck — vitest types resolved at workspace install time
/**
 * email-blocks registry — shape + lookup + collision tests. Per
 * spec-builder-evaluation §3.6 (extended).
 */
import { describe, expect, it } from 'vitest';
import { emailBlockRegistry, getEmailBlock } from '../index.js';
import { mergeRegistryIntoConfig } from '../merge-into-config.js';

describe('emailBlockRegistry', () => {
  it('registers the v1 trio (heading, text, button)', () => {
    expect(emailBlockRegistry.has('heading')).toBe(true);
    expect(emailBlockRegistry.has('text')).toBe(true);
    expect(emailBlockRegistry.has('button')).toBe(true);
  });

  it('exposes componentId-keyed lookup', () => {
    const heading = getEmailBlock('heading');
    expect(heading).toBeDefined();
    expect(heading?.componentId).toBe('heading');
    expect(heading?.label).toBe('Heading');
  });

  it('returns undefined for unknown component_ids', () => {
    expect(getEmailBlock('nonexistent_block')).toBeUndefined();
  });

  it('every entry has a Component (function/class)', () => {
    for (const entry of emailBlockRegistry.values()) {
      expect(typeof entry.Component).toBe('function');
    }
  });

  it('every entry declares fields and defaultProps', () => {
    for (const entry of emailBlockRegistry.values()) {
      expect(entry.fields).toBeDefined();
      expect(entry.defaultProps).toBeDefined();
      expect(typeof entry.fields).toBe('object');
      expect(typeof entry.defaultProps).toBe('object');
    }
  });

  it('button + heading + text expose substack and beehiiv format components', () => {
    for (const id of ['heading', 'text', 'button']) {
      const entry = getEmailBlock(id);
      expect(entry?.formats?.substack).toBeDefined();
      expect(entry?.formats?.beehiiv).toBeDefined();
      expect(typeof entry?.formats?.substack).toBe('function');
      expect(typeof entry?.formats?.beehiiv).toBe('function');
    }
  });

  it('every entry validates default props against its declared fields', () => {
    // Sanity: fields' keys should be a subset of defaultProps' keys.
    for (const entry of emailBlockRegistry.values()) {
      for (const fieldKey of Object.keys(entry.fields)) {
        expect(entry.defaultProps).toHaveProperty(fieldKey);
      }
    }
  });
});

describe('mergeRegistryIntoConfig — universal spacing fields', () => {
  // Regression guard for the "padding/margin on all blocks" feature.
  // The merge step auto-injects _spacing_padding + _spacing_margin into
  // every block's fields + defaultProps. If someone removes the
  // injection (e.g. while refactoring puckEntryFromRegistry) this test
  // catches it. The render-time wrapper behaviour (no <div> when both
  // are '0px') is exercised in export-edition-html.test.ts.
  const merged = mergeRegistryIntoConfig({
    base: { components: {} } as any,
    registry: emailBlockRegistry,
  });

  it('every merged component declares _spacing_padding + _spacing_margin fields', () => {
    for (const [key, comp] of Object.entries(merged.config.components)) {
      expect(comp.fields, `${key} fields`).toHaveProperty('_spacing_padding');
      expect(comp.fields, `${key} fields`).toHaveProperty('_spacing_margin');
    }
  });

  it('every merged component defaults the new spacing props to "0px"', () => {
    for (const [key, comp] of Object.entries(merged.config.components)) {
      expect((comp.defaultProps as any)._spacing_padding, `${key} default padding`).toBe('0px');
      expect((comp.defaultProps as any)._spacing_margin, `${key} default margin`).toBe('0px');
    }
  });

  it('every text / textarea field has contentEditable defined (defaults to true unless block opts out)', () => {
    // Inline editing is opt-out, not opt-in. The merge layer defaults
    // `contentEditable: true` on every text/textarea field; blocks can
    // explicitly set `contentEditable: false` to opt out (e.g., Markdown
    // blocks where contentEditable wraps the prop value in a structured
    // node that breaks marked()). Either way, the field must NOT be
    // missing the property — that's the regression we're guarding.
    const optOuts = new Set<string>();
    for (const [key, comp] of Object.entries(merged.config.components)) {
      const fields = (comp.fields ?? {}) as Record<string, { type?: string; contentEditable?: boolean }>;
      for (const [fname, field] of Object.entries(fields)) {
        if (field.type === 'text' || field.type === 'textarea') {
          expect(field.contentEditable, `${key}.${fname} contentEditable defined`).toBeDefined();
          if (field.contentEditable === false) optOuts.add(`${key}.${fname}`);
        }
      }
    }
    // Sanity check: opt-outs are intentional and rare. If this fires
    // because a block author accidentally set contentEditable: false,
    // the failure surface gives them the field name to investigate.
    expect(optOuts.size).toBeLessThan(10);
  });
});
