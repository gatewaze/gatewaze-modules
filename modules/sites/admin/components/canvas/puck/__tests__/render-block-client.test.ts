// @ts-nocheck — vitest types resolved at workspace install time
import { describe, expect, it } from 'vitest';
import { renderBlockClient, type BlockTemplateLookup } from '../render-block-client.js';

const lookup: BlockTemplateLookup = {
  byKey: new Map([
    ['hero', { html: '<section class="hero"><h1>{{headline}}</h1><p>{{body}}</p></section>', schema: {} }],
    ['heading', { html: '<{{level}}>{{text}}</{{level}}>', schema: {} }],
    ['raw_block', { html: '{{{trusted_html}}}', schema: {} }],
  ]),
};

describe('renderBlockClient', () => {
  it('renders a known block with HTML-escaped substitution', () => {
    const r = renderBlockClient({
      blockDefKey: 'hero',
      content: { headline: 'Welcome <user>', body: 'Hi.' },
      variantKey: 'default',
      lookup,
    });
    expect(r.html).toBe('<section class="hero"><h1>Welcome &lt;user&gt;</h1><p>Hi.</p></section>');
    expect(r.warnings).toEqual([]);
  });

  it('passes through {{{raw}}} for trusted-html fields', () => {
    const r = renderBlockClient({
      blockDefKey: 'raw_block',
      content: { trusted_html: '<em>bold</em>' },
      variantKey: 'default',
      lookup,
    });
    expect(r.html).toBe('<em>bold</em>');
  });

  it('fills missing fields with empty string', () => {
    const r = renderBlockClient({
      blockDefKey: 'hero',
      content: { headline: 'Hi' }, // no body
      variantKey: 'default',
      lookup,
    });
    expect(r.html).toBe('<section class="hero"><h1>Hi</h1><p></p></section>');
  });

  it('emits a missing-template warning for unknown block keys', () => {
    const r = renderBlockClient({
      blockDefKey: 'unknown',
      content: {},
      variantKey: 'default',
      lookup,
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.html).toContain('Missing block_def template');
    expect(r.html).toContain('unknown');
  });

  it('coerces non-string field values', () => {
    const r = renderBlockClient({
      blockDefKey: 'heading',
      content: { level: 'h2', text: 42 },
      variantKey: 'default',
      lookup,
    });
    expect(r.html).toBe('<h2>42</h2>');
  });
});
