/**
 * TSX marker grammar parser — interface + stub.
 *
 * Per spec-content-modules-git-architecture §8.2 + §9.4:
 *
 *   Theme repo annotates reusable components with marker comments:
 *     /* @gatewaze:block kind="static" name="Hero" category="hero" *​/
 *     export function Hero(props: HeroProps) { ... }
 *
 *   Parser walks the TSX AST (ts-morph or TypeScript Compiler API),
 *   extracts marked exports, locates each export's prop interface, runs
 *   ts-json-schema-generator over the interface, produces a JSON Schema.
 *
 * Full implementation deferred — needs:
 *   1. ts-morph integration (or direct TypeScript Compiler API)
 *   2. Marker comment extraction (multi-attribute parser)
 *   3. Type-resolution within the same theme repo (capped depth 5)
 *   4. ts-json-schema-generator integration with custom format hints
 *   5. Intersection-type flattening + conflict detection
 *   6. Wrapper marker support (@gatewaze:wrapper)
 *
 * This file declares the public interface so the templates module's
 * apply-source pipeline can target it.
 */

export type BlockKind =
  | 'static'
  | 'ai-generated'
  | 'gatewaze-internal'
  | 'user-personalized'
  | 'external-fetched'
  | 'embed'
  | 'computed';

export type Audience = 'public' | 'authenticated' | 'authenticated_optional';

export type Freshness = 'live' | 'build-time';

export interface MarkedBlock {
  /** Block name (kebab-case). */
  name: string;
  /** Component export path relative to theme repo root, e.g. './components/Hero'. */
  componentExportPath: string;
  /** Source file location for error messages. */
  sourceFile: string;
  sourceLine: number;
  /** Kind from the marker (default 'static'). */
  kind: BlockKind;
  /** Audience (default 'public'). */
  audience: Audience;
  /** Freshness — required for gatewaze-internal and external-fetched. */
  freshness: Freshness | null;
  /** Optional palette-grouping category. */
  category?: string;
  /** Optional admin tooltip. */
  description?: string;
  /** Marked deprecated (still ingested but flagged in editor). */
  deprecated: boolean;
  /** Kind-specific markers (cadence, model, source, cache_ttl_seconds, provider, inputs). */
  kindAttributes: Record<string, string>;
  /** JSON Schema for the component's props (content_schema_json). */
  contentSchema: Record<string, unknown>;
  /** Optional separate schema for kind_config (admin-edited per-instance config). */
  kindConfigSchema?: Record<string, unknown>;
  /** Per-block compliance consent gates. */
  requiresConsent?: string[];
}

export interface MarkedWrapper {
  name: string;
  componentExportPath: string;
  sourceFile: string;
  sourceLine: number;
  /** 'site' = always-applied site shell; 'page' = optional per-page shell. */
  role: 'site' | 'page';
}

export interface ParseResult {
  blocks: MarkedBlock[];
  wrappers: MarkedWrapper[];
  /** Errors found during parsing. Each is actionable per spec §8.2 rules. */
  errors: Array<{
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
    hint?: string;
  }>;
}

export interface ParseOptions {
  /** Path to the cloned theme repo root. */
  repoPath: string;
  /** Marker prefix from gatewaze.theme.json (e.g. '@gatewaze'). */
  markerPrefix: string;
  /** Max depth for type-reference following (anti-cycle). Default 5. */
  maxTypeDepth?: number;
  /** Theme kind — restricts which kinds are valid (e.g. emails can't have user-personalized). */
  themeKind: 'website' | 'email';
}

export interface TsxMarkerParser {
  parse(opts: ParseOptions): Promise<ParseResult>;
}

// ---------------------------------------------------------------------------
// Stub implementation — returns empty result + a TODO error so the apply-source
// pipeline is observable but doesn't claim to have parsed anything.
// Replace with a real ts-morph implementation in a follow-up session.
// ---------------------------------------------------------------------------

export class StubTsxMarkerParser implements TsxMarkerParser {
  async parse(opts: ParseOptions): Promise<ParseResult> {
    return {
      blocks: [],
      wrappers: [],
      errors: [
        {
          file: opts.repoPath,
          line: 0,
          column: 0,
          code: 'parser_not_implemented',
          message: '[tsx-marker-parser stub] full implementation deferred to a follow-up session.',
          hint: 'See spec-content-modules-git-architecture §8.2 + §9.4. Needs ts-morph + ts-json-schema-generator integration.',
        },
      ],
    };
  }
}
