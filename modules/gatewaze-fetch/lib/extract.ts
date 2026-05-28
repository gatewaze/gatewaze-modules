/**
 * HTML → markdown / metadata / json_ld / links / next_data extraction
 * (spec §10.2).
 *
 * v1: extraction runs in-process with a 2-second wall-clock guard via
 *   Promise.race + AbortController. The spec calls for worker-thread
 *   termination as the canonical timeout enforcement; we expose the
 *   single-process variant here for simplicity and document the worker
 *   thread upgrade path in the module's README. The worker upgrade is
 *   a Phase 3 hardening item.
 *
 * Input HTML is hard-capped at 10 MiB BEFORE dispatch (cheap host-side
 * guard against pathological pages).
 */

import type { ExtractKind, WarningEntry } from './types.js';

export interface ExtractInput {
  html: string;
  url: string;
  upstream_next_data: unknown | null;
  kinds: ExtractKind[];
}

export interface ExtractOutput {
  html?: string;
  markdown?: string | null;
  markdown_truncated?: boolean;
  html_truncated?: boolean;
  metadata?: Metadata | null;
  links?: { href: string; text: string; rel: string | null }[] | null;
  json_ld?: unknown[] | null;
  next_data?: unknown | null;
  warnings: WarningEntry[];
  timed_out: boolean; // true if any kind timed out
}

export interface Metadata {
  title?: string | null;
  description?: string | null;
  canonical?: string | null;
  lang?: string | null;
  og?: Record<string, string> | null;
}

const INPUT_BYTE_CAP = 10 * 1024 * 1024;
const TIMEOUT_MS = 2_000;

export async function runExtraction(
  input: ExtractInput,
): Promise<ExtractOutput> {
  const out: ExtractOutput = { warnings: [], timed_out: false };

  const inputBytes = Buffer.byteLength(input.html, 'utf-8');
  if (inputBytes > INPUT_BYTE_CAP) {
    out.warnings.push({
      code: 'EXTRACTION_SKIPPED',
      reason: 'input_above_cap',
      input_bytes: inputBytes,
    });
    return out;
  }

  // We pass through `next_data` from the upstream service (it ran the
  // regex server-side per scrapling-fetcher §5.1). Always cheap — no
  // timeout needed.
  if (input.kinds.includes('next_data')) {
    out.next_data = input.upstream_next_data;
  }

  // html is a passthrough — no parser invocation.
  if (input.kinds.includes('html')) {
    out.html = input.html;
  }

  // Parser-based kinds run with a wall-clock timeout.
  const parserKinds: ExtractKind[] = ['markdown', 'metadata', 'links', 'json_ld'];
  const requested = parserKinds.filter(k => input.kinds.includes(k));
  if (requested.length === 0) return out;

  // linkedom's parseHTML() returns a window-shaped object; we narrow
  // to the `document` field at runtime. The document satisfies the
  // DomNode shape we declared below (querySelector/All), so we type
  // it as DomNode for downstream helpers.
  let dom: DomNode | null = null;
  try {
    dom = await withTimeout(parseDom(input.html), TIMEOUT_MS, 'dom_parse');
  } catch (e) {
    if ((e as Error).message === 'timeout') {
      out.timed_out = true;
      out.warnings.push({ code: 'EXTRACTION_TIMEOUT', kind: 'dom_parse' });
      return out;
    }
    out.warnings.push({ code: 'EXTRACTION_ERROR', detail: (e as Error).message });
    return out;
  }

  if (!dom) return out;

  for (const kind of requested) {
    try {
      switch (kind) {
        case 'markdown': {
          const md = await withTimeout(
            extractMarkdown(input.html, input.url),
            TIMEOUT_MS,
            'markdown',
          );
          out.markdown = md;
          break;
        }
        case 'metadata':
          out.metadata = extractMetadata(dom);
          break;
        case 'links':
          out.links = extractLinks(dom).slice(0, 1000);
          break;
        case 'json_ld':
          out.json_ld = extractJsonLd(dom).slice(0, 50);
          break;
      }
    } catch (e) {
      if ((e as Error).message === 'timeout') {
        out.timed_out = true;
        out.warnings.push({ code: 'EXTRACTION_TIMEOUT', kind });
      } else {
        out.warnings.push({
          code: 'EXTRACTION_ERROR',
          kind,
          detail: (e as Error).message,
        });
      }
    }
  }

  return out;
}

