// @ts-nocheck — vitest types resolved at workspace install time
/**
 * email-blocks registry — shape + lookup + collision tests. Per
 * spec-builder-evaluation §3.6 (extended).
 */
import { describe, expect, it } from 'vitest';
import { emailBlockRegistry, getEmailBlock } from '../index.js';

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
