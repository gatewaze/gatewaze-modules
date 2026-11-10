import { describe, it, expect, afterEach } from 'vitest';
import { clientFromConfig, loadClientCredentials } from '../lib/client-credentials.js';
import { sealSecret } from '../lib/secret-envelope.js';

const ID = '141648865687-57gl4d6ck3uogo66k95jghtsrludlo4c.apps.googleusercontent.com';
const saved = process.env.GATEWAZE_SECRETS_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.GATEWAZE_SECRETS_KEY;
  else process.env.GATEWAZE_SECRETS_KEY = saved;
});

describe('clientFromConfig (shared by the routes and both workers)', () => {
  it('returns the unsealed client', () => {
    process.env.GATEWAZE_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    expect(clientFromConfig({ clientId: ID, clientSecret: sealSecret('GOCSPX-abcdefghijkl') })).toEqual({
      clientId: ID,
      clientSecret: 'GOCSPX-abcdefghijkl',
    });
  });

  it('is null, never the ciphertext, when the secret cannot be unsealed', () => {
    process.env.GATEWAZE_SECRETS_KEY = Buffer.alloc(32, 1).toString('base64');
    const sealed = sealSecret('GOCSPX-abcdefghijkl');
    process.env.GATEWAZE_SECRETS_KEY = Buffer.alloc(32, 2).toString('base64');
    expect(clientFromConfig({ clientId: ID, clientSecret: sealed })).toBeNull();
  });

  it('is null for a malformed client ID', () => {
    expect(clientFromConfig({ clientId: 'nope', clientSecret: 'plain-secret-value' })).toBeNull();
  });
});

describe('loadClientCredentials', () => {
  it('throws on a failed read instead of reporting "not configured"', async () => {
    const supabase = {
      from: () => {
        const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: null, error: { message: 'timeout' } }) };
        return b;
      },
    };
    await expect(loadClientCredentials(supabase)).rejects.toThrow(/unreadable: timeout/);
  });
});
