import { describe, it, expect } from 'vitest';
import { renderLeaderboardHtml, esc } from '../render.js';

const meta = { submissions: 3, distinct: 2, updatedAt: '2026-07-14T10:00:00Z' };

describe('renderLeaderboardHtml', () => {
  it('renders an empty-state message with no entries', () => {
    const html = renderLeaderboardHtml([], meta);
    expect(html).toContain('No buzzwords have been submitted yet');
  });

  it('renders rows with display labels and share percentages', () => {
    const html = renderLeaderboardHtml(
      [
        { canonical: 'harness', display: 'Harness', count: 6 },
        { canonical: 'agentic', display: 'Agentic', count: 2 },
      ],
      meta,
    );
    expect(html).toContain('Harness');
    // percentages of total mentions (8), not raw counts
    expect(html).toContain('75%'); // 6/8
    expect(html).toContain('25%'); // 2/8
    expect(html).not.toContain('mentions');
    expect(html).toContain('🥇');
    expect(html).not.toContain('<table');
    expect(html).not.toContain('max-width'); // bars use the full section width
  });

  it('escapes HTML in display labels', () => {
    const html = renderLeaderboardHtml(
      [{ canonical: 'x', display: '<script>bad</script>', count: 1 }],
      meta,
    );
    expect(html).not.toContain('<script>bad');
    expect(html).toContain('&lt;script&gt;');
  });

  it('captions with distinct phrases, not submissions', () => {
    const html = renderLeaderboardHtml([{ canonical: 'a', display: 'A', count: 1 }], meta);
    expect(html).toContain('2 distinct phrases');
    expect(html).not.toContain('submission');
  });
});

describe('esc', () => {
  it('escapes the dangerous characters', () => {
    expect(esc('<a href="x">&')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;');
  });
});
