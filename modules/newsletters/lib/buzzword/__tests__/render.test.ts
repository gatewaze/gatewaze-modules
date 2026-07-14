import { describe, it, expect } from 'vitest';
import { renderLeaderboardHtml, esc } from '../render.js';

const meta = { submissions: 3, distinct: 2, updatedAt: '2026-07-14T10:00:00Z' };

describe('renderLeaderboardHtml', () => {
  it('renders an empty-state message with no entries', () => {
    const html = renderLeaderboardHtml([], meta);
    expect(html).toContain('No buzzwords have been submitted yet');
  });

  it('renders rows with display labels and counts', () => {
    const html = renderLeaderboardHtml(
      [
        { canonical: 'harness', display: 'Harness', count: 5 },
        { canonical: 'agentic', display: 'Agentic', count: 1 },
      ],
      meta,
    );
    expect(html).toContain('Harness');
    expect(html).toContain('5 mentions');
    expect(html).toContain('1 mention'); // singular
    expect(html).toContain('🥇');
    expect(html).not.toContain('<table');
  });

  it('escapes HTML in display labels', () => {
    const html = renderLeaderboardHtml(
      [{ canonical: 'x', display: '<script>bad</script>', count: 1 }],
      meta,
    );
    expect(html).not.toContain('<script>bad');
    expect(html).toContain('&lt;script&gt;');
  });

  it('includes the submissions caption', () => {
    const html = renderLeaderboardHtml([{ canonical: 'a', display: 'A', count: 1 }], meta);
    expect(html).toContain('3 submissions');
    expect(html).toContain('2 distinct phrases');
  });
});

describe('esc', () => {
  it('escapes the dangerous characters', () => {
    expect(esc('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });
});
