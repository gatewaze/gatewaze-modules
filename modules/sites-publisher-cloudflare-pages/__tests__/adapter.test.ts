/**
 * Adapter integration tests using a fake fetch.
 *
 * Verifies the high-level flow:
 *   - validateConfig short-circuits invalid secrets
 *   - deploy() POSTs the manifest, then uploads only the missing files
 *   - getDeploymentStatus parses the status
 *   - addDomain returns synthesized DNS instructions
 *   - removeDomain issues DELETE
 *   - getDomainStatus tolerates 404
 *   - invalidateCache is a no-op when zoneId absent
 */

import { describe, expect, it, vi } from 'vitest';
import { CloudflarePagesPublisher, type FetchLike } from '../adapter.js';
import type { BuildArtifact, PublisherSecrets } from '@gatewaze-modules/sites/types';

const SECRETS: PublisherSecrets = {
  apiToken: 'cf-token-' + 'x'.repeat(40),
  accountId: 'a'.repeat(32),
  projectName: 'example-site',
  zoneId: 'b'.repeat(32),
};

interface ScriptedResponse {
  match: (req: { url: string; method: string }) => boolean;
  body: unknown;
  status?: number;
}

function makeFakeFetch(scripts: ScriptedResponse[]): { fetch: FetchLike; calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetch: FetchLike = async (req) => {
    calls.push({ url: req.url, method: req.method, body: req.body });
    const hit = scripts.find((s) => s.match(req));
    if (!hit) throw new Error(`unscripted fetch: ${req.method} ${req.url}`);
    const status = hit.status ?? 200;
    return {
      status,
      json: async () => hit.body,
      text: async () => JSON.stringify(hit.body),
    };
  };
  return { fetch, calls };
}

const baseDeps = (overrides: Partial<Parameters<typeof CloudflarePagesPublisher.prototype.deploy>[0]> = {}) =>
  ({
    fetch: makeFakeFetch([]).fetch,
    readArtifactFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    ...overrides,
  });

