/**
 * Public Google Docs / Slides URL → text-export URL rewriter.
 *
 * Per spec-canvas-ai-copilot.md §0000000a.
 *
 * Public Google Docs expose a /export endpoint that returns plain
 * text without auth. Private docs redirect to accounts.google.com,
 * which we surface as `document_not_public`.
 */

export function rewriteGoogleDocUrl(url: URL): URL | null {
  if (url.host !== 'docs.google.com') return null;

  // Document: /document/d/<id>/... → /document/d/<id>/export?format=txt
  const docMatch = url.pathname.match(/^\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (docMatch) {
    return new URL(`https://docs.google.com/document/d/${docMatch[1]}/export?format=txt`);
  }

  // Presentation: /presentation/d/<id>/... → /presentation/d/<id>/export/txt
  const slidesMatch = url.pathname.match(/^\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (slidesMatch) {
    return new URL(`https://docs.google.com/presentation/d/${slidesMatch[1]}/export/txt`);
  }

  // Sheets: not supported in v5 (spreadsheets need their own
  // schema/table awareness — deferred).
  return null;
}
