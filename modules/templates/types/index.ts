/**
 * Templates module — public types
 *
 * Consumers import shapes from `@gatewaze-modules/templates/types`.
 * Row shapes mirror the SQL column types from migrations 001–005.
 */

// ----------------------------------------------------------------------------
// Library / definition rows
// ----------------------------------------------------------------------------

export type TemplatesLibraryHostKind =
  | 'newsletter'
  | 'site'
  | 'event'
  | 'calendar'
  | 'system'
  | (string & { readonly __brand?: 'host_kind' });

/**
 * Discriminator added by spec-sites-theme-kinds annex. Flows from source →
 * library → block_def. Immutable after insert. Defaults to 'email'.
 *
 * - 'email'   → marker-grammar-parsed HTML templates; consumed by newsletters,
 *               events, calendars, and any other email-shaped output.
 * - 'website' → schema-driven content authoring + git-driven publishing;
 *               consumed by sites (templates_content_schemas instead of
 *               block_defs).
 *
 * Renamed from 'html' / 'nextjs' in templates_013_rename_theme_kinds.
 */
export type ThemeKind = 'email' | 'website';

export interface TemplatesLibraryRow {
  id: string;
  host_kind: TemplatesLibraryHostKind;
  host_id: string | null;
  name: string;
  description: string | null;
  theme_kind: ThemeKind;
  created_at: string;
  updated_at: string;
}

export type BlockDefSourceKind = 'static' | 'external-api' | 'internal-content';

export interface BlockDefDataSourceHttp {
  adapter: 'http';
  method?: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  jsonpath?: string;
  cacheTtlSeconds?: number;
}

export interface BlockDefDataSourceAdapter {
  adapter: string;
  operation: string;
  params?: Record<string, unknown>;
  cacheTtlSeconds?: number;
}

export type BlockDefDataSource = BlockDefDataSourceHttp | BlockDefDataSourceAdapter;

export interface TemplatesBlockDefRow {
  id: string;
  library_id: string;
  key: string;
  name: string;
  description: string | null;
  source_kind: BlockDefSourceKind;
  schema: Record<string, unknown>;
  html: string;
  rich_text_template: string | null;
  has_bricks: boolean;
  data_source: BlockDefDataSource | null;
  version: number;
  is_current: boolean;
  /**
   * Inherited from library on insert; immutable thereafter. For website-kind
   * libraries this column is unused at the row level (no block_defs are
   * ingested for website sources — they use templates_content_schemas).
   */
  theme_kind: ThemeKind;
  created_at: string;
  updated_at: string;
}

export interface TemplatesBrickDefRow {
  id: string;
  block_def_id: string;
  key: string;
  name: string;
  schema: Record<string, unknown>;
  html: string;
  rich_text_template: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TemplatesWrapperRow {
  id: string;
  library_id: string;
  key: string;
  name: string;
  html: string;
  meta_block_keys: string[];
  global_seed_blocks: string[];
  version: number;
  is_current: boolean;
  created_at: string;
  updated_at: string;
}

export interface TemplatesDefinitionRow {
  id: string;
  library_id: string;
  key: string;
  name: string;
  source_html: string;
  parsed_blocks: Array<{ key: string; sort_order: number }>;
  default_block_order: string[];
  meta_block_keys: string[];
  version: number;
  is_current: boolean;
  created_at: string;
  updated_at: string;
}

// ----------------------------------------------------------------------------
// Source rows
// ----------------------------------------------------------------------------

export type SourceKind = 'git' | 'upload' | 'inline';
export type SourceStatus = 'active' | 'paused' | 'errored';

export interface TemplatesSourceRow {
  id: string;
  library_id: string;
  kind: SourceKind;
  label: string;
  status: SourceStatus;
  /**
   * 'email' (default) → marker-grammar HTML files; the existing parser path.
   * 'website' → Next.js theme repo; theme.json + content/schema.{ts,json}.
   * Immutable after insert. Per spec-sites-theme-kinds §3.
   */
  theme_kind: ThemeKind;

  url: string | null;
  branch: string | null;
  token_secret_ref: string | null;
  manifest_path: string | null;
  installed_git_sha: string | null;
  available_git_sha: string | null;
  last_checked_at: string | null;
  last_check_error: string | null;
  last_check_duration_ms: number | null;
  auto_apply: boolean;

  upload_blob_ref: string | null;
  upload_sha: string | null;

