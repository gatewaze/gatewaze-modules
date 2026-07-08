/**
 * Page-level wrapper config for a newsletter edition — the outer
 * `<Container>` padding and max width that frame all blocks.
 *
 * This is the platform (Barebone-derived) boilerplate's page shell: the
 * SINGLE source of truth read by BOTH the rendered email (`EditionEmail`'s
 * `<Container>`) AND the editor canvas (`.gw-email-card`), so the preview
 * matches the sent email with no drift.
 *
 * Per-template override: a template collection can store
 * `metadata.page = { padding, maxWidth }` (or the flat
 * `metadata.page_padding` / `metadata.page_max_width`) to override the
 * boilerplate default. `resolvePageConfig` reads that and falls back to
 * PAGE_DEFAULTS when unset.
 */

export interface PageConfig {
  /** CSS padding for the outer container, e.g. "20px" or "20px 40px". */
  padding: string;
  /** Max content width in px. */
  maxWidth: number;
}

/** Barebone boilerplate page defaults. */
export const PAGE_DEFAULTS: PageConfig = {
  padding: '20px',
  maxWidth: 600,
};

/**
 * Resolve the effective page config from a template collection's
 * `metadata`, falling back to the boilerplate defaults.
 */
export function resolvePageConfig(metadata?: Record<string, unknown> | null): PageConfig {
  const page = (metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).page : undefined) as
    | Record<string, unknown>
    | undefined;

  const paddingRaw =
    (page && typeof page.padding === 'string' && page.padding.trim() !== '' ? page.padding : undefined) ??
    (metadata && typeof (metadata as Record<string, unknown>).page_padding === 'string'
      ? ((metadata as Record<string, unknown>).page_padding as string)
      : undefined);

  const maxWidthRaw =
    (page ? page.maxWidth : undefined) ?? (metadata ? (metadata as Record<string, unknown>).page_max_width : undefined);

  const padding =
    typeof paddingRaw === 'string' && paddingRaw.trim() !== '' ? paddingRaw : PAGE_DEFAULTS.padding;

  let maxWidth = PAGE_DEFAULTS.maxWidth;
  if (typeof maxWidthRaw === 'number' && Number.isFinite(maxWidthRaw) && maxWidthRaw > 0) {
    maxWidth = maxWidthRaw;
  } else if (typeof maxWidthRaw === 'string' && maxWidthRaw.trim() !== '' && Number.isFinite(Number(maxWidthRaw))) {
    maxWidth = Number(maxWidthRaw);
  }

  return { padding, maxWidth };
}
