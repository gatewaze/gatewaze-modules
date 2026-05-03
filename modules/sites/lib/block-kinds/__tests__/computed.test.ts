import { describe, expect, it } from 'vitest';
import { computeBlockContent, registerComputedAlgorithm } from '../computed.js';

describe('computeBlockContent — built-in algorithms', () => {
  describe('table-of-contents', () => {
    it('extracts h2/h3/h4 from rich-text markdown', () => {
      const result = computeBlockContent('table-of-contents', {
        inputs: [
          {
            block_def_name: 'rich-text',
            sort_order: 1,
            content: { body: '## Section A\nText\n### Sub A\n## Section B' },
          },
        ],
      });
      expect(result).toEqual({
        items: [
          { level: 2, text: 'Section A', id: 'section-a' },
          { level: 3, text: 'Sub A', id: 'sub-a' },
          { level: 2, text: 'Section B', id: 'section-b' },
        ],
      });
    });

    it('extracts h2/h3 from rich-text HTML', () => {
      const result = computeBlockContent('table-of-contents', {
        inputs: [
          {
            block_def_name: 'rich-text',
            sort_order: 1,
            content: { body: '<h2>HTML Heading</h2><p>text</p><h3>Sub</h3>' },
          },
        ],
      });
      expect((result.items as Array<{ text: string }>).map((i) => i.text)).toEqual(['HTML Heading', 'Sub']);
    });

    it('skips h1 (page title) and h5+ (too granular)', () => {
      const result = computeBlockContent('table-of-contents', {
        inputs: [{
          block_def_name: 'rich-text', sort_order: 1,
          content: { body: '# Title\n## Real heading\n##### Skipped' },
        }],
      });
      const items = result.items as Array<{ text: string }>;
      expect(items).toHaveLength(1);
      expect(items[0]?.text).toBe('Real heading');
    });

    it('extracts dedicated heading blocks', () => {
      const result = computeBlockContent('table-of-contents', {
        inputs: [
          { block_def_name: 'heading', sort_order: 0, content: { text: 'First', level: 2 } },
          { block_def_name: 'heading', sort_order: 1, content: { text: 'Second', level: 3 } },
        ],
      });
      expect(result.items).toEqual([
        { level: 2, text: 'First', id: 'first' },
        { level: 3, text: 'Second', id: 'second' },
      ]);
    });

    it('produces accessible slugs (kebab-case, special chars stripped)', () => {
      const result = computeBlockContent('table-of-contents', {
        inputs: [{
          block_def_name: 'rich-text', sort_order: 0,
          content: { body: '## Hello, World! (2024)' },
        }],
      });
      const items = result.items as Array<{ id: string }>;
      expect(items[0]?.id).toBe('hello-world-2024');
    });
  });

  describe('estimated-reading-time', () => {
    it('counts words across rich-text + heading blocks', () => {
      const result = computeBlockContent('estimated-reading-time', {
        inputs: [
          { block_def_name: 'heading', sort_order: 0, content: { text: 'Three word heading' } },
          { block_def_name: 'rich-text', sort_order: 1, content: { body: 'Word '.repeat(225) + 'final' } },
        ],
      });
      expect(result.word_count).toBeGreaterThanOrEqual(225);
      expect(result.minutes).toBeGreaterThanOrEqual(1);
      expect(result.label).toMatch(/min read/);
    });

    it('returns "1 min read" floor for short pages', () => {
      const result = computeBlockContent('estimated-reading-time', {
        inputs: [{ block_def_name: 'rich-text', sort_order: 0, content: { body: 'Hello world' } }],
      });
      expect(result.minutes).toBe(1);
      expect(result.label).toBe('1 min read');
    });

    it('strips HTML tags before counting', () => {
      const result = computeBlockContent('estimated-reading-time', {
        inputs: [{ block_def_name: 'rich-text', sort_order: 0, content: { body: '<p>One two <strong>three</strong> four</p>' } }],
      });
      expect(result.word_count).toBe(4);
    });

    it('respects custom wpm via kindConfig', () => {
      // 100 words at default 225 wpm = 1 min; at 50 wpm = 2 min
      const slowResult = computeBlockContent('estimated-reading-time', {
        inputs: [{ block_def_name: 'rich-text', sort_order: 0, content: { body: 'word '.repeat(100) } }],
        kindConfig: { wpm: 50 },
      });
      expect(slowResult.minutes).toBe(2);
    });
  });

  describe('tag-list', () => {
    it('aggregates + dedupes + sorts tags across blocks', () => {
      const result = computeBlockContent('tag-list', {
        inputs: [
          { block_def_name: 'rich-text', sort_order: 0, content: { tags: ['typescript', 'react'] } },
          { block_def_name: 'rich-text', sort_order: 1, content: { tags: ['react', 'next.js'] } },
        ],
      });
      expect(result.tags).toEqual(['next.js', 'react', 'typescript']);
    });

    it('returns empty array when no tags present', () => {
      const result = computeBlockContent('tag-list', {
        inputs: [{ block_def_name: 'rich-text', sort_order: 0, content: {} }],
      });
      expect(result.tags).toEqual([]);
    });
  });
});

describe('computeBlockContent — registered algorithms', () => {
  it('returns empty object when no algorithm registered', () => {
    const result = computeBlockContent('unknown-block', { inputs: [] });
    expect(result).toEqual({});
  });

  it('runs custom registered algorithm', () => {
    registerComputedAlgorithm('custom-counter', (ctx) => ({ count: ctx.inputs.length }));
    const result = computeBlockContent('custom-counter', {
      inputs: [
        { block_def_name: 'rich-text', sort_order: 0, content: {} },
        { block_def_name: 'heading', sort_order: 1, content: {} },
      ],
    });
    expect(result.count).toBe(2);
  });
});
