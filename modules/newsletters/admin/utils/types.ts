/**
 * Newsletter type definitions
 *
 * Shared interfaces for newsletter editions, blocks, bricks, and templates.
 */

export type OutputFormat = 'html' | 'substack' | 'beehiiv';

/**
 * The research binding a block def declares in its DATA_SOURCE marker
 * (spec-content-discovery-and-research-blocks.md §5.1). Mirrors
 * `BlockDefDataSourceResearch` in modules/templates/types; kept structural
 * here so the editor's types don't import the templates module.
 */
export interface ResearchBinding {
  kind: 'research';
  input: { kind: 'discovery_posts'; [k: string]: unknown } | { kind: 'recipe'; use_case: string; [k: string]: unknown };
  transform?: { kind: 'template'; group_by?: string; max_items?: number; max_per_group?: number; [k: string]: unknown }
    | { kind: 'recipe'; use_case: string; [k: string]: unknown };
  output: { field: string; format?: 'array' | 'richtext' | 'text' };
  schedule?: 'edition' | 'daily' | 'manual';
}

export interface BlockTemplate {
  id: string;
  name: string;
  block_type: string;
  /**
   * How this block renders: 'mustache' (legacy html template), 'react-email'
   * (a hand-coded registry component, componentId === block_type), or
   * 'declarative' (an html-ish source in `content.html_template` interpreted
   * into react-email by the declarative engine).
   */
  render_kind?: 'mustache' | 'react-email' | 'declarative';
  component_id?: string | null;
  /** templates_block_defs.source_kind; 'research' means `data_source` is a ResearchBinding. */
  source_kind?: string | null;
  /** templates_block_defs.data_source, as stored. Only read when source_kind === 'research'. */
  data_source?: unknown;
  /**
   * sha1 of the canonical JSON of `data_source`, computed once when the block
   * def is loaded (lib/research-merge bindingHash). The edit layer records
   * the hash it was made against; a mismatch sets the edits aside.
   */
  binding_hash?: string;
  content: {
    html_template: string;
    rich_text_template?: string | null;
    has_bricks?: boolean;
    schema?: Record<string, unknown>;
  };
}

export interface BrickTemplate {
  id: string;
  name: string;
  brick_type: string;
  content: {
    html_template: string;
    rich_text_template?: string | null;
    schema?: Record<string, unknown>;
  };
}

export interface EditionBlock {
  id: string;
  block_template: BlockTemplate;
  content: Record<string, unknown>;
  sort_order: number;
  bricks: EditionBrick[];
}

export interface EditionBrick {
  id: string;
  brick_template: BrickTemplate;
  content: Record<string, unknown>;
  sort_order: number;
}

export interface NewsletterEdition {
  id: string;
  edition_date: string;
  subject?: string;
  title?: string;
  preheader?: string;
  status?: string;
  /** When the edition is meant to go out (newsletters_editions.send_target_at, ISO). */
  send_target_at?: string | null;
  /** Pinned research time (ISO). null/undefined = derived from send_target_at (spec §5.3). */
  research_at?: string | null;
  blocks: EditionBlock[];
}

/**
 * Format date for display in newsletter
 */
export function formatNewsletterDate(date: string | Date): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}
