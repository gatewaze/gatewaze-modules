/**
 * Newsletter type definitions
 *
 * Shared interfaces for newsletter editions, blocks, bricks, and templates.
 */

export type OutputFormat = 'html' | 'substack' | 'beehiiv';

export interface BlockTemplate {
  id: string;
  name: string;
  block_type: string;
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
  preheader?: string;
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
