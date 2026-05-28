/**
 * HTML → plain text via @mozilla/readability + cheerio fallback.
 *
 * Readability extracts the "article" content from boilerplate-heavy
 * pages. When readability fails (paywall pages, JS-heavy SPAs that
 * shipped no static content), cheerio + body-text fallback.
 *
 * No JS evaluation; static parsing only. SPAs that need rendering
 * route through scrapling-fetcher in Phase G (deferred).
 */

import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';

export function parseHtml(buf: Buffer, opts?: { sourceUrl?: string }): { ok: true; text: string; warnings: string[] } | { ok: false; reason: string } {
  const html = buf.toString('utf-8');
  try {
    // Try Readability first.
    const dom = new JSDOM(html, { url: opts?.sourceUrl ?? 'https://example.com' });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (article && article.textContent && article.textContent.trim().length > 100) {
      return { ok: true, text: article.textContent.trim(), warnings: [] };
    }
  } catch (err) {
    void err;
    // Fall through to cheerio.
  }

  try {
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe, svg, header, footer, nav, aside').remove();
    const text = $('body').text() || $.root().text();
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length < 50) {
      return { ok: false, reason: 'html_parse_no_text_content' };
    }
    return { ok: true, text: cleaned, warnings: ['readability_failed_used_cheerio_fallback'] };
  } catch (err) {
    return { ok: false, reason: `html_parse_failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
