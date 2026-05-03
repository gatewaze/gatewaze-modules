/**
 * Parser registry — extension point for source-format-specific parsers.
 *
 * Per spec-content-modules-git-architecture §8.2: the TSX marker parser
 * lives in the sites module (it's website-theme-specific). Templates
 * stays foundational and dispatches via this registry.
 *
 * Sites module registers at platform-init:
 *
 *   import { registerSourceParser } from '@gatewaze-modules/templates/lib/parser/parser-registry';
 *   import { TsxMarkerParserImpl } from '@gatewaze-modules/sites/lib/parser/tsx-marker-parser-impl';
 *   registerSourceParser('tsx-marker', new TsxMarkerParserImpl());
 *
 * Templates' ingest worker calls dispatchParser(sourceFormat) to get
 * the right parser; falls back to the built-in HTML marker parser when
 * no provider is registered for a non-html-marker format.
 */

export type SourceFormat = 'html-marker' | 'mjml-marker' | 'tsx-marker' | 'manifest';

export interface ParsedBlock {
  name: string;
  componentExportPath: string;
  sourceFile: string;
  sourceLine: number;
  kind: 'static' | 'ai-generated' | 'gatewaze-internal' | 'user-personalized' | 'external-fetched' | 'embed' | 'computed';
  audience: 'public' | 'authenticated' | 'authenticated_optional';
  freshness: 'live' | 'build-time' | null;
  category?: string;
  description?: string;
  deprecated: boolean;
  kindAttributes: Record<string, string>;
  contentSchema: Record<string, unknown>;
  kindConfigSchema?: Record<string, unknown>;
  requiresConsent?: string[];
}

export interface ParsedWrapper {
  name: string;
  componentExportPath: string;
  sourceFile: string;
  sourceLine: number;
  role: 'site' | 'page';
}

export interface ExtParserParseResult {
  blocks: ParsedBlock[];
  wrappers: ParsedWrapper[];
  errors: Array<{
    file: string;
    line: number;
    column: number;
    code: string;
    message: string;
    hint?: string;
  }>;
}

export interface ExtParserParseOptions {
  repoPath: string;
  markerPrefix: string;
  themeKind: 'website' | 'email';
  maxTypeDepth?: number;
}

export interface ExtParser {
  parse(opts: ExtParserParseOptions): Promise<ExtParserParseResult>;
}

const registry = new Map<SourceFormat, ExtParser>();

export function registerSourceParser(format: SourceFormat, parser: ExtParser): void {
  if (registry.has(format)) {
    throw new Error(`registerSourceParser: format '${format}' already registered`);
  }
  registry.set(format, parser);
}

export function dispatchParser(format: SourceFormat): ExtParser | null {
  return registry.get(format) ?? null;
}

export function listRegisteredFormats(): SourceFormat[] {
  return [...registry.keys()];
}

// Test/dev utility: clear the registry (used in tests).
export function _clearParserRegistry(): void {
  registry.clear();
}
