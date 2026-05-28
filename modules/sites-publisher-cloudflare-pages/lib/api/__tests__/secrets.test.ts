import { describe, expect, it } from 'vitest';
import { validateSecrets } from '../secrets.js';

const VALID = {
  apiToken: 'cf-token-' + 'x'.repeat(40),
  accountId: 'a'.repeat(32),
  projectName: 'example-site',
};

describe('validateSecrets()', () => {
  it('accepts a valid bundle', () => {
    const r = validateSecrets(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value?.apiToken).toBe(VALID.apiToken);
    expect(r.value?.accountId).toBe(VALID.accountId);
  });

  it('rejects missing apiToken', () => {
    const r = validateSecrets({ ...VALID, apiToken: undefined });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.path === 'apiToken')).toBeTruthy();
  });

  it('rejects short apiToken', () => {
    const r = validateSecrets({ ...VALID, apiToken: 'short' });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed accountId', () => {
    const r = validateSecrets({ ...VALID, accountId: 'not-hex' });
    expect(r.ok).toBe(false);
    expect(r.errors.find((e) => e.path === 'accountId')).toBeTruthy();
  });

  it('rejects projectName with uppercase or invalid chars', () => {
    expect(validateSecrets({ ...VALID, projectName: 'EXAMPLE' }).ok).toBe(false);
    expect(validateSecrets({ ...VALID, projectName: 'has space' }).ok).toBe(false);
    expect(validateSecrets({ ...VALID, projectName: '-leading-dash' }).ok).toBe(false);
    expect(validateSecrets({ ...VALID, projectName: 'trailing-dash-' }).ok).toBe(false);
  });

  it('rejects malformed zoneId when present', () => {
    const r = validateSecrets({ ...VALID, zoneId: 'not-32-hex' });
    expect(r.ok).toBe(false);
  });

  it('accepts optional zoneId when valid', () => {
    const r = validateSecrets({ ...VALID, zoneId: 'b'.repeat(32) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value?.zoneId).toBe('b'.repeat(32));
  });

  it('rejects non-object input', () => {
    expect(validateSecrets(null).ok).toBe(false);
    expect(validateSecrets('string').ok).toBe(false);
    expect(validateSecrets(42).ok).toBe(false);
  });

  it('returns multiple field errors at once', () => {
    const r = validateSecrets({});
    expect(r.ok).toBe(false);
    const fields = r.errors.map((e) => e.path).sort();
    expect(fields).toEqual(['accountId', 'apiToken', 'projectName']);
  });
});
