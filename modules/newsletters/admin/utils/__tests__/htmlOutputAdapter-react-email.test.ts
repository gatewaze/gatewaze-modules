// @ts-nocheck — vitest types resolved at workspace install time
/**
 * HtmlOutputAdapter — react-email dispatch path. Per
 * spec-builder-evaluation §3.6 (extended).
 *
 * Verifies that:
 *   - Pure-Mustache contexts route through the legacy renderTemplate +
 *     boilerplate-concat path (bit-for-bit identical for existing libs).
 *   - Mixed contexts (any block with render_kind='react-email') route
 *     through `renderViaEditionEmail` → `await render(<EditionEmail/>)`,
 *     producing one HTML document with proper `<html><body>` shell and
 *     react-email's table/MSO output for the registry blocks.
 *   - Mustache blocks inside a mixed context still render correctly
 *     (via dangerouslySetInnerHTML inside the EditionEmail tree).
 */
import { describe, expect, it } from 'vitest';
import { HtmlOutputAdapter } from '../htmlOutputAdapter.js';
import type { OutputRenderContext } from '../../../types/output-adapter.js';

const baseContext: OutputRenderContext = {
  edition: {
    id: 'ed-test-1',
    edition_date: '2026-05-08',
    subject: 'Welcome',
    preheader: 'Hi from the test suite.',
  },
  blocks: [],
  links: new Map(),
  metadata: {},
};

describe('HtmlOutputAdapter — pure Mustache context', () => {
  it('uses the legacy boilerplate path (no `<html lang="en">` from EditionEmail)', async () => {
    const ctx: OutputRenderContext = {
      ...baseContext,
      blocks: [
        {
          id: 'b1',
          block_type: 'mustache_only',
          template: '<p>Hello {{name}}</p>',
          content: { name: 'World' },
          sort_order: 1000,
          has_bricks: false,
          bricks: [],
        },
      ],
    };
    const html = await HtmlOutputAdapter.render(ctx);
    expect(html).toContain('Hello World');
    // Legacy path uses the urn:schemas-microsoft-com xmlns shell.
    expect(html).toContain('xmlns:v="urn:schemas-microsoft-com:vml"');
  });
});

describe('HtmlOutputAdapter — react-email dispatch', () => {
  it('routes through EditionEmail when any block has render_kind=react-email', async () => {
    const ctx: OutputRenderContext = {
      ...baseContext,
      blocks: [
        {
          id: 'b-heading',
          block_type: 'heading',
          template: '',
          content: { text: 'Welcome', level: 'h1', align: 'center' },
          sort_order: 1000,
          has_bricks: false,
          bricks: [],
          render_kind: 'react-email',
          component_id: 'heading',
        },
        {
          id: 'b-text',
          block_type: 'text',
          template: '',
          content: { body: 'Hello world.', align: 'left' },
          sort_order: 2000,
          has_bricks: false,
          bricks: [],
          render_kind: 'react-email',
          component_id: 'text',
        },
      ],
    };
    const html = await HtmlOutputAdapter.render(ctx);
    expect(html).toContain('Welcome');
    expect(html).toContain('Hello world.');
    expect(html).toMatch(/<h1\b/i);
    // EditionEmail emits <Preview>; the legacy boilerplate would not.
    expect(html).toContain('Hi from the test suite.');
  });

  it('mixed contexts: react-email blocks render via JSX, Mustache blocks via dangerouslySetInnerHTML', async () => {
    const ctx: OutputRenderContext = {
      ...baseContext,
      blocks: [
        {
          id: 'b-heading',
          block_type: 'heading',
          template: '',
          content: { text: 'Welcome', level: 'h1', align: 'center' },
          sort_order: 1000,
          has_bricks: false,
          bricks: [],
          render_kind: 'react-email',
          component_id: 'heading',
        },
        {
          id: 'b-legacy',
          block_type: 'legacy_quote',
          template: '<blockquote>{{quote}}</blockquote>',
          content: { quote: 'Be excellent.' },
          sort_order: 2000,
          has_bricks: false,
          bricks: [],
          // No render_kind set → defaults to mustache
        },
      ],
    };
    const html = await HtmlOutputAdapter.render(ctx);
    expect(html).toContain('Welcome');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('Be excellent.');
  });

  it('preserves block sort_order across the dispatch boundary', async () => {
    const ctx: OutputRenderContext = {
      ...baseContext,
      blocks: [
        {
          id: 'b-1',
          block_type: 'heading',
          template: '',
          content: { text: 'First', level: 'h2', align: 'left' },
          sort_order: 2000,
          has_bricks: false,
          bricks: [],
          render_kind: 'react-email',
          component_id: 'heading',
        },
        {
          id: 'b-2',
          block_type: 'heading',
          template: '',
          content: { text: 'Second', level: 'h2', align: 'left' },
          sort_order: 1000,
          has_bricks: false,
          bricks: [],
          render_kind: 'react-email',
          component_id: 'heading',
        },
      ],
    };
    const html = await HtmlOutputAdapter.render(ctx);
    // Lower sort_order ('Second' at 1000) should appear first.
    const idxSecond = html.indexOf('Second');
    const idxFirst = html.indexOf('First');
    expect(idxSecond).toBeGreaterThan(-1);
    expect(idxFirst).toBeGreaterThan(idxSecond);
  });
});
