import { describe, expect, it } from 'vitest';
import { rewriteGoogleDocUrl } from '../api/google-docs-rewriter.js';

describe('rewriteGoogleDocUrl', () => {
  it('rewrites a public Google Doc /edit URL to /export?format=txt', () => {
    const out = rewriteGoogleDocUrl(
      new URL('https://docs.google.com/document/d/1AbC_DeFg123/edit?usp=sharing'),
    );
    expect(out?.toString()).toBe(
      'https://docs.google.com/document/d/1AbC_DeFg123/export?format=txt',
    );
  });

  it('rewrites a Slides URL to /export/txt', () => {
    const out = rewriteGoogleDocUrl(
      new URL('https://docs.google.com/presentation/d/abc123XYZ/edit'),
    );
    expect(out?.toString()).toBe(
      'https://docs.google.com/presentation/d/abc123XYZ/export/txt',
    );
  });

  it('returns null for non-docs.google.com hosts', () => {
    expect(rewriteGoogleDocUrl(new URL('https://example.com/document/d/abc/edit'))).toBeNull();
  });

  it('returns null for Sheets (not yet supported)', () => {
    expect(
      rewriteGoogleDocUrl(new URL('https://docs.google.com/spreadsheets/d/abc/edit')),
    ).toBeNull();
  });

  it('returns null for unknown Google docs paths', () => {
    expect(rewriteGoogleDocUrl(new URL('https://docs.google.com/'))).toBeNull();
  });
});
