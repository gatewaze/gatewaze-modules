import { describe, expect, it } from 'vitest';
import { selectActiveSkillsForPrompt } from '../lib/skills/select-for-prompt.js';

function skill(id: string, bodyChars: number) {
  return {
    id,
    source_id: 'src',
    dir_path: `skills/${id}`,
    name: id,
    description: null,
    body: 'x'.repeat(bodyChars),
    body_chars: bodyChars,
    content_hash: `hash-${id}`,
    last_commit_sha: 'sha',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

describe('selectActiveSkillsForPrompt', () => {
  it('includes all skills when total is under budget', () => {
    const r = selectActiveSkillsForPrompt([skill('a', 100), skill('b', 200)], 10_000);
    expect(r.included.map((s) => s.id)).toEqual(['a', 'b']);
    expect(r.dropped).toEqual([]);
    expect(r.totalIncludedChars).toBe(300);
    expect(r.audit).toEqual([]);
  });

  it('truncates the first over-budget skill and drops subsequent ones', () => {
    const r = selectActiveSkillsForPrompt([
      skill('a', 600),
      skill('b', 600),
      skill('c', 600),
    ], 1000);
    // a included full (600), b truncated to fit remaining 400
    // (minus marker), c dropped entirely.
    expect(r.included[0]?.id).toBe('a');
    expect(r.included[0]?.status).toBe('full');
    expect(r.included[1]?.id).toBe('b');
    expect(r.included[1]?.status).toBe('truncated');
    expect(r.dropped.map((s) => s.id)).toEqual(['c']);
    expect(r.totalIncludedChars).toBeLessThanOrEqual(1000);
    expect(r.audit.some((a) => a.id === 'b' && a.status === 'truncated')).toBe(true);
    expect(r.audit.some((a) => a.id === 'c' && a.status === 'dropped')).toBe(true);
  });

  it('records original_chars even when truncated', () => {
    const r = selectActiveSkillsForPrompt([skill('a', 200), skill('b', 5000)], 500);
    const bAudit = r.audit.find((a) => a.id === 'b');
    expect(bAudit?.original_chars).toBe(5000);
  });

  it('drops a skill outright when remaining budget < usable slice', () => {
    // After a (990 chars) only 10 chars remain — too small for a
    // truncation marker + meaningful slice → drop.
    const r = selectActiveSkillsForPrompt([skill('a', 990), skill('b', 1000)], 1000);
    expect(r.included.map((s) => s.id)).toEqual(['a']);
    expect(r.dropped.map((s) => s.id)).toEqual(['b']);
  });

  it('handles empty input', () => {
    const r = selectActiveSkillsForPrompt([], 1000);
    expect(r.included).toEqual([]);
    expect(r.dropped).toEqual([]);
    expect(r.totalIncludedChars).toBe(0);
  });
});
