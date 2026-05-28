import { describe, expect, it } from 'vitest';
import {
  createDeploymentRequest,
  getDeploymentRequest,
  uploadFileRequest,
  getSiteRequest,
  updateSiteDomainsRequest,
  provisionSslRequest,
  triggerBuildRequest,
  deploymentStatusFromState,
  dnsInstructionsForDomain,
} from '../requests.js';
import type { NetlifySecrets } from '../types.js';

const SECRETS: NetlifySecrets = {
  apiToken: 'nfp_' + 'x'.repeat(40),
  siteId: '12345678-1234-1234-1234-123456789012',
};

describe('createDeploymentRequest()', () => {
  it('posts files map at /sites/{id}/deploys', () => {
    const req = createDeploymentRequest({ secrets: SECRETS, files: { '/index.html': 'aaa' } });
    expect(req.method).toBe('POST');
    expect(req.url).toContain(`/sites/${SECRETS.siteId}/deploys`);
    const body = req.body as { files: Record<string, string>; draft?: boolean };
    expect(body.files['/index.html']).toBe('aaa');
    expect(body.draft).toBeUndefined();
  });

  it('honors draft=true', () => {
    const req = createDeploymentRequest({ secrets: SECRETS, files: {}, draft: true });
    const body = req.body as { draft: boolean };
    expect(body.draft).toBe(true);
  });
});

describe('uploadFileRequest()', () => {
  it('PUTs to /deploys/{deployId}/files/<path>', () => {
    const req = uploadFileRequest({
      secrets: SECRETS, deployId: 'dep-1', relPath: 'index.html', bytes: new Uint8Array([1, 2]),
    });
    expect(req.method).toBe('PUT');
    expect(req.url).toContain('/deploys/dep-1/files/index.html');
    expect(req.headers['content-type']).toBe('application/octet-stream');
  });

  it('encodes path segments but preserves slashes', () => {
    const req = uploadFileRequest({
      secrets: SECRETS, deployId: 'dep-1',
      relPath: 'a folder/with space.html', bytes: new Uint8Array(0),
    });
    expect(req.url).toContain('/files/a%20folder/with%20space.html');
  });
});

describe('getSiteRequest() / updateSiteDomainsRequest() / provisionSslRequest() / triggerBuildRequest()', () => {
  it('GET /sites/{id}', () => {
    const req = getSiteRequest({ secrets: SECRETS });
    expect(req.method).toBe('GET');
    expect(req.url).toContain(`/sites/${SECRETS.siteId}`);
  });

  it('PATCH custom_domain only', () => {
    const req = updateSiteDomainsRequest({ secrets: SECRETS, custom_domain: 'foo.com' });
    expect(req.method).toBe('PATCH');
    const body = req.body as Record<string, unknown>;
    expect(body['custom_domain']).toBe('foo.com');
    expect(body['domain_aliases']).toBeUndefined();
  });

  it('PATCH null custom_domain to detach', () => {
    const req = updateSiteDomainsRequest({ secrets: SECRETS, custom_domain: null });
    const body = req.body as Record<string, unknown>;
    expect(body['custom_domain']).toBeNull();
  });

  it('PATCH domain_aliases array', () => {
    const req = updateSiteDomainsRequest({ secrets: SECRETS, domain_aliases: ['a.com', 'b.com'] });
    const body = req.body as { domain_aliases: string[] };
    expect(body.domain_aliases).toEqual(['a.com', 'b.com']);
  });

  it('POST /sites/{id}/ssl provisions SSL', () => {
    const req = provisionSslRequest({ secrets: SECRETS });
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/ssl');
  });

  it('POST /sites/{id}/builds triggers a no-op build', () => {
    const req = triggerBuildRequest({ secrets: SECRETS });
    expect(req.method).toBe('POST');
    expect(req.url).toContain('/builds');
  });
});

describe('deploymentStatusFromState()', () => {
  it('maps ready → live', () => expect(deploymentStatusFromState('ready')).toBe('live'));
  it('maps error → failed', () => expect(deploymentStatusFromState('error')).toBe('failed'));
  it('maps rejected → failed', () => expect(deploymentStatusFromState('rejected')).toBe('failed'));
  it('maps in-flight states → building', () => {
    for (const s of ['enqueued', 'building', 'uploading', 'uploaded', 'preparing', 'prepared', 'processing', 'new', 'pending_review']) {
      expect(deploymentStatusFromState(s)).toBe('building');
    }
  });
  it('maps unknown states → unknown', () => expect(deploymentStatusFromState('something_new')).toBe('unknown'));
});

describe('dnsInstructionsForDomain()', () => {
  it('emits A record for an apex domain', () => {
    const dns = dnsInstructionsForDomain({ secrets: SECRETS, domain: 'example.com', siteName: 'example-prod' });
    expect(dns).toHaveLength(1);
    expect(dns[0]?.record_type).toBe('A');
  });

  it('emits CNAME for a subdomain to <site>.netlify.app', () => {
    const dns = dnsInstructionsForDomain({ secrets: SECRETS, domain: 'www.example.com', siteName: 'example-prod' });
    expect(dns).toHaveLength(1);
    expect(dns[0]?.record_type).toBe('CNAME');
    expect(dns[0]?.value).toBe('example-prod.netlify.app');
  });
});
