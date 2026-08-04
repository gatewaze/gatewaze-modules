import { describe, it, expect } from 'vitest';
import { resolveProjectAvatar, projectOptionLabel } from '../components/projectAvatar';

// Issue #27 — the SE admin UI standardised on outline SVG icons; the project "folder" mark now
// falls back to <FolderIcon> instead of a coloured `📁` emoji. The single behavioural invariant is
// that a user's *chosen* avatar_emoji is preserved and only the default falls through to the icon.
// The DOM (<ProjectAvatar>) can't render under this module's `node` vitest env (no jsdom, and
// heroicons is a host-provided peer), so we pin the branch via the pure resolver it delegates to.
describe('resolveProjectAvatar', () => {
  it('keeps a user-chosen emoji', () => {
    expect(resolveProjectAvatar('🚀')).toEqual({ kind: 'emoji', value: '🚀' });
  });

  it('falls back to the outline icon for null / undefined / empty', () => {
    expect(resolveProjectAvatar(null)).toEqual({ kind: 'icon' });
    expect(resolveProjectAvatar(undefined)).toEqual({ kind: 'icon' });
    expect(resolveProjectAvatar('')).toEqual({ kind: 'icon' });
  });

  it('treats an all-whitespace value as unset (icon, not a blank span)', () => {
    expect(resolveProjectAvatar('   ')).toEqual({ kind: 'icon' });
    expect(resolveProjectAvatar('  🎯  ')).toEqual({ kind: 'emoji', value: '🎯' });
  });
});

describe('projectOptionLabel', () => {
  it('prefixes a user emoji before the name', () => {
    expect(projectOptionLabel('🚀', 'Rocket')).toBe('🚀 Rocket');
  });

  it('drops the default folder glyph entirely — no `📁` leaks into an <option>', () => {
    const label = projectOptionLabel(null, 'Plain');
    expect(label).toBe('Plain');
    expect(label).not.toContain('📁');
  });

  it('tolerates a missing name', () => {
    expect(projectOptionLabel(null, undefined)).toBe('');
    expect(projectOptionLabel('🚀', null)).toBe('🚀');
  });
});