describe('CloudflarePagesPublisher.validateConfig()', () => {
  it('returns ok=true for a valid bundle', () => {
    const pub = new CloudflarePagesPublisher(baseDeps());
    expect(pub.validateConfig(SECRETS).ok).toBe(true);
  });

  it('returns errors for an invalid bundle', () => {
    const pub = new CloudflarePagesPublisher(baseDeps());
    const r = pub.validateConfig({ ...SECRETS, accountId: 'bad' });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('CloudflarePagesPublisher.deploy()', () => {
  it('creates the deployment and uploads only missing files', async () => {
    const fake = makeFakeFetch([
      {
        match: (r) => r.url.includes('/deployments') && r.method === 'POST' && !r.url.includes('/assets/upload'),
        body: {
          success: true, errors: [], messages: [],
          result: {
            deployment: {
              id: 'dep-1',
              url: 'https://abc.example.pages.dev',
              environment: 'production',
              created_on: '2026-05-01T00:00:00Z',
              short_id: 'abc',
              project_id: 'pid',
              project_name: 'example-site',
              deployment_trigger: { type: 'ad_hoc' },
              latest_stage: { name: 'deploy', status: 'active', ended_on: null },
              aliases: ['example-site.pages.dev'],
            },
            jwt: 'short-lived-jwt',
            missing_hashes: ['hash-b'],   // only b needs upload
          },
        },
      },
      {
        match: (r) => r.url.includes('/assets/upload'),
        body: { success: true, errors: [], messages: [], result: {} },
      },
    ]);
    const pub = new CloudflarePagesPublisher({
      fetch: fake.fetch,
      readArtifactFile: async (_dir, p) => Buffer.from(`bytes-of-${p}`, 'utf8'),
    });
    const artifact: BuildArtifact = {
      buildId: 'b1',
      artifactDir: '/tmp/artifact',
      fileManifest: [
        { relPath: 'index.html', sha256: 'hash-a', size: 100 },
        { relPath: 'about.html', sha256: 'hash-b', size: 50 },
      ],
      dynamicEntrypoints: [],
      pageRoutes: [
        { fullPath: '/', relPath: 'index.html', cacheTtlSeconds: 300 },
        { fullPath: '/about', relPath: 'about.html', cacheTtlSeconds: 300 },
      ],
    };
    const result = await pub.deploy(artifact, SECRETS);
    expect(result.publicUrl).toBe('https://abc.example.pages.dev');
    expect(result.deployId).toBe('dep-1');
    expect(result.cdnDomains).toEqual(['example-site.pages.dev']);

    // Exactly 2 fetch calls: 1 create + 1 upload (only hash-b was missing).
    expect(fake.calls).toHaveLength(2);
    const uploadCalls = fake.calls.filter((c) => c.url.includes('/assets/upload'));
    expect(uploadCalls).toHaveLength(1);
  });

  it('throws when secrets are invalid (does not hit the network)', async () => {
    const fake = makeFakeFetch([]);
    const pub = new CloudflarePagesPublisher({
      fetch: fake.fetch,
      readArtifactFile: async () => new Uint8Array(0),
    });
    await expect(
      pub.deploy({ buildId: 'b', artifactDir: '/x', fileManifest: [], dynamicEntrypoints: [], pageRoutes: [] }, { apiToken: 'short' }),
    ).rejects.toThrow(/invalid_secrets/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('CloudflarePagesPublisher.getDeploymentStatus()', () => {
  it('maps stage=success to state=live', async () => {
    const fake = makeFakeFetch([{
      match: (r) => r.method === 'GET' && r.url.includes('/deployments/dep-1'),
      body: {
        success: true, errors: [], messages: [],
        result: {
          id: 'dep-1', url: 'https://x.pages.dev', environment: 'production',
          created_on: '', short_id: '', project_id: '', project_name: '',
          deployment_trigger: { type: 'ad_hoc' },
          latest_stage: { name: 'deploy', status: 'success', ended_on: '' },
        },
      },
    }]);
    const pub = new CloudflarePagesPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.getDeploymentStatus('dep-1', SECRETS);
    expect(r.state).toBe('live');
    expect(r.public_url).toBe('https://x.pages.dev');
  });

  it('returns state=unknown if Cloudflare returns 404', async () => {
    const fake: { fetch: FetchLike } = {
      fetch: async () => { throw new Error('cloudflare_resource_not_found'); },
    };
    const pub = new CloudflarePagesPublisher({ ...fake, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.getDeploymentStatus('missing', SECRETS);
    expect(r.state).toBe('unknown');
  });
});

describe('CloudflarePagesPublisher.addDomain() / removeDomain() / getDomainStatus()', () => {
  it('addDomain returns synthesized DNS instructions for an apex', async () => {
    const fake = makeFakeFetch([{
      match: (r) => r.method === 'POST' && r.url.includes('/domains'),
      body: { success: true, errors: [], messages: [], result: { id: 'd1', name: 'example.com', status: 'pending' } },
    }]);
    const pub = new CloudflarePagesPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.addDomain('example.com', SECRETS);
    const types = r.dnsInstructions.map((d) => d.record_type).sort();
    expect(types).toEqual(['A', 'AAAA']);
  });

  it('removeDomain issues DELETE', async () => {
    const fake = makeFakeFetch([{
      match: (r) => r.method === 'DELETE' && r.url.includes('/domains/'),
      body: { success: true, errors: [], messages: [], result: null },
    }]);
    const pub = new CloudflarePagesPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    await pub.removeDomain('foo.com', SECRETS);
    expect(fake.calls[0]?.method).toBe('DELETE');
  });

  it('getDomainStatus maps status=active → verified', async () => {
    const fake = makeFakeFetch([{
      match: (r) => r.method === 'GET' && r.url.includes('/domains/'),
      body: { success: true, errors: [], messages: [], result: { id: 'd1', name: 'foo.com', status: 'active' } },
    }]);
    const pub = new CloudflarePagesPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.getDomainStatus('foo.com', SECRETS);
    expect(r.state).toBe('verified');
  });
});

describe('CloudflarePagesPublisher.invalidateCache()', () => {
  it('no-ops when zoneId is missing', async () => {
    const fake = makeFakeFetch([]);
    const pub = new CloudflarePagesPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    await pub.invalidateCache({ ...SECRETS, zoneId: undefined as unknown as string }, ['/about']);
    expect(fake.calls).toHaveLength(0);
  });

  it('batches paths into ≤30-element chunks', async () => {
    let calls = 0;
    const fake: FetchLike = async () => {
      calls++;
      return { status: 200, json: async () => ({ success: true, errors: [], messages: [], result: { id: 'p' } }), text: async () => '' };
    };
    const pub = new CloudflarePagesPublisher({ fetch: fake, readArtifactFile: async () => new Uint8Array(0) });
    const paths = Array.from({ length: 65 }, (_, i) => `/p${i}`);
    await pub.invalidateCache(SECRETS, paths);
    expect(calls).toBe(3);  // 30 + 30 + 5
  });
});

describe('CloudflarePagesPublisher.syncMedia()', () => {
  it('reports inline-in-artifact mode (no separate CDN sync)', async () => {
    const pub = new CloudflarePagesPublisher({ fetch: async () => ({ status: 200, json: async () => ({}), text: async () => '' }), readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.syncMedia('site-1', [], SECRETS);
    expect(r.mode).toBe('inline-in-artifact');
    expect(r.bytesSynced).toBe(0);
  });
});
