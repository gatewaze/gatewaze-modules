import { describe, expect, it } from 'vitest';
import { validateSecrets } from '../secrets.js';

const VALID_UUID = '12345678-1234-1234-1234-123456789012';
const VALID_TOKEN = 'nfp_' + 'x'.repeat(40);

describe('validateSecrets()', () => {
  it('accepts a valid bundle (UUID siteId)', () => {
    const r = validateSecrets({ apiToken: VALID_TOKEN, siteId: VALID_UUID });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value?.siteId).toBe(VALID_UUID);
  });

  it('accepts a 24-char hex siteId (legacy)', () => {
    const r = validateSecrets({ apiToken: VALID_TOKEN, siteId: 'a'.repeat(24) });
    expect(r.ok).toBe(true);
  });

  it('rejects malformed siteId', () => {
    expect(validateSecrets({ apiToken: VALID_TOKEN, siteId: 'not-a-uuid' }).ok).toBe(false);
    expect(validateSecrets({ apiToken: VALID_TOKEN, siteId: 'a'.repeat(20) }).ok).toBe(false);
  });

  it('rejects short apiToken', () => {
    const r = validateSecrets({ apiToken: 'short', siteId: VALID_UUID });
    expect(r.ok).toBe(false);
  });

  it('accepts optional teamSlug', () => {
    const r = validateSecrets({ apiToken: VALID_TOKEN, siteId: VALID_UUID, teamSlug: 'gw-prod' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value?.teamSlug).toBe('gw-prod');
  });

  it('rejects empty teamSlug', () => {
    expect(validateSecrets({ apiToken: VALID_TOKEN, siteId: VALID_UUID, teamSlug: '' }).ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(validateSecrets(null).ok).toBe(false);
    expect(validateSecrets('s').ok).toBe(false);
  });

  it('returns multiple field errors at once', () => {
    const r = validateSecrets({});
    const fields = r.errors.map((e) => e.path).sort();
    expect(fields).toEqual(['apiToken', 'siteId']);
  });
});
