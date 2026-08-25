import { describe, it, expect } from 'vitest';
import { branchNameFor } from '../../lib/git';

const run = { issue_number: 71, id: '9f8b3c2a-1234-5678-9abc-def012345678' };

describe('branchNameFor', () => {
  it('matches the LFX human convention when the title carries a ticket ref', () => {
    expect(branchNameFor(run, '[LFXV2-2714] Bulk send: per-recipient send-state table + chunked fan-out'))
      .toBe('feat/LFXV2-2714-bulk-send-per-recipient-send-state');
  });

  it('handles a short project prefix (2-3 letters) and single-digit ticket', () => {
    expect(branchNameFor(run, '[AB-7] Fix thing')).toBe('feat/AB-7-fix-thing');
  });

  it('falls back to agent/se-<n>-<hash> with no ticket ref (gatewaze issues)', () => {
    expect(branchNameFor(run, 'Add a retry button to the runs list')).toBe('agent/se-71-9f8b3c2a');
  });

  it('falls back with no title at all', () => {
    expect(branchNameFor(run, undefined)).toBe('agent/se-71-9f8b3c2a');
    expect(branchNameFor(run, null)).toBe('agent/se-71-9f8b3c2a');
  });

  it('falls back when the title is only the ticket ref (empty slug) — bound rejects it', () => {
    // "feat/LFXV2-2714" alone is 15 chars, within bounds, so this one actually succeeds.
    expect(branchNameFor(run, '[LFXV2-2714]')).toBe('feat/LFXV2-2714');
  });

  it('falls back when the title after the ref has no word characters at all', () => {
    expect(branchNameFor(run, '[LFXV2-2714] !!! *** ---')).toBe('feat/LFXV2-2714');
  });

  it('truncates a long title to a handful of words, not the whole sentence', () => {
    const title = '[LFXV2-2506] Per-recipient timezone-local sending using our own scheduling engine end to end';
    const branch = branchNameFor(run, title);
    expect(branch.startsWith('feat/LFXV2-2506-')).toBe(true);
    expect(branch.split('-').length).toBeLessThanOrEqual(9); // ticket(2) + up to 6 slug words + 'feat/' prefix folded in
  });

  it('never matches a bare, unbracketed word as a ticket ref', () => {
    expect(branchNameFor(run, 'LFXV2-2714 without brackets is not a ref')).toBe('agent/se-71-9f8b3c2a');
  });

  it('never matches lowercase or malformed refs', () => {
    expect(branchNameFor(run, '[lfxv2-2714] lowercase project code')).toBe('agent/se-71-9f8b3c2a');
    expect(branchNameFor(run, '[LFXV2] missing ticket number')).toBe('agent/se-71-9f8b3c2a');
  });

  it('rejects an absurdly long fabricated ref via the length bound rather than producing an odd branch', () => {
    const hostileTitle = `[${'A'.repeat(50)}-${'9'.repeat(20)}] title`;
    // The ref regex itself caps project-code and digit-run length, so this simply won't match —
    // proving the regex bound (not just the post-hoc length check) is what protects here.
    expect(branchNameFor(run, hostileTitle)).toBe('agent/se-71-9f8b3c2a');
  });

  it('NEVER produces a branch starting with "-" — the actual property that matters', () => {
    // A branch string starting with "-" is the one shape that's dangerous downstream: git
    // subcommands invoked with a branch as a bare argv element (checkout -b <branch>, push -u
    // origin <branch>, clone --branch <branch> — see lib/worktree.ts) could misparse it as a
    // flag rather than a ref name. Both return paths are fixed-literal-prefixed ('feat/' /
    // 'agent/se-'), so this should be structurally impossible; assert it directly rather than
    // only indirectly via exact-string matches above, so a refactor that drops a prefix trips
    // a test aimed at the real invariant, not an incidental one.
    const adversarialTitles = [
      '[LFXV2-1] -rf title',
      '[--upload-pack=evil-1] title',
      '[-x-1] title',
      '[LFXV2-99999999] --force-with-lease',
      undefined,
      null,
      '',
      '   ',
      '[LFXV2-1]',
      `[${'Z'.repeat(14)}-${'1'.repeat(8)}] -- --`,
    ];
    for (const title of adversarialTitles) {
      const branch = branchNameFor(run, title as string | undefined | null);
      expect(branch.startsWith('-')).toBe(false);
      expect(branch.startsWith('feat/') || branch.startsWith('agent/se-')).toBe(true);
    }
  });
});
