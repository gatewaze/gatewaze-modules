import { describe, expect, it } from 'vitest';
import { parseSkillFile } from '../../lib/skills/frontmatter.js';

describe('parseSkillFile', () => {
  it('parses frontmatter + body', () => {
    const raw = `---\nname: Tone of voice\ndescription: Brand voice guide\ntags:\n  - tone\napplies_to:\n  - newsletter\n---\n\n# Be terse\n\nUse active voice.`;
    const r = parseSkillFile('skills/tone.md', raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.name).toBe('Tone of voice');
    expect(r.skill.description).toBe('Brand voice guide');
    expect(r.skill.tags).toEqual(['tone']);
    expect(r.skill.applies_to).toEqual(['newsletter']);
    expect(r.skill.body).toContain('Use active voice.');
    expect(r.skill.body_chars).toBe(r.skill.body.length);
    expect(r.skill.content_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('synthesizes name from basename when frontmatter missing', () => {
    const raw = `# Header line\n\nFirst paragraph here.\n\nSecond paragraph.`;
    const r = parseSkillFile('skills/compliance-rules.md', raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.name).toBe('compliance-rules');
    // First paragraph (with leading # stripped) feeds the description fallback.
    expect(r.skill.description).toContain('Header line');
  });

  it('drops applies_to values outside the allowed set', () => {
    const raw = `---\nname: Bad\napplies_to:\n  - newsletter\n  - everything\n  - site\n  - 123\n---\n\nBody`;
    const r = parseSkillFile('x.md', raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.applies_to).toEqual(['newsletter', 'site']);
  });

  it('caps tags array and rejects oversized tags', () => {
    const raw = `---\nname: T\ntags:\n${Array.from({ length: 60 }, (_, i) => `  - tag${i}`).join('\n')}\n---\n\nBody`;
    const r = parseSkillFile('x.md', raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.skill.tags.length).toBeLessThanOrEqual(32);
  });

  it('returns ok=false when YAML is malformed', () => {
    const raw = `---\nname: Bad\n  this: is: not: yaml\n---\nbody`;
    const r = parseSkillFile('bad.md', raw);
    expect(r.ok).toBe(false);
  });

  it('content_hash is deterministic for same body', () => {
    const raw1 = `---\nname: A\n---\nIdentical body content`;
    const raw2 = `---\nname: B\n---\nIdentical body content`;
    const r1 = parseSkillFile('a.md', raw1);
    const r2 = parseSkillFile('b.md', raw2);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.skill.content_hash).toBe(r2.skill.content_hash);
  });
});
