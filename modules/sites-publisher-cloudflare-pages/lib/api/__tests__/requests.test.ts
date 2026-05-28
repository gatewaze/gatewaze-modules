import { describe, expect, it } from 'vitest';
import {
  createDeploymentRequest,
  getDeploymentRequest,
  uploadFileRequest,
  addDomainRequest,
  getDomainRequest,
  deleteDomainRequest,
  purgeCacheRequest,
  unwrapEnvelope,
  deploymentStatusFromResponse,
  dnsInstructionsForDomain,
} from '../requests.js';
import type { CloudflareSecrets, PagesDeployment } from '../types.js';

const SECRETS: CloudflareSecrets = {
  apiToken: 'cf-token-' + 'x'.repeat(40),
  accountId: 'a'.repeat(32),
  projectName: 'example-site',
  zoneId: 'b'.repeat(32),
};

describe('createDeploymentRequest()', () => {
  it('targets the project deployments endpoint', () => {
    const req = createDeploymentRequest({
      secrets: SECRETS,
      branch: 'main',
      manifest: [{ relPath: 'index.html', sha256: 'aaa', size: 100 }],
    });
    expect(req.method).toBe('POST');
    expect(req.url).toContain(`/accounts/${SECRETS.accountId}/pages/projects/${SECRETS.projectName}/deployments`);
    expect(req.headers['authorization']).toBe(`Bearer ${SECRETS.apiToken}`);
    const body = req.body as { manifest: Record<string, { hash: string; size: number }>; branch: string };
    expect(body.branch).toBe('main');
    expect(body.manifest['/index.html']).toEqual({ hash: 'aaa', size: 100 });
  });

  it('prefixes manifest keys with /', () => {
    const req = createDeploymentRequest({
      secrets: SECRETS, branch: 'main',
      manifest: [{ relPath: 'foo/bar.css', sha256: 'b', size: 1 }],
    });
    const body = req.body as { manifest: Record<string, unknown> };
    expect(body.manifest['/foo/bar.css']).toBeDefined();
    expect(body.manifest['foo/bar.css']).toBeUndefined();
  });
});

describe('getDeploymentRequest()', () => {
  it('uses GET on the deployments/<id> endpoint', () => {
    const req = getDeploymentRequest({ secrets: SECRETS, deploymentId: 'dep-123' });
    expect(req.method).toBe('GET');
    expect(req.url).toContain('/deployments/dep-123');
    expect(req.body).toBeNull();
  });
});

describe('uploadFileRequest()', () => {
  it('sets x-relpath header and the JWT bearer', () => {
    const req = uploadFileRequest({
      secrets: SECRETS, jwt: 'jwt-x', relPath: 'index.html',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'text/html',
    });
    expect(req.method).toBe('POST');
    expect(req.headers['authorization']).toBe('Bearer jwt-x');
    expect(req.headers['content-type']).toBe('text/html');
    expect(req.headers['x-relpath']).toBe('index.html');
  });

  it('defaults content-type to application/octet-stream', () => {
    const req = uploadFileRequest({
      secrets: SECRETS, jwt: 'j', relPath: 'x', bytes: new Uint8Array(0),
    });
    expect(req.headers['content-type']).toBe('application/octet-stream');
  });
});

describe('addDomainRequest() / getDomainRequest() / deleteDomainRequest()', () => {
  it('add posts the domain name', () => {
    const req = addDomainRequest({ secrets: SECRETS, domain: 'foo.example.com' });
    expect(req.method).toBe('POST');
    const body = req.body as { name: string };
    expect(body.name).toBe('foo.example.com');
  });

  it('get URL-encodes the domain', () => {
    const req = getDomainRequest({ secrets: SECRETS, domain: 'sub.example.com' });
    expect(req.method).toBe('GET');
    expect(req.url).toContain('/domains/sub.example.com');
  });

  it('delete uses DELETE verb', () => {
    const req = deleteDomainRequest({ secrets: SECRETS, domain: 'x.com' });
    expect(req.method).toBe('DELETE');
  });
});

describe('purgeCacheRequest()', () => {
  it('targets the zone purge_cache endpoint and caps at 30 paths', () => {
    const paths = Array.from({ length: 50 }, (_, i) => `https://x/${i}`);
    const req = purgeCacheRequest({ secrets: SECRETS, paths });
    expect(req.url).toContain(`/zones/${SECRETS.zoneId}/purge_cache`);
    const body = req.body as { files: string[] };
    expect(body.files).toHaveLength(30);
  });

  it('throws if zoneId is missing', () => {
    const noZone = { ...SECRETS, zoneId: undefined };
    expect(() => purgeCacheRequest({ secrets: noZone, paths: ['x'] })).toThrow(/zoneId required/);
  });
});

describe('unwrapEnvelope()', () => {
  it('returns result on success', () => {
    expect(
      unwrapEnvelope<{ ok: true }>({ success: true, errors: [], messages: [], result: { ok: true } }),
    ).toEqual({ ok: true });
  });

  it('throws on success=false with concatenated error messages', () => {
    expect(() =>
      unwrapEnvelope({
        success: false,
        errors: [{ code: 1, message: 'bad token' }, { code: 2, message: 'no project' }],
        messages: [],
        result: null,
      }),
    ).toThrow(/bad token; no project/);
  });

  it('throws on a non-object response', () => {
    expect(() => unwrapEnvelope('not an envelope')).toThrow(/unexpected_response/);
  });
});

describe('deploymentStatusFromResponse()', () => {
  const mk = (status: string): PagesDeployment => ({
    id: 'd', url: 'u', environment: 'production', created_on: '', short_id: 's',
    project_id: 'p', project_name: 'pn',
    deployment_trigger: { type: 'ad_hoc' },
    latest_stage: { name: 'deploy', status, ended_on: null },
  });

  it('maps success → live', () => expect(deploymentStatusFromResponse(mk('success'))).toBe('live'));
  it('maps failure → failed', () => expect(deploymentStatusFromResponse(mk('failure'))).toBe('failed'));
  it('maps active/idle/queued → building', () => {
    expect(deploymentStatusFromResponse(mk('active'))).toBe('building');
    expect(deploymentStatusFromResponse(mk('idle'))).toBe('building');
    expect(deploymentStatusFromResponse(mk('queued'))).toBe('building');
  });
  it('maps canceled → failed', () => expect(deploymentStatusFromResponse(mk('canceled'))).toBe('failed'));
  it('maps unknown statuses → unknown', () => expect(deploymentStatusFromResponse(mk('whatever'))).toBe('unknown'));
});

describe('dnsInstructionsForDomain()', () => {
  it('emits A + AAAA for an apex domain', () => {
    const dns = dnsInstructionsForDomain({ secrets: SECRETS, domain: 'example.com', domainResponse: null });
    const types = dns.map((d) => d.record_type).sort();
    expect(types).toEqual(['A', 'AAAA']);
  });

  it('emits a CNAME for a subdomain', () => {
    const dns = dnsInstructionsForDomain({ secrets: SECRETS, domain: 'www.example.com', domainResponse: null });
    expect(dns).toHaveLength(1);
    expect(dns[0]?.record_type).toBe('CNAME');
    expect(dns[0]?.value).toBe(`${SECRETS.projectName}.pages.dev`);
  });
});
