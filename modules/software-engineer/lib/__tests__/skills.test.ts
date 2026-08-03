// @ts-nocheck — vitest harness; the lib modules are @ts-nocheck'd already.
import { describe, it, expect } from 'vitest';
import { parseSkillsConfig } from '../skills.js';

// parseSkillsConfig is the single guard between an admin-set `skills` value and a Bash-capable
// agent session loading it as a local plugin. It must accept only well-formed, non-escaping entries
// and silently drop everything else (never repair, never throw).
describe('parseSkillsConfig', () => {
  it('returns [] for non-array / empty input', () => {
    expect(parseSkillsConfig(undefined)).toEqual([]);
    expect(parseSkillsConfig(null)).toEqual([]);
    expect(parseSkillsConfig('nope')).toEqual([]);
    expect(parseSkillsConfig({})).toEqual([]);
    expect(parseSkillsConfig([])).toEqual([]);
  });

  it('accepts a valid entry and defaults ref to main + path to empty', () => {
    expect(parseSkillsConfig([{ repo: 'gatewaze/gatewaze-skills', path: 'plugins/gatewaze-skills' }]))
      .toEqual([{ repo: 'gatewaze/gatewaze-skills', path: 'plugins/gatewaze-skills', ref: 'main' }]);
    expect(parseSkillsConfig([{ repo: 'owner/name' }]))
      .toEqual([{ repo: 'owner/name', path: '', ref: 'main' }]);
  });

  it('trims a leading/trailing slash off path', () => {
    expect(parseSkillsConfig([{ repo: 'o/n', path: '/plugins/x/' }])[0].path).toBe('plugins/x');
  });

  it('drops entries with a malformed repo shape', () => {
    expect(parseSkillsConfig([{ repo: 'no-slash' }])).toEqual([]);
    expect(parseSkillsConfig([{ repo: 'too/many/parts' }])).toEqual([]);
    expect(parseSkillsConfig([{ repo: '' }])).toEqual([]);
    expect(parseSkillsConfig([{ repo: 'a/..' }])).toEqual([]);
  });

  it('rejects path traversal and unsafe path chars', () => {
    expect(parseSkillsConfig([{ repo: 'o/n', path: '../etc' }])).toEqual([]);
    expect(parseSkillsConfig([{ repo: 'o/n', path: 'a/../../b' }])).toEqual([]);
    expect(parseSkillsConfig([{ repo: 'o/n', path: 'a b; rm -rf' }])).toEqual([]);
    expect(parseSkillsConfig([{ repo: 'o/n', path: '$(whoami)' }])).toEqual([]);
  });

  it('rejects a flag-like or traversing ref', () => {
    expect(parseSkillsConfig([{ repo: 'o/n', ref: '--upload-pack=x' }])).toEqual([]);
    expect(parseSkillsConfig([{ repo: 'o/n', ref: 'a/../b' }])).toEqual([]);
    expect(parseSkillsConfig([{ repo: 'o/n', ref: 'feat/thing' }])[0].ref).toBe('feat/thing');
  });

  it('ignores non-object entries and caps the list at 10', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ repo: `o/n${i}` }));
    expect(parseSkillsConfig([null, 5, 'x', ...many]).length).toBe(10);
  });
});
