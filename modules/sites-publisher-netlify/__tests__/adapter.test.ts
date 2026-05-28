import { describe, expect, it, vi } from 'vitest';
import { NetlifyPublisher, type FetchLike } from '../adapter.js';
import type { BuildArtifact, PublisherSecrets } from '@gatewaze-modules/sites/types';

const SECRETS: PublisherSecrets = {
  apiToken: 'nfp_' + 'x'.repeat(40),
  siteId: '12345678-1234-1234-1234-123456789012',
};

interface ScriptedResponse {
  match: (req: { url: string; method: string }) => boolean;
  body?: unknown;
  status?: number;
}

function makeFakeFetch(scripts: ScriptedResponse[]): { fetch: FetchLike; calls: Array<{ url: string; method: string; body: unknown }> } {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetch: FetchLike = async (req) => {
    calls.push({ url: req.url, method: req.method, body: req.body });
    const hit = scripts.find((s) => s.match(req));
    if (!hit) throw new Error(`unscripted: ${req.method} ${req.url}`);
    return {
      status: hit.status ?? 200,
      json: async () => hit.body,
      text: async () => JSON.stringify(hit.body ?? ''),
    };
  };
  return { fetch, calls };
}

const baseDeps = (overrides: Partial<{ fetch: FetchLike; readArtifactFile: (d: string, p: string) => Promise<Uint8Array> }> = {}) => ({
  fetch: makeFakeFetch([]).fetch,
  readArtifactFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
  ...overrides,
});

describe('NetlifyPublisher.validateConfig()', () => {
  it('returns ok=true for a valid bundle', () => {
    const pub = new NetlifyPublisher(baseDeps());
    expect(pub.validateConfig(SECRETS).ok).toBe(true);
  });

  it('returns errors for an invalid bundle', () => {
    const pub = new NetlifyPublisher(baseDeps());
    const r = pub.validateConfig({ ...SECRETS, siteId: 'bad' });
    expect(r.ok).toBe(false);
  });
});

