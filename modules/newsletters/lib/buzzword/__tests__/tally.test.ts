import { describe, it, expect } from 'vitest';
import {
  buildLeaderboard,
  groupCanonicals,
  titleCaseDisplay,
  normCanonical,
} from '../tally.js';
import type { ReplyBuzzwordStamp, ExtractedPhrase } from '../types.js';

function extracted(...canonicals: string[]): ReplyBuzzwordStamp {
  const phrases: ExtractedPhrase[] = canonicals.map((c) => ({
    canonical: c,
    display: c,
    verbatim: c,
  }));
  return { status: 'extracted', run_id: 'run1', phrases, applied_at: '2026-07-14T00:00:00Z' };
}

describe('titleCaseDisplay', () => {
  it('title-cases plain phrases', () => {
    expect(titleCaseDisplay('loop engineering')).toBe('Loop Engineering');
  });
  it('preserves known acronyms', () => {
    expect(titleCaseDisplay('mcp')).toBe('MCP');
    expect(titleCaseDisplay('ai governance')).toBe('AI Governance');
    expect(titleCaseDisplay('agentic ai')).toBe('Agentic AI');
  });
  it('capitalises each part of a hyphenated compound', () => {
    expect(titleCaseDisplay('multi-agent')).toBe('Multi-Agent');
    expect(titleCaseDisplay('load-bearing')).toBe('Load-Bearing');
  });
});

describe('groupCanonicals', () => {
  it('collapses a longer phrase into its submitted leading base', () => {
    const g = groupCanonicals(['harness', 'harness engineering']);
    expect(g.get('harness engineering')).toBe('harness');
    expect(g.get('harness')).toBe('harness');
  });
  it('does not group when no bare base was submitted', () => {
    const g = groupCanonicals(['harness engineering', 'harness reliability']);
    expect(g.get('harness engineering')).toBe('harness engineering');
    expect(g.get('harness reliability')).toBe('harness reliability');
  });
  it('does not merge on partial-word overlap (agentic vs agent)', () => {
    const g = groupCanonicals(['agent', 'agentic']);
    expect(g.get('agentic')).toBe('agentic');
    expect(g.get('agent')).toBe('agent');
  });
});

describe('buildLeaderboard', () => {
  it('groups similar phrases and counts once per group per reply', () => {
    const board = buildLeaderboard([
      extracted('harness'),
      extracted('harness engineering'),
      extracted('harness engineering'),
      extracted('loop engineering'),
    ]);
    const harness = board.find((e) => e.display === 'Harness');
    expect(harness?.count).toBe(3); // 1 harness + 2 harness engineering, grouped
    expect(board.find((e) => e.display === 'Loop Engineering')?.count).toBe(1);
  });

  it('counts a phrase once per reply even if repeated or grouped within it', () => {
    // One reply submits both "harness" and "harness engineering" → one count.
    const board = buildLeaderboard([extracted('harness', 'harness engineering')]);
    expect(board).toHaveLength(1);
    expect(board[0].count).toBe(1);
  });

  it('ignores non-extracted stamps', () => {
    const board = buildLeaderboard([
      { status: 'no_phrase', run_id: 'r', applied_at: 'x' },
      { status: 'not_a_submission', run_id: 'r', applied_at: 'x' },
      extracted('agentic'),
    ]);
    expect(board).toHaveLength(1);
    expect(board[0].display).toBe('Agentic');
  });

  it('sorts by count desc then display asc', () => {
    const board = buildLeaderboard([
      extracted('agentic'),
      extracted('harness'),
      extracted('harness'),
    ]);
    expect(board.map((e) => e.display)).toEqual(['Harness', 'Agentic']);
  });
});

describe('normCanonical', () => {
  it('lowercases and collapses whitespace', () => {
    expect(normCanonical('  Loop   Engineering ')).toBe('loop engineering');
  });
});
