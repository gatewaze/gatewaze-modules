/**
 * computed block kind — derives content from other blocks on the same page.
 *
 * Per spec-content-modules-git-architecture §9.2:
 *   build-time deterministic; reads from the assembled block list and
 *   produces content that gets baked into the published HTML.
 *
 * Theme author declares blocks like:
 *
 *   /* @gatewaze:block kind="computed" name="TableOfContents"
 *      inputs="rich-text,heading" *​/
 *   export function TableOfContents(props: TocProps) { ... }
 *
 * The computeBlockContent() function dispatches by block-def name to
 * a known set of computed-block algorithms (toc, reading-time, related,
 * tag-list). Theme authors using "custom" computed blocks fall through
 * to a no-op (block content stays empty until the theme component
 * provides its own implementation).
 */

export interface ComputedBlockInput {
  /** Block-def name of the input source. */
  block_def_name: string;
  /** Resolved content of the input block instance. */
  content: Record<string, unknown>;
  sort_order: number;
}

export interface ComputeContext {
  /** Other blocks on the page that this computed block reads from. */
  inputs: ComputedBlockInput[];
  /** Optional per-instance config from page_blocks.kind_config. */
  kindConfig?: Record<string, unknown>;
}

export type ComputedBlockAlgorithm = (ctx: ComputeContext) => Record<string, unknown>;

const ALGORITHMS = new Map<string, ComputedBlockAlgorithm>();

/**
 * Register a computed-block algorithm by block_def_name. Theme authors
 * can register custom algorithms at platform-init.
 */
export function registerComputedAlgorithm(blockDefName: string, fn: ComputedBlockAlgorithm): void {
  ALGORITHMS.set(blockDefName, fn);
}

/**
 * Dispatch + run the computed-block algorithm for a block-def. Returns
 * the computed content (which becomes page_blocks.content for the
 * computed block instance). Returns empty object when no algorithm
 * registered for this block name.
 */
export function computeBlockContent(blockDefName: string, ctx: ComputeContext): Record<string, unknown> {
  const fn = ALGORITHMS.get(blockDefName);
  if (!fn) {
    return {};
  }
  return fn(ctx);
}

// ===========================================================================
// Built-in algorithms
// ===========================================================================

/**
 * table-of-contents: extracts headings from text/markdown blocks on the
 * page; produces a nested list of { level, text, id } items for the
 * theme's TOC component to render as anchor links.
 */
const tableOfContents: ComputedBlockAlgorithm = (ctx) => {
  const items: Array<{ level: number; text: string; id: string }> = [];
  for (const input of ctx.inputs) {
    // Look for explicit heading blocks first
    if (input.block_def_name === 'heading' || input.block_def_name === 'Heading') {
      const text = String(input.content.text ?? input.content.heading ?? '');
      const level = Number(input.content.level ?? 2);
      if (text) items.push({ level, text, id: slugifyHeading(text) });
      continue;
    }
    // Look inside rich-text bodies for h2/h3/h4 markdown
    if (input.block_def_name === 'rich-text' || input.block_def_name === 'RichText') {
      const body = String(input.content.body ?? '');
      // Markdown headings
      for (const m of body.matchAll(/^(#{2,4})\s+(.+)$/gm)) {
        const level = m[1]!.length;
        const text = m[2]!.trim();
        items.push({ level, text, id: slugifyHeading(text) });
      }
      // HTML headings
      for (const m of body.matchAll(/<h([2-4])[^>]*>(.*?)<\/h\1>/gi)) {
        const level = parseInt(m[1]!, 10);
        const text = stripHtmlTags(m[2]!).trim();
        if (text) items.push({ level, text, id: slugifyHeading(text) });
      }
    }
  }
  return { items };
};

/**
 * estimated-reading-time: counts words across all rich-text + heading
 * blocks on the page; returns minutes (assuming ~225 wpm average).
 */
const estimatedReadingTime: ComputedBlockAlgorithm = (ctx) => {
  let totalWords = 0;
  for (const input of ctx.inputs) {
    if (input.block_def_name === 'heading' || input.block_def_name === 'Heading') {
      totalWords += countWords(String(input.content.text ?? input.content.heading ?? ''));
    }
    if (input.block_def_name === 'rich-text' || input.block_def_name === 'RichText') {
      const stripped = stripHtmlTags(String(input.content.body ?? ''));
      totalWords += countWords(stripped);
    }
  }
  const wpm = Number(ctx.kindConfig?.wpm ?? 225);
  const minutes = Math.max(1, Math.round(totalWords / wpm));
  return {
    word_count: totalWords,
    minutes,
    label: minutes === 1 ? '1 min read' : `${minutes} min read`,
  };
};

/**
 * tag-list: aggregates `tags` arrays declared on each block's content.
 * Useful for "tags on this page" footer summaries.
 */
const tagList: ComputedBlockAlgorithm = (ctx) => {
  const seen = new Set<string>();
  for (const input of ctx.inputs) {
    const tags = input.content.tags;
    if (Array.isArray(tags)) {
      for (const t of tags) {
        if (typeof t === 'string') seen.add(t);
      }
    }
  }
  return { tags: [...seen].sort() };
};

// Register built-ins under both kebab + Pascal naming for flexibility
registerComputedAlgorithm('table-of-contents', tableOfContents);
registerComputedAlgorithm('TableOfContents', tableOfContents);
registerComputedAlgorithm('estimated-reading-time', estimatedReadingTime);
registerComputedAlgorithm('EstimatedReadingTime', estimatedReadingTime);
registerComputedAlgorithm('reading-time', estimatedReadingTime);
registerComputedAlgorithm('tag-list', tagList);
registerComputedAlgorithm('TagList', tagList);

// ===========================================================================
// Helpers
// ===========================================================================

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  return trimmed.split(/\s+/).length;
}