  inline_html: string | null;
  inline_sha: string | null;

  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export type SourceArtifactKind = 'definition' | 'wrapper' | 'block_def' | 'brick_def' | 'asset';

// ----------------------------------------------------------------------------
// Content schemas (Next.js path) — per spec-sites-theme-kinds §8.1
// ----------------------------------------------------------------------------

export type ContentSchemaFormat = 'ts' | 'json';

export interface TemplatesContentSchemaRow {
  id: string;
  source_id: string;
  library_id: string;
  version: number;
  is_current: boolean;
  schema_format: ContentSchemaFormat;
  /** SHA-256 hex of the canonical JSON Schema. Used to detect drift. */
  schema_hash: string;
  /** The JSON Schema (Ajv draft 2020-12) — compiled from .ts or hand-authored .json. */
  schema_json: Record<string, unknown>;
  /** Pointer to the original schema.ts/json in object storage. */
  raw_source_object_key: string | null;
  applied_at: string | null;
  applied_by: string | null;
  created_at: string;
}

export interface TemplatesSourceArtifactRow {
  id: string;
  source_id: string;
  artifact_kind: SourceArtifactKind;
  artifact_id: string;
  source_path: string | null;
  source_sha: string;
  applied_at: string;
  detached_at: string | null;
}

// ----------------------------------------------------------------------------
// Parser shapes (filled in by PR 2; placeholder here so PR 1 builds clean)
// ----------------------------------------------------------------------------

export interface ParsedBlockDef {
  key: string;
  name: string;
  description: string | null;
  has_bricks: boolean;
  sort_order: number;
  schema: Record<string, unknown>;
  html: string;
  rich_text_template: string | null;
  data_source: BlockDefDataSource | null;
  bricks: ParsedBrickDef[];
}

export interface ParsedBrickDef {
  key: string;
  name: string;
  sort_order: number;
  schema: Record<string, unknown>;
  html: string;
  rich_text_template: string | null;
}

export interface ParsedWrapper {
  key: string;
  name: string;
  html: string;
  meta_block_keys: string[];
  global_seed_blocks: string[];
}

export interface ParsedDefinition {
  key: string;
  name: string;
  source_html: string;
  parsed_blocks: Array<{ key: string; sort_order: number }>;
  default_block_order: string[];
  meta_block_keys: string[];
}

export interface ParseError {
  code: string;
  message: string;
  path: string | null;       // file path or marker location
  line: number | null;
}

export interface ParseWarning {
  code: string;
  message: string;
  path: string | null;
  line: number | null;
}

export interface ParseResult {
  wrappers: ParsedWrapper[];
  definitions: ParsedDefinition[];
  block_defs: ParsedBlockDef[];           // brick_defs are nested inside their block
  errors: ParseError[];
  warnings: ParseWarning[];
}

// ----------------------------------------------------------------------------
// A/B engine
// ----------------------------------------------------------------------------

export type AbScopeKind = 'page' | 'block_instance' | 'edition' | 'layout';
export type AbTestStatus = 'draft' | 'running' | 'paused' | 'concluded';

export interface AbVariant {
  key: string;
  weight: number;          // 0..100; sum across variants must equal 100
}

export interface ViewerContext {
  sessionKey: string;
  isLoggedIn: boolean;
  // Open shape; engines may consume additional fields. Kept narrow here
  // so the platform's privacy posture is documented at the type level.
}

export interface AbAssignmentResult {
  variant: string;
  isNew: boolean;          // true when the assignment was created in this call
}

export interface AbSummary {
  testId: string;
  variants: ReadonlyArray<{
    key: string;
    impressions: number;
    conversions: number;
    conversionRate: number;
  }>;
}

export interface IAbEngine {
  readonly id: string;

  assignVariant(input: {
    testId: string;
    sessionKey: string;
    viewerContext: ViewerContext;
  }): Promise<AbAssignmentResult>;

  recordImpression(input: {
    testId: string;
    sessionKey: string;
    variant: string;
    properties?: Record<string, unknown>;
  }): Promise<void>;

  recordConversion(input: {
    testId: string;
    sessionKey: string;
    variant: string;
    goalEvent: string;
    properties?: Record<string, unknown>;
  }): Promise<void>;

  summary(testId: string): Promise<AbSummary>;
  promoteWinner(testId: string, variant: string): Promise<void>;
}
