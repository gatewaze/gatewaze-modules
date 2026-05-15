/**
 * Tests for the auth/url helpers used by api/publish-to-git.ts when
 * pushing to an external newsletter repo. Kept under lib/ so the
 * default vitest include pattern picks them up.
 */

import { describe, expect, it } from 'vitest';
import { isOpenSshPrivateKey, toSshPushUrl } from '../../../api/publish-to-git.js';

describe('isOpenSshPrivateKey', () => {
  it('detects ed25519 OpenSSH private keys (the graduate-to-external output)', () => {
    const pem = [
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW',
      'QyNTUxOQAAACAi89...truncated...',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    expect(isOpenSshPrivateKey(pem)).toBe(true);
  });

  it('detects legacy RSA private keys for back-compat', () => {
    expect(
      isOpenSshPrivateKey('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK...\n-----END RSA PRIVATE KEY-----'),
    ).toBe(true);
  });

  it('does NOT match GitHub PATs (classic or fine-grained)', () => {
    expect(isOpenSshPrivateKey('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890')).toBe(false);
    expect(isOpenSshPrivateKey('github_pat_11AAA22BBB33CCCxxxxx_0123456789abcdef')).toBe(false);
  });

  it('does NOT match the legacy <redacted> sentinel', () => {
    expect(isOpenSshPrivateKey('<redacted>')).toBe(false);
  });

  it('does NOT match an empty string', () => {
    expect(isOpenSshPrivateKey('')).toBe(false);
  });
});

describe('toSshPushUrl', () => {
  it('rewrites github https → ssh', () => {
    expect(toSshPushUrl('https://github.com/gatewaze/example-publish.git')).toBe(
      'git@github.com:gatewaze/example-publish.git',
    );
  });

  it('rewrites github https without .git suffix', () => {
    expect(toSshPushUrl('https://github.com/gatewaze/example-publish')).toBe(
      'git@github.com:gatewaze/example-publish.git',
    );
  });

  it('rewrites gitlab https → ssh (including nested groups)', () => {
    expect(toSshPushUrl('https://gitlab.com/team/sub/repo.git')).toBe(
      'git@gitlab.com:team/sub/repo.git',
    );
  });

  it('leaves already-ssh urls unchanged', () => {
    expect(toSshPushUrl('git@github.com:gatewaze/example-publish.git')).toBe(
      'git@github.com:gatewaze/example-publish.git',
    );
  });

  it('returns null for unsupported hosts (so callers can surface a clear error)', () => {
    expect(toSshPushUrl('https://bitbucket.org/foo/bar.git')).toBeNull();
    expect(toSshPushUrl('ftp://example.com/repo')).toBeNull();
  });
});
