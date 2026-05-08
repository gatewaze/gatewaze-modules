/**
 * Extract `<style>` and `<link rel="stylesheet">` content from a full
 * server-rendered HTML document so it can be re-injected into the Puck
 * iframe's body. Per spec-builder-evaluation §3.5.
 *
 * The legacy editor uses the rendered HTML as the iframe's srcdoc — the
 * theme styles ride along automatically because they're already in the
 * <head>. Puck owns the iframe and we can't replace its srcdoc, so we
 * extract the styles from a one-off render call and emit them via the
 * page-level `root.render` function (which Puck mounts once around the
 * block content tree).
 *
 * Pure function — runs both server-side (in tests) and in the browser.
 */

export interface ThemeCssExtraction {
  /** Concatenated CSS text from every <style> tag found in <head>. */
  inline: string;
  /** External stylesheet hrefs preserved in document order. */
  externalLinks: ReadonlyArray<string>;
}

const HEAD_BLOCK_RE = /<head[\s\S]*?<\/head>/i;
const STYLE_RE = /<style[^>]*>([\s\S]*?)<\/style>/gi;
// matches `<link ... rel="stylesheet" ...>` with attrs in either order
const LINK_RE = /<link\b[^>]*\brel\s*=\s*["']stylesheet["'][^>]*>/gi;
const HREF_RE = /\bhref\s*=\s*["']([^"']+)["']/i;

export function extractThemeCss(rawHtml: string): ThemeCssExtraction {
  const head = rawHtml.match(HEAD_BLOCK_RE)?.[0] ?? rawHtml;

  const inlineParts: string[] = [];
  for (const m of head.matchAll(STYLE_RE)) {
    inlineParts.push(m[1] ?? '');
  }

  const externalLinks: string[] = [];
  for (const m of head.matchAll(LINK_RE)) {
    const href = m[0].match(HREF_RE)?.[1];
    if (href) externalLinks.push(href);
  }

  return {
    inline: inlineParts.join('\n').trim(),
    externalLinks,
  };
}
