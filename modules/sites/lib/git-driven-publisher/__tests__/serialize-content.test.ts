import { describe, expect, it } from 'vitest';
import { serializeContent, substitutePathTemplate } from '../serialize-content.js';

// ---------------------------------------------------------------------------
// substitutePathTemplate (§6.3.5 path-template substitution algorithm)
// ---------------------------------------------------------------------------

describe('substitutePathTemplate()', () => {
  const t = 'content/pages/{route}.mdx';

  it('substitutes /', () => {
    expect(substitutePathTemplate(t, '/')).toBe('content/pages/index.mdx');
  });

  it('substitutes /about', () => {
    expect(substitutePathTemplate(t, '/about')).toBe('content/pages/about.mdx');
  });

  it('substitutes /for/developer', () => {
    expect(substitutePathTemplate(t, '/for/developer')).toBe('content/pages/for/developer.mdx');
  });

  it('substitutes /blog/ (trailing-slash)', () => {
    expect(substitutePathTemplate(t, '/blog/')).toBe('content/pages/blog/index.mdx');
  });

  it('substitutes {slug}', () => {
    expect(substitutePathTemplate('content/{slug}.mdx', '/for/enterprise')).toBe(
      'content/enterprise.mdx',
    );
  });

  it('substitutes both {route} and {slug}', () => {
    expect(
      substitutePathTemplate('content/{route}-{slug}.mdx', '/for/developer'),
    ).toBe('content/for/developer-developer.mdx');
  });
});

// ---------------------------------------------------------------------------
// serializeContent — JSON
// ---------------------------------------------------------------------------

describe('serializeContent({ format: "json" })', () => {
  it('emits pretty-printed JSON with sorted keys (deterministic)', () => {
    const a = serializeContent({ content: { z: 1, a: 2 }, format: 'json' });
    const b = serializeContent({ content: { a: 2, z: 1 }, format: 'json' });
    expect(a.text).toBe(b.text);
    expect(a.text).toBe('{\n  "a": 2,\n  "z": 1\n}\n');
  });

  it('handles nested objects and arrays', () => {
    const result = serializeContent({
      content: {
        hero: { title: 'Hello', cta: { label: 'Go', href: '/go' } },
        list: [1, 2, 3],
      },
      format: 'json',
    });
    expect(result.text).toContain('"hero"');
    expect(result.text).toContain('"label": "Go"');
  });
});

// ---------------------------------------------------------------------------
// serializeContent — YAML
// ---------------------------------------------------------------------------

describe('serializeContent({ format: "yaml" })', () => {
  it('emits YAML with sorted keys', () => {
    const a = serializeContent({ content: { z: 1, a: 2 }, format: 'yaml' });
    const b = serializeContent({ content: { a: 2, z: 1 }, format: 'yaml' });
    expect(a.text).toBe(b.text);
  });

  it('quotes strings that look like reserved scalars', () => {
    const result = serializeContent({
      content: { value: 'true' },
      format: 'yaml',
    });
    // 'true' as a string must be quoted to avoid being parsed as boolean
    expect(result.text).toContain("'true'");
  });

  it('emits bare strings for safe identifiers', () => {
    const result = serializeContent({ content: { title: 'hello-world' }, format: 'yaml' });
    expect(result.text).toMatch(/title:\s*hello-world/);
  });

  it('handles nested objects', () => {
    const result = serializeContent({
      content: { hero: { title: 'Hi', subtitle: 'There' } },
      format: 'yaml',
    });
    expect(result.text).toContain('hero:');
    expect(result.text).toContain('subtitle:');
  });
});

// ---------------------------------------------------------------------------
// serializeContent — MDX
// ---------------------------------------------------------------------------

describe('serializeContent({ format: "mdx" })', () => {
  it('emits YAML frontmatter delimited by ---', () => {
    const result = serializeContent({
      content: { title: 'Hello', __body__: '# This is the body' },
      format: 'mdx',
    });
    const lines = result.text.split('\n');
    expect(lines[0]).toBe('---');
    expect(result.text).toContain('---\n\n# This is the body');
  });

  it('handles missing __body__ gracefully', () => {
    const result = serializeContent({ content: { title: 'Hi' }, format: 'mdx' });
    expect(result.text).toMatch(/^---\n[\s\S]*---\n\n\n$/);
  });

  it('produces byte-identical output for identical inputs (idempotency)', () => {
    const c = { z: 'z', a: 'a', __body__: 'body' };
    const a = serializeContent({ content: c, format: 'mdx' });
    const b = serializeContent({ content: c, format: 'mdx' });
    expect(a.text).toBe(b.text);
  });

  it('emits TOML frontmatter when frontmatterFormat=toml', () => {
    const result = serializeContent({
      content: { title: 'Hi', __body__: 'body' },
      format: 'mdx',
      frontmatterFormat: 'toml',
    });
    expect(result.text).toContain('title = "Hi"');
  });
});
