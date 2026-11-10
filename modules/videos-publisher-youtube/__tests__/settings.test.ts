import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseSettingsPatch, readClientSecret } from '../lib/settings.js';
import { redirectUri, CALLBACK_PATH } from '../lib/oauth.js';
import { sealSecret } from '../lib/secret-envelope.js';

const ID = '141648865687-57gl4d6ck3uogo66k95jghtsrludlo4c.apps.googleusercontent.com';

describe('parseSettingsPatch', () => {
  it('accepts a client id and secret, trimmed', () => {
    expect(parseSettingsPatch({ clientId: ` ${ID} `, clientSecret: ' GOCSPX-abcdefghijkl ' })).toEqual({
      patch: { clientId: ID, clientSecret: 'GOCSPX-abcdefghijkl' },
    });
  });

  it('keeps the stored secret when the secret is blank', () => {
    expect(parseSettingsPatch({ clientId: ID, clientSecret: '' })).toEqual({ patch: { clientId: ID } });
  });

  it('reads no field but the two it knows', () => {
    const r = parseSettingsPatch({ clientId: ID, refreshToken: 'x', isAdmin: true });
    expect(r).toEqual({ patch: { clientId: ID } });
  });

  it.each([
    [null],
    [[]],
    [{}],
    [{ clientId: 'not-a-client' }],
    [{ clientId: 42 }],
    [{ clientSecret: 'short' }],
    [{ clientSecret: 'has a space in it' }],
    [{ clientSecret: { $ne: 1 } }],
  ])('rejects %j', (body) => {
    expect(parseSettingsPatch(body)).toHaveProperty('error');
  });
});

describe('readClientSecret', () => {
  const saved = process.env.GATEWAZE_SECRETS_KEY;
  beforeEach(() => {
    process.env.GATEWAZE_SECRETS_KEY = Buffer.alloc(32, 7).toString('base64');
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATEWAZE_SECRETS_KEY;
    else process.env.GATEWAZE_SECRETS_KEY = saved;
  });

  it('unseals a sealed secret', () => {
    expect(readClientSecret(sealSecret('GOCSPX-abcdefghijkl'))).toBe('GOCSPX-abcdefghijkl');
  });

  it('never returns the ciphertext when the key cannot open it', () => {
    const sealed = sealSecret('GOCSPX-abcdefghijkl') as string;
    process.env.GATEWAZE_SECRETS_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(readClientSecret(sealed)).toBeNull();
  });

  it('passes a legacy plaintext secret through, and treats empty as unset', () => {
    expect(readClientSecret('plain-secret-value')).toBe('plain-secret-value');
    expect(readClientSecret('')).toBeNull();
    expect(readClientSecret(undefined)).toBeNull();
  });
});

describe('redirectUri', () => {
  it('points outside /api/modules, which the platform gates with a bearer token Google cannot send', () => {
    expect(CALLBACK_PATH.startsWith('/api/modules/')).toBe(false);
    expect(redirectUri('https://api.aaif.live/')).toBe('https://api.aaif.live/api/videos-publisher-youtube/oauth/callback');
  });
});
