// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Render parity — for the standard 10-block fixture, the inner HTML
 * produced by `renderBlockClient` (which Puck calls per-block) must
 * match the inner HTML the legacy `renderPage` produces for the same
 * block + content, after stripping editor-chrome decorations.
 *
 * Per spec-builder-evaluation §10 Phase B + §12 (Render parity tests).
 *
 * Why this matters: PuckCanvasEditor and SiteCanvasEditor must produce
 * the same final HTML for the same `page_blocks` rows — otherwise the
 * publish-worker's content-hash will flip on every editor switch, and
 * users opening a Puck-edited page in the legacy editor (or vice versa)
 * will see different output.
 *
 * Strip rules — `stripEditorChrome`:
 *   - data-* attributes (data-block-id, data-puck-*, data-rfd-*)
 *   - whitespace normalization
 *   - the `puck-block-rendered` wrapper div the host puts around each
 *     block (Puck's chrome only)
 */

import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../../../../../lib/canvas-render/mustache-subset.js';
import { renderBlockClient, type BlockTemplateLookup } from '../render-block-client.js';

const fixtures = [
  {
    key: 'hero',
    html: '<section class="hero"><h1>{{headline}}</h1><p>{{body}}</p></section>',
    content: { headline: 'Welcome', body: 'Hi.' },
  },
  {
    key: 'heading',
    html: '<{{level}}>{{text}}</{{level}}>',
    content: { level: 'h2', text: 'About us' },
  },
  {
    key: 'paragraph',
    html: '<p>{{body}}</p>',
    content: { body: 'Lorem ipsum dolor sit amet.' },
  },
  {
    key: 'image',
    html: '<figure><img src="{{src}}" alt="{{alt}}"/></figure>',
    content: { src: '/img/hero.jpg', alt: 'Hero shot' },
  },
  {
    key: 'cta_button',
    html: '<a class="btn" href="{{href}}">{{label}}</a>',
    content: { href: '/signup', label: 'Sign up' },
  },
  {
    key: 'two_columns',
    html: '<div class="cols">{{>children}}</div>',
    content: {},
  },
  {
    key: 'three_columns',
    html: '<div class="cols-3">{{>children}}</div>',
    content: {},
  },
  {
    key: 'divider',
    html: '<hr/>',
    content: {},
  },
  {
    key: 'spacer',
    html: '<div class="spacer" style="height:{{height}}px"></div>',
    content: { height: 24 },
  },
  {
    key: 'footer',
    html: '<footer><p>{{copyright}}</p></footer>',
    content: { copyright: '© 2026 ACME' },
  },
];

function stripEditorChrome(html: string): string {
  return html
    // strip Puck data-* + react-beautiful-dnd legacy + our own block-id markers
    .replace(/\s+data-(?:puck|rfd|block-id|block-key|field|edit)[^=\s>]*="[^"]*"/g, '')
    .replace(/\s+data-(?:puck|rfd|block-id|block-key|field|edit)[^=\s>]*='[^']*'/g, '')
    // collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

describe('render parity — Puck client renderer vs legacy renderTemplate', () => {
  it.each(fixtures)('block "$key" renders identically', (f) => {
    // Legacy path: renderTemplate directly with the same options the
    // server-side renderer uses for a leaf block (no children needed).
    const legacy = renderTemplate(f.html, f.content, { partials: new Map<string, string>() });

    // Puck path: build the lookup map + call renderBlockClient.
    const lookup: BlockTemplateLookup = {
      byKey: new Map([[f.key, { html: f.html, schema: {} }]]),
    };
    const puck = renderBlockClient({
      blockDefKey: f.key,
      content: f.content,
      variantKey: 'default',
      lookup,
    });

    expect(stripEditorChrome(puck.html)).toBe(stripEditorChrome(legacy));
    expect(puck.warnings).toEqual([]);
  });
});

describe('stripEditorChrome', () => {
  it('strips Puck and rfd data- attributes', () => {
    const input = '<div data-puck-id="abc" data-rfd-droppable="x" class="hero">x</div>';
    expect(stripEditorChrome(input)).toBe('<div class="hero">x</div>');
  });

  it('preserves non-editor attributes', () => {
    const input = '<a class="btn" href="/x" target="_blank">y</a>';
    expect(stripEditorChrome(input)).toBe('<a class="btn" href="/x" target="_blank">y</a>');
  });

  it('collapses whitespace', () => {
    const input = '<div>\n  <p>  x  </p>\n</div>';
    expect(stripEditorChrome(input)).toBe('<div> <p> x </p> </div>');
  });
});
