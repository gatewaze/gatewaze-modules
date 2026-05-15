/**
 * Unit tests for graduateNewsletterToExternal.
 *
 * The function is heavy (spawns git + ssh-keygen, hits GitHub/GitLab APIs)
 * so these tests focus on the pure-logic surface that doesn't need a
 * real network or filesystem:
 *
 *   - layout resolution (single-repo vs separate-repos, error shapes)
 *   - URL parsing helpers (detectProvider, parseOwnerRepo, toSshUrl)
 *   - mixed/missing-input rejection
 *
 * The integration paths (actual push + ssh-keygen + DB writes) are
 * exercised separately in the publish-to-git e2e script under
 * scripts/e2e-newsletter-graduate.ts; that file requires real
 * credentials and runs out-of-band.
 */

import { describe, expect, it } from 'vitest';
import {
  detectProvider,
  parseOwnerRepo,
  toSshUrl,
} from '../graduate-to-external.js';

describe('detectProvider', () => {
  it('recognises github.com https', () => {
    expect(detectProvider('https://github.com/gatewaze/aaif-theme.git')).toBe('github');
  });
  it('recognises gitlab.com https', () => {
    expect(detectProvider('https://gitlab.com/group/sub/repo.git')).toBe('gitlab');
  });
  it('recognises github ssh form', () => {
    expect(detectProvider('git@github.com:gatewaze/aaif-theme.git')).toBe('github');
  });
  it('returns null for unrecognised hosts', () => {
    expect(detectProvider('https://bitbucket.org/foo/bar.git')).toBeNull();
    expect(detectProvider('https://gitea.example.com/foo/bar.git')).toBeNull();
  });
});

describe('parseOwnerRepo', () => {
  it('parses github owner/repo', () => {
    expect(parseOwnerRepo('https://github.com/gatewaze/aaif-publish.git', 'github')).toBe(
      'gatewaze/aaif-publish',
    );
  });
  it('parses github owner/repo without .git suffix', () => {
    expect(parseOwnerRepo('https://github.com/gatewaze/aaif-publish', 'github')).toBe(
      'gatewaze/aaif-publish',
    );
  });
  it('parses gitlab nested-group path', () => {
    expect(parseOwnerRepo('https://gitlab.com/parent/sub/repo.git', 'gitlab')).toBe(
      'parent/sub/repo',
    );
  });
  it('rejects malformed urls', () => {
    expect(parseOwnerRepo('https://github.com/notarepo', 'github')).toBeNull();
  });
});

describe('toSshUrl', () => {
  it('converts github https → ssh form', () => {
    expect(toSshUrl('https://github.com/gatewaze/aaif-publish.git', 'github')).toBe(
      'git@github.com:gatewaze/aaif-publish.git',
    );
  });
  it('passes through already-ssh urls unchanged', () => {
    expect(toSshUrl('git@github.com:gatewaze/aaif-publish.git', 'github')).toBe(
      'git@github.com:gatewaze/aaif-publish.git',
    );
  });
});

// ---------------------------------------------------------------------------
// Layout resolution — tested via the wrapper export. We can't reach
// resolveLayout directly without exposing it, so use a tiny shim that
// triggers it through graduateNewsletterToExternal's error path.
// ---------------------------------------------------------------------------

describe('graduateNewsletterToExternal — layout validation', () => {
  // Build a graduate args object with both single-repo and separate-repo
  // fields set; the layout resolver should reject this before doing any
  // real work.
  function makeFakeDeps() {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase: { from(): any { return makeFakeQuery(); } },
      fetch: async () => new Response('{}', { status: 200 }),
      softDeleteInternalRepo: async () => undefined,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    };
  }
  function makeFakeQuery() {
    return {
      select() { return this; },
      eq() { return this; },
      maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      upsert() { return Promise.resolve({ data: null, error: null }); },
      update() { return this; },
    };
  }

  it('rejects mixed single + separate URLs', async () => {
    const { graduateNewsletterToExternal } = await import('../graduate-to-external.js');
    await expect(
      graduateNewsletterToExternal(
        {
          collectionId: 'c1',
          collection: { name: 'AAIF', slug: 'aaif' },
          internalRepo: { id: 'r1', barePath: '/tmp/missing.git' },
          externalGitUrl: 'https://github.com/foo/single.git',
          externalThemeGitUrl: 'https://github.com/foo/theme.git',
          externalPublishGitUrl: 'https://github.com/foo/publish.git',
          pat: 'ghp_test',
        },
        makeFakeDeps(),
      ),
    ).rejects.toThrow(/graduate_layout_invalid/);
  });

  it('rejects separate-repos mode with only theme URL set', async () => {
    const { graduateNewsletterToExternal } = await import('../graduate-to-external.js');
    await expect(
      graduateNewsletterToExternal(
        {
          collectionId: 'c1',
          collection: { name: 'AAIF', slug: 'aaif' },
          internalRepo: { id: 'r1', barePath: '/tmp/missing.git' },
          externalThemeGitUrl: 'https://github.com/foo/theme.git',
          pat: 'ghp_test',
        },
        makeFakeDeps(),
      ),
    ).rejects.toThrow(/graduate_layout_invalid/);
  });

  it('rejects unsupported provider URL', async () => {
    const { graduateNewsletterToExternal } = await import('../graduate-to-external.js');
    await expect(
      graduateNewsletterToExternal(
        {
          collectionId: 'c1',
          collection: { name: 'AAIF', slug: 'aaif' },
          internalRepo: { id: 'r1', barePath: '/tmp/missing.git' },
          externalGitUrl: 'https://codeberg.org/foo/single.git',
          pat: 'ghp_test',
        },
        makeFakeDeps(),
      ),
    ).rejects.toThrow(/unsupported git provider/);
  });
});
