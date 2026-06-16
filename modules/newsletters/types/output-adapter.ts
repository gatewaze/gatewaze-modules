/**
 * Newsletter Output Adapter Interface
 *
 * Defines the contract that all output format modules must implement.
 * Output adapters transform a rendered newsletter edition into platform-specific
 * output (e.g., HTML email, Substack rich text, Beehiiv rich text).
 */

export interface OutputAdapterMeta {
  /** Unique adapter ID, e.g. 'html', 'substack', 'beehiiv' */
  id: string;
  /** Display name for UI tabs/dropdowns */
  label: string;
  /** Short description */
  description: string;
  /** Icon name for UI (Heroicons) */
  icon: string;
  /** Sort order for UI display */
  order: number;
}

export interface OutputRenderContext {
  edition: {
    id: string;
    edition_date: string;
    subject?: string;
    preheader?: string;
  };
  blocks: OutputBlock[];
  links: Map<string, string>; // original URL → short URL
  metadata: Record<string, unknown>;
  /**
   * Declarative wrapper template HTML for this newsletter's library
   * (latest is_current `templates_wrappers` row, key='default'). When
   * present, EditionEmail wraps the rendered body blocks inside the
   * wrapper's `<slot name="body" />`. Caller resolves it when building
   * the context (typically alongside the block fetch).
   */
  wrapperTemplate?: string | null;
}

export interface OutputBlock {
  id: string;
  block_type: string;
  content: Record<string, unknown>;
  sort_order: number;
  template: string; // The resolved template HTML for this adapter's variant
  has_bricks: boolean;
  bricks: OutputBrick[];
  /**
   * Per-block render path discriminator. Per spec-builder-evaluation
   * §3.6 (extended). Default 'mustache' for backwards compatibility:
   * adapters use the existing renderTemplate path.
   *
   * 'react-email' opts the block into JSX-component-based rendering via
   * the registry (resolved by `component_id`); the HTML adapter then
   * uses `@react-email/render` against the registry component instead
   * of running Mustache against the `template` string.
   */
  render_kind?: 'mustache' | 'react-email';
  /**
   * When render_kind='react-email', the registry key resolved server-
   * side via the email-blocks registry. Ignored otherwise.
   */
  component_id?: string;
}

export interface OutputBrick {
  id: string;
  brick_type: string;
  content: Record<string, unknown>;
  sort_order: number;
  template: string; // The resolved template HTML for this adapter's variant
}

export interface OutputRenderOptions {
  /**
   * When true, the rendered output includes <!-- BLOCK:type --> / <!-- /BLOCK:type -->
   * comment delimiters around each block (and similarly for bricks).
   * This allows the HTML to be exported, edited externally, and re-imported.
   * Only applicable for adapters where supportsBlockComments is true.
   * Default: false.
   */
  includeBlockComments?: boolean;
}

export interface INewsletterOutputAdapter {
  meta: OutputAdapterMeta;

  /**
   * Render the full newsletter output for this platform.
   * Returns the complete output string (HTML, rich text, markdown, etc.)
   */
  render(context: OutputRenderContext, options?: OutputRenderOptions): Promise<string>;

  /**
   * Which block types this adapter excludes (e.g., Substack excludes 'header', 'footer').
   * Core editor uses this to show/hide blocks in preview.
   */
  excludedBlockTypes: string[];

  /**
   * The template variant key this adapter uses to select templates.
   * Selects which column on templates_block_defs to read:
   *   - 'html_template' (default)        → templates_block_defs.html
   *   - 'rich_text_template' / 'substack' / 'beehiiv'
   *                                       → templates_block_defs.rich_text_template
   *
   * History: this used to map to the variant_key column on the legacy
   * newsletters_block_templates (one row per variant); since PR 16.b the
   * single templates_block_defs row holds both fields at once.
   */
  templateVariantKey: string;

  /**
   * Optional: transform links for this platform.
   * E.g., Substack may not need short links, or may need different UTM params.
   */
  transformLink?(originalUrl: string, shortUrl: string, channel: string): string;

  /**
   * Optional: post-process the final output (e.g., inline CSS for email).
   */
  postProcess?(html: string): Promise<string>;

  /**
   * Whether this adapter supports embedding block/brick comment delimiters
   * in the output (for round-trip editing by designers outside the admin UI).
   */
  supportsBlockComments?: boolean;
}