describe('NetlifyPublisher.deploy()', () => {
  it('uploads only the files in `required[]`', async () => {
    const fake = makeFakeFetch([
      {
        match: (r) => r.method === 'POST' && r.url.includes('/sites/') && r.url.includes('/deploys') && !r.url.includes('/files'),
        body: {
          id: 'dep-1',
          site_id: SECRETS.siteId,
          state: 'uploading',
          name: 'example-prod',
          url: 'http://example.netlify.app',
          ssl_url: 'https://example.netlify.app',
          admin_url: 'https://app.netlify.com/sites/example-prod',
          deploy_url: 'http://dep-1--example-prod.netlify.app',
          deploy_ssl_url: 'https://dep-1--example-prod.netlify.app',
          required: ['352f7829a2384b001cc12b0c2613c756454a1f6a'],   // sha1 of "second"
          created_at: '2026-05-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00Z',
        },
      },
      {
        match: (r) => r.method === 'PUT' && r.url.includes('/files/'),
        body: {},
      },
    ]);
    const pub = new NetlifyPublisher({
      fetch: fake.fetch,
      readArtifactFile: async (_dir, p) => Buffer.from(p === 'a.html' ? 'first' : 'second', 'utf8'),
    });
    const artifact: BuildArtifact = {
      buildId: 'b1',
      artifactDir: '/tmp/artifact',
      fileManifest: [
        { relPath: 'a.html', sha256: 'A', size: 5 },     // first → not required (missing from required[])
        { relPath: 'b.html', sha256: 'B', size: 6 },     // second → required
      ],
      dynamicEntrypoints: [],
      pageRoutes: [],
    };
    const result = await pub.deploy(artifact, SECRETS);
    expect(result.publicUrl).toBe('https://example.netlify.app');
    expect(result.deployId).toBe('dep-1');
    // 1 create + 1 upload (only b.html was required).
    expect(fake.calls).toHaveLength(2);
    const uploadCalls = fake.calls.filter((c) => c.method === 'PUT');
    expect(uploadCalls).toHaveLength(1);
    expect(uploadCalls[0]?.url).toContain('/files/b.html');
  });

  it('throws on invalid secrets without hitting the network', async () => {
    const fake = makeFakeFetch([]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    await expect(
      pub.deploy(
        { buildId: 'b', artifactDir: '/x', fileManifest: [], dynamicEntrypoints: [], pageRoutes: [] },
        { apiToken: 'short' },
      ),
    ).rejects.toThrow(/invalid_secrets/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('NetlifyPublisher.deployPreview()', () => {
  it('issues draft=true and returns a deploy_ssl_url', async () => {
    const fake = makeFakeFetch([
      {
        match: (r) => r.method === 'POST' && r.url.includes('/deploys') && !r.url.includes('/files'),
        body: {
          id: 'dep-x',
          site_id: SECRETS.siteId,
          state: 'uploading',
          name: 'example',
          url: 'http://x', ssl_url: 'https://x',
          admin_url: 'https://app.netlify.com/sites/example',
          deploy_url: 'http://dep-x--example.netlify.app',
          deploy_ssl_url: 'https://dep-x--example.netlify.app',
          required: [],
          created_at: '', updated_at: '',
        },
      },
    ]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.deployPreview(
      { buildId: 'b', artifactDir: '/x', fileManifest: [], dynamicEntrypoints: [], pageRoutes: [] },
      { id: 'page-1', fullPath: '/about' },
      SECRETS,
    );
    expect(r.previewUrl).toBe('https://dep-x--example.netlify.app/about');
    const createBody = fake.calls[0]?.body as { draft?: boolean };
    expect(createBody.draft).toBe(true);
  });
});

describe('NetlifyPublisher.getDeploymentStatus()', () => {
  it('maps state=ready → live + public_url', async () => {
    const fake = makeFakeFetch([{
      match: (r) => r.method === 'GET' && r.url.includes('/deploys/'),
      body: {
        id: 'dep-1', site_id: SECRETS.siteId, state: 'ready',
        name: 'example', url: 'http://example', ssl_url: 'https://example',
        admin_url: '', deploy_url: '', deploy_ssl_url: '',
        required: [], created_at: '', updated_at: '',
      },
    }]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.getDeploymentStatus('dep-1', SECRETS);
    expect(r.state).toBe('live');
    expect(r.public_url).toBe('https://example');
  });

  it('returns state=unknown on 404', async () => {
    const fake: { fetch: FetchLike } = {
      fetch: async () => { throw new Error('netlify_resource_not_found'); },
    };
    const pub = new NetlifyPublisher({ ...fake, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.getDeploymentStatus('missing', SECRETS);
    expect(r.state).toBe('unknown');
  });

  it('surfaces error_message in the result', async () => {
    const fake = makeFakeFetch([{
      match: (r) => r.method === 'GET' && r.url.includes('/deploys/'),
      body: {
        id: 'dep-1', site_id: SECRETS.siteId, state: 'error',
        name: 'example', url: '', ssl_url: '',
        admin_url: '', deploy_url: '', deploy_ssl_url: '',
        required: [], created_at: '', updated_at: '',
        error_message: 'build broke at step 4',
      },
    }]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.getDeploymentStatus('dep-1', SECRETS);
    expect(r.state).toBe('failed');
    expect(r.error).toBe('build broke at step 4');
  });
});

describe('NetlifyPublisher.addDomain() / getDomainStatus() / removeDomain()', () => {
  it('addDomain — sets custom_domain when none is set', async () => {
    const fake = makeFakeFetch([
      {
        match: (r) => r.method === 'GET' && r.url.endsWith(SECRETS.siteId as string),
        body: { name: 'example-prod', custom_domain: null, domain_aliases: [], ssl: null },
      },
      {
        match: (r) => r.method === 'PATCH' && r.url.endsWith(SECRETS.siteId as string),
        body: { ok: true },
      },
      {
        match: (r) => r.method === 'POST' && r.url.includes('/ssl'),
        body: { ok: true },
      },
    ]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.addDomain('example.com', SECRETS);
    expect(r.dnsInstructions).toHaveLength(1);
    expect(r.dnsInstructions[0]?.record_type).toBe('A');
    const patchBody = fake.calls[1]?.body as { custom_domain: string };
    expect(patchBody.custom_domain).toBe('example.com');
  });

  it('addDomain — appends to domain_aliases when custom_domain already set', async () => {
    const fake = makeFakeFetch([
      {
        match: (r) => r.method === 'GET',
        body: { name: 'example', custom_domain: 'example.com', domain_aliases: ['a.com'], ssl: null },
      },
      {
        match: (r) => r.method === 'PATCH',
        body: { ok: true },
      },
      {
        match: (r) => r.method === 'POST' && r.url.includes('/ssl'),
        body: { ok: true },
      },
    ]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    await pub.addDomain('b.com', SECRETS);
    const patchBody = fake.calls[1]?.body as { domain_aliases?: string[] };
    expect(patchBody.domain_aliases).toEqual(['a.com', 'b.com']);
  });

  it('getDomainStatus — pending_dns when domain is not attached', async () => {
    const fake = makeFakeFetch([{
      match: (r) => r.method === 'GET',
      body: { name: 'x', custom_domain: 'other.com', domain_aliases: [], ssl: null },
    }]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.getDomainStatus('example.com', SECRETS);
    expect(r.state).toBe('pending_dns');
  });

  it('getDomainStatus — verified when ssl.state is verified', async () => {
    const fake = makeFakeFetch([{
      match: (r) => r.method === 'GET',
      body: { name: 'x', custom_domain: 'example.com', domain_aliases: [], ssl: { state: 'verified' } },
    }]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    const r = await pub.getDomainStatus('example.com', SECRETS);
    expect(r.state).toBe('verified');
  });

  it('removeDomain — clears custom_domain when matched', async () => {
    const fake = makeFakeFetch([
      { match: (r) => r.method === 'GET',  body: { name: 'x', custom_domain: 'example.com', domain_aliases: [], ssl: null } },
      { match: (r) => r.method === 'PATCH', body: {} },
    ]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    await pub.removeDomain('example.com', SECRETS);
    const patchBody = fake.calls[1]?.body as { custom_domain: string | null };
    expect(patchBody.custom_domain).toBeNull();
  });

  it('removeDomain — drops entry from domain_aliases', async () => {
    const fake = makeFakeFetch([
      { match: (r) => r.method === 'GET', body: { name: 'x', custom_domain: 'a.com', domain_aliases: ['b.com', 'c.com'], ssl: null } },
      { match: (r) => r.method === 'PATCH', body: {} },
    ]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    await pub.removeDomain('b.com', SECRETS);
    const patchBody = fake.calls[1]?.body as { domain_aliases: string[] };
    expect(patchBody.domain_aliases).toEqual(['c.com']);
  });
});

describe('NetlifyPublisher.invalidateCache()', () => {
  it('triggers a build (Netlify lacks granular purge)', async () => {
    const fake = makeFakeFetch([{
      match: (r) => r.method === 'POST' && r.url.includes('/builds'),
      body: { id: 'build-1' },
    }]);
    const pub = new NetlifyPublisher({ fetch: fake.fetch, readArtifactFile: async () => new Uint8Array(0) });
    await pub.invalidateCache(SECRETS, ['/about', '/contact']);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.url).toContain('/builds');
  });
});