async function withTimeout<T>(p: Promise<T>, ms: number, kind: string): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Minimal DOM-node shape we rely on. Both linkedom and jsdom return
// nodes that satisfy this — we keep the surface narrow so we don't
// depend on a specific DOM library's full type surface.
interface DomNode {
  textContent: string | null;
  getAttribute: (name: string) => string | null;
  querySelector: (sel: string) => DomNode | null;
  querySelectorAll: (sel: string) => Iterable<DomNode>;
}

async function parseDom(html: string): Promise<DomNode> {
  const { parseHTML } = await import('linkedom');
  // linkedom's parseHTML returns { window, document, ... } at runtime;
  // its exported types narrow `document` to a Document. We cast to our
  // minimal DomNode shape because we only use querySelector/All +
  // documentElement (which the document object provides at runtime).
  const win = parseHTML(html) as unknown as { document: DomNode };
  return win.document;
}

async function extractMarkdown(html: string, url: string): Promise<string | null> {
  // mozilla-readability for boilerplate stripping → turndown for
  // HTML→MD. Readability needs a window/document; we use jsdom when
  // available, otherwise feed the raw HTML to turndown directly.
  const Readability = await tryImportReadability();
  const JSDOM = await tryImportJsdom();
  const { default: TurndownService } = await import('turndown');
  if (!Readability || !JSDOM) {
    // Fall back to direct turndown on the raw HTML.
    return new TurndownService().turndown(html);
  }
  const dom = new JSDOM(html, { url }) as unknown as { window: { document: unknown } };
  const reader = new Readability(dom.window.document as never);
  const article = reader.parse() as { content?: string } | null;
  const cleanedHtml = article?.content ?? html;
  return new TurndownService().turndown(cleanedHtml);
}

// Both readability and jsdom are optional — if not installed at
// deployment, markdown extraction degrades gracefully.
async function tryImportReadability(): Promise<{ new (doc: unknown): { parse: () => unknown } } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import('@mozilla/readability');
    return mod.Readability ?? null;
  } catch {
    return null;
  }
}

async function tryImportJsdom(): Promise<{ new (html: string, opts: { url: string }): unknown } | null> {
  try {
    // jsdom is an optional runtime dep — when not installed, markdown
    // extraction falls back to feeding raw HTML into turndown. We use
    // a string-built specifier so TS doesn't statically resolve the
    // module; the import either succeeds (jsdom present) or throws
    // (caught here).
    const specifier = ['j', 's', 'dom'].join('');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ specifier);
    return mod.JSDOM ?? null;
  } catch {
    return null;
  }
}

function extractMetadata(doc: DomNode): Metadata {
  const meta = (name: string): string | null => {
    const el = doc.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
    return el?.getAttribute('content') ?? null;
  };
  const og: Record<string, string> = {};
  for (const el of doc.querySelectorAll('meta[property^="og:"]')) {
    const property = el.getAttribute('property')?.slice(3);
    const content = el.getAttribute('content');
    if (property && content) og[property] = content;
  }
  const docEl = (doc as { documentElement?: DomNode | null }).documentElement ?? null;
  return {
    title: doc.querySelector('title')?.textContent ?? null,
    description: meta('description'),
    canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? null,
    lang: docEl?.getAttribute('lang') ?? null,
    og: Object.keys(og).length > 0 ? og : null,
  };
}

function extractLinks(doc: DomNode): { href: string; text: string; rel: string | null }[] {
  const out: { href: string; text: string; rel: string | null }[] = [];
  for (const el of doc.querySelectorAll('a[href]')) {
    const href = el.getAttribute('href');
    if (!href) continue;
    out.push({
      href,
      text: (el.textContent ?? '').trim().slice(0, 256),
      rel: el.getAttribute('rel'),
    });
  }
  return out;
}

function extractJsonLd(doc: DomNode): unknown[] {
  const out: unknown[] = [];
  for (const el of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const text = el.textContent ?? '';
    if (!text.trim()) continue;
    try {
      out.push(JSON.parse(text));
    } catch {
      // Malformed block — skip; don't kill the others.
    }
  }
  return out;
}
