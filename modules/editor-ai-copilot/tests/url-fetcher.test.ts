import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { safeFetchUrl, UrlFetchError } from '../api/url-fetcher.js';

// Mock node:dns/promises so we can control resolution per-test.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import { lookup as dnsLookup } from 'node:dns/promises';

const mockedLookup = dnsLookup as unknown as ReturnType<typeof vi.fn>;

describe('safeFetchUrl — URL validation', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  it('rejects malformed URL', async () => {
    const r = await safeFetchUrl('not-a-url');
    expect(r).toBeInstanceOf(UrlFetchError);
    expect((r as UrlFetchError).code).toBe('document_url_blocked');
  });

  it('rejects http (non-https) scheme', async () => {
    mockedLookup.mockResolvedValue([{ address: '93.184.216.34' }]);
    const r = await safeFetchUrl('http://example.com/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
    expect((r as UrlFetchError).code).toBe('document_url_blocked');
  });

  it('rejects ftp scheme', async () => {
    const r = await safeFetchUrl('ftp://example.com/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
    expect((r as UrlFetchError).code).toBe('document_url_blocked');
  });

  it('rejects host that resolves to RFC1918 private IPv4 (10.0.0.0/8)', async () => {
    mockedLookup.mockResolvedValue([{ address: '10.0.0.5' }]);
    const r = await safeFetchUrl('https://internal.example/secret.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
    expect((r as UrlFetchError).message).toMatch(/private IP/);
  });

  it('rejects host that resolves to 192.168.0.0/16', async () => {
    mockedLookup.mockResolvedValue([{ address: '192.168.1.10' }]);
    const r = await safeFetchUrl('https://lan-only.example/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
  });

  it('rejects 172.16-31 range', async () => {
    mockedLookup.mockResolvedValue([{ address: '172.20.0.1' }]);
    const r = await safeFetchUrl('https://internal.example/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
  });

  it('rejects loopback 127.0.0.0/8', async () => {
    mockedLookup.mockResolvedValue([{ address: '127.0.0.1' }]);
    const r = await safeFetchUrl('https://localhost-like/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
  });

  it('rejects link-local 169.254.0.0/16 (cloud-metadata)', async () => {
    mockedLookup.mockResolvedValue([{ address: '169.254.169.254' }]);
    const r = await safeFetchUrl('https://metadata.example/iam');
    expect(r).toBeInstanceOf(UrlFetchError);
  });

  it('rejects IPv6 loopback ::1', async () => {
    mockedLookup.mockResolvedValue([{ address: '::1' }]);
    const r = await safeFetchUrl('https://v6-loopback.example/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
  });

  it('rejects IPv6 link-local fe80::/10', async () => {
    mockedLookup.mockResolvedValue([{ address: 'fe80::1' }]);
    const r = await safeFetchUrl('https://v6-ll.example/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
  });

  it('rejects IPv6 ULA fc00::/7', async () => {
    mockedLookup.mockResolvedValue([{ address: 'fd00::1' }]);
    const r = await safeFetchUrl('https://v6-ula.example/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
  });

  it('rejects IPv4-mapped IPv6 pointing at private space', async () => {
    mockedLookup.mockResolvedValue([{ address: '::ffff:10.0.0.5' }]);
    const r = await safeFetchUrl('https://mapped.example/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
  });

  it('rejects DNS lookup failure', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));
    const r = await safeFetchUrl('https://nope.invalid/doc.pdf');
    expect(r).toBeInstanceOf(UrlFetchError);
    expect((r as UrlFetchError).message).toMatch(/DNS lookup failed/);
  });
});

describe('safeFetchUrl — Google Doc rewrite is applied before validation', () => {
  beforeEach(() => {
    mockedLookup.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rewrites the URL before DNS validation runs', async () => {
    // DNS resolves to public IP so we get past validation, then we
    // intercept fetch to assert the URL is the rewritten /export?format=txt.
    mockedLookup.mockResolvedValue([{ address: '142.250.80.46' }]);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('plain doc text', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      }),
    );

    const r = await safeFetchUrl('https://docs.google.com/document/d/abc123/edit?usp=sharing');

    expect(r).not.toBeInstanceOf(UrlFetchError);
    expect(fetchSpy).toHaveBeenCalled();
    const calledUrl = fetchSpy.mock.calls[0]?.[0] as string;
    expect(calledUrl).toBe('https://docs.google.com/document/d/abc123/export?format=txt');
  });

  it('flags an HTML response from docs.google.com as document_not_public', async () => {
    mockedLookup.mockResolvedValue([{ address: '142.250.80.46' }]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<html>sign in</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const r = await safeFetchUrl('https://docs.google.com/document/d/abc123/edit');
    expect(r).toBeInstanceOf(UrlFetchError);
    expect((r as UrlFetchError).code).toBe('document_not_public');
  });
});
