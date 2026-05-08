// @ts-nocheck — vitest types resolved at workspace install time
/**
 * Export round-trip — the publish path's contract is "edition + per-block
 * render metadata in, email-safe HTML string out". Verifies that:
 *
 *   - react-email blocks render via @react-email/components (correct
 *     tags + email-safe inline styles)
 *   - Mustache fallback blocks render via renderTemplate inside the
 *     same `<EditionEmail>` JSX tree (mixed-mode)
 *   - the output document includes `<html>`, `<body>`, and the
 *     edition's preheader (when set)
 *   - format='substack' picks each block's substack Component variant
 */
import { describe, expect, it } from 'vitest';
import { exportEditionHtml } from '../export-edition-html.js';
import type { NewsletterEdition } from '../../../../utils/types.js';
import type { BlockRenderMeta } from '../EditionEmail.js';

const baseEdition: NewsletterEdition = {
  id: 'ed-rt-1',
  edition_date: '2026-05-08',
  subject: 'Welcome',
  preheader: 'Hi from the test suite.',
  blocks: [
    {
      id: 'b-heading',
      block_template: {
        id: 'tpl-heading',
        name: 'Heading',
        block_type: 'heading',
        content: { html_template: '' },
      },
      content: { text: 'Welcome', level: 'h1', align: 'center' },
      sort_order: 1000,
      bricks: [],
    },
    {
      id: 'b-text',
      block_template: {
        id: 'tpl-text',
        name: 'Text',
        block_type: 'text',
        content: { html_template: '' },
      },
      content: { body: 'Hello world.', align: 'left' },
      sort_order: 2000,
      bricks: [],
    },
    {
      id: 'b-mustache',
      block_template: {
        id: 'tpl-mustache',
        name: 'Legacy Quote',
        block_type: 'legacy_quote',
        content: { html_template: '<blockquote>{{quote}}</blockquote>' },
      },
      content: { quote: 'Be excellent.' },
      sort_order: 3000,
      bricks: [],
    },
  ],
};

const meta = new Map<string, BlockRenderMeta>([
  ['b-heading', { render_kind: 'react-email', component_id: 'heading' }],
  ['b-text', { render_kind: 'react-email', component_id: 'text' }],
  ['b-mustache', { render_kind: 'mustache', mustache_html: '<blockquote>{{quote}}</blockquote>' }],
]);

describe('exportEditionHtml — email format', () => {
  it('produces a complete HTML document', async () => {
    const html = await exportEditionHtml({ edition: baseEdition, format: 'email', blockMeta: meta });
    expect(html).toMatch(/<html\b/i);
    expect(html).toMatch(/<body\b/i);
    expect(html).toContain('Hi from the test suite.'); // preheader
  });

  it('includes the heading text from a react-email block', async () => {
    const html = await exportEditionHtml({ edition: baseEdition, format: 'email', blockMeta: meta });
    expect(html).toContain('Welcome');
    // react-email Heading emits the level tag (h1 in this case).
    expect(html).toMatch(/<h1\b/i);
  });

  it('includes the body text from a react-email block', async () => {
    const html = await exportEditionHtml({ edition: baseEdition, format: 'email', blockMeta: meta });
    expect(html).toContain('Hello world.');
  });

  it('renders Mustache fallback blocks via dangerouslySetInnerHTML', async () => {
    const html = await exportEditionHtml({ edition: baseEdition, format: 'email', blockMeta: meta });
    expect(html).toContain('<blockquote>');
    expect(html).toContain('Be excellent.');
  });

  it('blocks are emitted in sort_order', async () => {
    const html = await exportEditionHtml({ edition: baseEdition, format: 'email', blockMeta: meta });
    const heading = html.indexOf('Welcome');
    const text = html.indexOf('Hello world.');
    const quote = html.indexOf('Be excellent.');
    expect(heading).toBeGreaterThan(-1);
    expect(text).toBeGreaterThan(heading);
    expect(quote).toBeGreaterThan(text);
  });
});

describe('exportEditionHtml — substack format', () => {
  it('still produces a complete document', async () => {
    const html = await exportEditionHtml({ edition: baseEdition, format: 'substack', blockMeta: meta });
    expect(html).toMatch(/<h1\b/i);
    expect(html).toContain('Welcome');
    expect(html).toContain('Hello world.');
  });
});

describe('exportEditionHtml — fallback when meta missing', () => {
  it('falls back to mustache with the block_template html_template when meta is absent', async () => {
    const editionWithoutMeta: NewsletterEdition = {
      ...baseEdition,
      blocks: [
        {
          id: 'b-fallback',
          block_template: {
            id: 'tpl-fb',
            name: 'Fallback',
            block_type: 'fallback',
            content: { html_template: '<p>{{body}}</p>' },
          },
          content: { body: 'Default render path' },
          sort_order: 1000,
          bricks: [],
        },
      ],
    };
    const html = await exportEditionHtml({
      edition: editionWithoutMeta,
      format: 'email',
      blockMeta: new Map(),
    });
    expect(html).toContain('Default render path');
  });

  it('shows a fallback marker when component_id is unknown', async () => {
    const editionWithBadMeta: NewsletterEdition = {
      ...baseEdition,
      blocks: [
        {
          id: 'b-bad',
          block_template: {
            id: 'tpl-bad',
            name: 'Bad',
            block_type: 'unknown',
            content: { html_template: '' },
          },
          content: {},
          sort_order: 1000,
          bricks: [],
        },
      ],
    };
    const badMeta = new Map<string, BlockRenderMeta>([
      ['b-bad', { render_kind: 'react-email', component_id: 'mystery_block' }],
    ]);
    const html = await exportEditionHtml({
      edition: editionWithBadMeta,
      format: 'email',
      blockMeta: badMeta,
    });
    expect(html).toContain('mystery_block');
  });
});
