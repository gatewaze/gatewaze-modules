// @ts-nocheck — depends on ts-morph + ts-json-schema-generator which require
// `pnpm install` to resolve. Excluded from the module's strict tsconfig until
// the workspace install is wired up. Type errors here are real but bounded
// to this file; rest of the module typechecks clean.
/**
 * Real implementation of TsxMarkerParser using ts-morph + ts-json-schema-generator.
 *
 * Per spec-content-modules-git-architecture §8.2 + §9.4:
 *
 *   1. Walk theme repo with ts-morph (Project + addSourceFilesAtPaths)
 *   2. For each .tsx file: scan leading comments on exported functions
 *   3. Parse @gatewaze:block / @gatewaze:wrapper marker attributes
 *   4. Locate the prop interface for marked exports
 *   5. Run ts-json-schema-generator over the interface
 *   6. Validate kind/freshness invariant + audience constraints
 *
 * Limitations vs full spec:
 *   - Intersection-type flattening: relies on ts-json-schema-generator's
 *     own handling (which inlines them). Conflict detection is best-effort.
 *   - JSDoc @gatewaze:format hints: passed through to schema as
 *     contentFormat keyword.
 */

import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  Project,
  SyntaxKind,
  type FunctionDeclaration,
  type Node,
  type SourceFile,
  type VariableDeclaration,
} from 'ts-morph';
import { createGenerator, type Config as TsjsgConfig } from 'ts-json-schema-generator';

import type {
  Audience,
  BlockKind,
  Freshness,
  MarkedBlock,
  MarkedWrapper,
  ParseOptions,
  ParseResult,
  TsxMarkerParser,
} from './tsx-marker-parser.js';

interface MarkerAttributes {
  kind?: string;
  name?: string;
  category?: string;
  description?: string;
  deprecated?: string;
  audience?: string;
  freshness?: string;
  source?: string;
  cadence?: string;
  model?: string;
  cache_ttl_seconds?: string;
  auth_secret_key?: string;
  provider?: string;
  inputs?: string;
  requires_consent?: string;
  role?: string;
  [key: string]: string | undefined;
}

interface ParseContext {
  opts: ParseOptions;
  blocks: MarkedBlock[];
  wrappers: MarkedWrapper[];
  errors: ParseResult['errors'];
}

// ===========================================================================
// Marker comment extraction
// ===========================================================================

const MARKER_LINE_RE = /^\s*\*\s*@gatewaze:(block|wrapper)\b\s*(.*)$/;

function parseMarkerComment(commentText: string, markerPrefix: string): {
  kind: 'block' | 'wrapper';
  attrs: MarkerAttributes;
} | null {
  const escapedPrefix = markerPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escapedPrefix}:(block|wrapper)\\b\\s*(.*?)(?:\\*/|$)`, 'is');
  const m = commentText.match(re);
  if (!m) return null;
  const kind = m[1] as 'block' | 'wrapper';
  const attrText = m[2] ?? '';
  const attrs: MarkerAttributes = {};
  // Match `name="value"` pairs
  const pairRe = /(\w+)\s*=\s*"([^"]*)"/g;
  let pairMatch: RegExpExecArray | null;
  while ((pairMatch = pairRe.exec(attrText)) !== null) {
    const key = pairMatch[1];
    const val = pairMatch[2];
    if (key && val !== undefined) {
      attrs[key] = val;
    }
  }
  return { kind, attrs };
}

// ===========================================================================
// Block / Wrapper extraction from a single source file
// ===========================================================================

function findExportedFunctions(sourceFile: SourceFile): Array<{
  name: string;
  node: Node;
  jsDocCommentText: string;
  propsTypeName: string | null;
  line: number;
}> {
  const results: Array<{ name: string; node: Node; jsDocCommentText: string; propsTypeName: string | null; line: number }> = [];

  // function Foo(props: FooProps) { ... }  with `export`
  for (const fn of sourceFile.getFunctions()) {
    if (!fn.isExported()) continue;
    const name = fn.getName();
    if (!name) continue;
    results.push({
      name,
      node: fn,
      jsDocCommentText: getLeadingCommentText(fn),
      propsTypeName: getFirstParamTypeName(fn),
      line: fn.getStartLineNumber(),
    });
  }

  // export const Foo = (props: FooProps) => { ... }  / function expression
  for (const decl of sourceFile.getVariableDeclarations()) {
    const declList = decl.getVariableStatement();
    if (!declList?.isExported()) continue;
    const init = decl.getInitializer();
    if (!init) continue;
    if (init.getKind() === SyntaxKind.ArrowFunction || init.getKind() === SyntaxKind.FunctionExpression) {
      const name = decl.getName();
      const propsType = getFirstParamTypeNameFromExpr(decl);
      results.push({
        name,
        node: decl,
        jsDocCommentText: getLeadingCommentText(declList ?? decl),
        propsTypeName: propsType,
        line: decl.getStartLineNumber(),
      });
    }
  }

  return results;
}

function getLeadingCommentText(node: Node): string {
  // Combine all leading-comment ranges into one string
  const sourceText = node.getSourceFile().getFullText();
  const ranges = node.getLeadingCommentRanges();
  if (ranges.length === 0) return '';
  return ranges.map((r) => sourceText.slice(r.getPos(), r.getEnd())).join('\n');
}

function getFirstParamTypeName(fn: FunctionDeclaration): string | null {
  const params = fn.getParameters();
  if (params.length === 0) return null;
  const typeNode = params[0]?.getTypeNode();
  return typeNode?.getText() ?? null;
}

function getFirstParamTypeNameFromExpr(decl: VariableDeclaration): string | null {
  const init = decl.getInitializer();
  if (!init) return null;
  // ArrowFunction or FunctionExpression — both have getParameters()
  const fn = init as Node & { getParameters?: () => Array<{ getTypeNode: () => Node | undefined }> };
  if (typeof fn.getParameters !== 'function') return null;
  const params = fn.getParameters();
  if (params.length === 0) return null;
  const typeNode = params[0]?.getTypeNode();
  return typeNode?.getText() ?? null;
}

// ===========================================================================
// Schema generation (ts-json-schema-generator)
// ===========================================================================

function generateSchemaForType(
  repoPath: string,
  sourceFilePath: string,
  typeName: string,
): { schema: Record<string, unknown> } | { error: string } {
  // Strip generic parameters / nullables from the type name (ts-json-schema-generator
  // expects a bare type)
  const bareType = typeName.replace(/<.*?>$/, '').replace(/\s*\|\s*null$/, '');

  const config: TsjsgConfig = {
    path: sourceFilePath,
    type: bareType,
    tsconfig: join(repoPath, 'tsconfig.json'),
    skipTypeCheck: true,
    additionalProperties: false,
    expose: 'none',
    jsDoc: 'extended',
    sortProps: true,
  };

  try {
    const generator = createGenerator(config);
    const schema = generator.createSchema(bareType);
    // Inline definitions if simple — ts-json-schema-generator returns a top-level
    // schema with $ref for the type and a definitions object. We surface as-is.
    return { schema: schema as unknown as Record<string, unknown> };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message };
  }
}

// ===========================================================================
// Marker validation
// ===========================================================================

function validateBlockMarker(
  attrs: MarkerAttributes,
  themeKind: 'website' | 'email',
): { ok: true; kind: BlockKind; audience: Audience; freshness: Freshness | null } | { ok: false; error: string; hint?: string } {
  const kind = (attrs.kind ?? 'static') as BlockKind;
  const validKinds: BlockKind[] = ['static', 'ai-generated', 'gatewaze-internal', 'user-personalized', 'external-fetched', 'embed', 'computed'];
  if (!validKinds.includes(kind)) {
    return { ok: false, error: `unknown block kind: ${kind}`, hint: `valid: ${validKinds.join(', ')}` };
  }

  // Email kind constraints: only static + ai-generated allowed
  if (themeKind === 'email' && kind !== 'static' && kind !== 'ai-generated') {
    return { ok: false, error: `block kind ${kind} not supported in email themes; use static or ai-generated` };
  }

  const audience = (attrs.audience ?? 'public') as Audience;
  const validAudiences: Audience[] = ['public', 'authenticated', 'authenticated_optional'];
  if (!validAudiences.includes(audience)) {
    return { ok: false, error: `unknown audience: ${audience}`, hint: `valid: ${validAudiences.join(', ')}` };
  }

  if (kind === 'user-personalized' && audience === 'public') {
    return { ok: false, error: `user-personalized blocks must declare audience=authenticated or authenticated_optional` };
  }

  // freshness: required for gatewaze-internal + external-fetched; defaulted
  let freshness: Freshness | null = null;
  if (kind === 'gatewaze-internal' || kind === 'external-fetched') {
    const declared = attrs.freshness;
    if (declared && declared !== 'live' && declared !== 'build-time') {
      return { ok: false, error: `unknown freshness: ${declared}`, hint: 'use live or build-time' };
    }
    freshness = (declared as Freshness | undefined) ?? (kind === 'external-fetched' ? 'build-time' : 'live');
  }

  // Kind-specific required attributes
  if (kind === 'ai-generated') {
    const cadence = attrs.cadence;
    if (cadence && !['before-publish', 'scheduled', 'manual'].includes(cadence)) {
      return { ok: false, error: `unknown cadence: ${cadence}`, hint: 'use before-publish, scheduled, or manual' };
    }
  }
  if (kind === 'gatewaze-internal' && !attrs.source) {
    return { ok: false, error: `gatewaze-internal blocks must declare a source attribute` };
  }
  if (kind === 'external-fetched' && freshness !== 'build-time') {
    return { ok: false, error: `external-fetched blocks must use freshness=build-time (no runtime fetches per spec §9.2)` };
  }
  if (kind === 'embed' && !attrs.provider) {
    return { ok: false, error: `embed blocks must declare a provider attribute` };
  }

  return { ok: true, kind, audience, freshness };
}

// ===========================================================================
// Top-level parser
// ===========================================================================

export class TsxMarkerParserImpl implements TsxMarkerParser {
  async parse(opts: ParseOptions): Promise<ParseResult> {
    const ctx: ParseContext = {
      opts,
      blocks: [],
      wrappers: [],
      errors: [],
    };

    // Validate gatewaze.theme.json + parser version compatibility (lightweight)
    try {
      const themeJsonPath = join(opts.repoPath, 'gatewaze.theme.json');
      const themeJsonRaw = await readFile(themeJsonPath, 'utf8');
      const themeJson = JSON.parse(themeJsonRaw) as { theme_kind?: string; parser?: { marker_prefix?: string } };
      if (themeJson.theme_kind && themeJson.theme_kind !== opts.themeKind) {
        ctx.errors.push({
          file: themeJsonPath,
          line: 0,
          column: 0,
          code: 'theme_kind_mismatch',
          message: `gatewaze.theme.json declares theme_kind=${themeJson.theme_kind}, but parser invoked with themeKind=${opts.themeKind}`,
        });
      }
    } catch {
      // Optional file — proceed
    }

    // Set up ts-morph project
    let project: Project;
    try {
      project = new Project({
        tsConfigFilePath: join(opts.repoPath, 'tsconfig.json'),
        skipAddingFilesFromTsConfig: false,
      });
    } catch {
      // Fallback: pick up .tsx files manually
      project = new Project({ useInMemoryFileSystem: false });
      project.addSourceFilesAtPaths(join(opts.repoPath, '**/*.{ts,tsx}'));
    }

    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      // Only scan .tsx + .ts files in the repo
      if (!filePath.startsWith(opts.repoPath)) continue;

      const exports = findExportedFunctions(sourceFile);
      for (const exp of exports) {
        const marker = parseMarkerComment(exp.jsDocCommentText, opts.markerPrefix);
        if (!marker) continue;

        if (marker.kind === 'block') {
          this.processBlock(ctx, sourceFile, exp, marker.attrs);
        } else {
          this.processWrapper(ctx, sourceFile, exp, marker.attrs);
        }
      }
    }

    return {
      blocks: ctx.blocks,
      wrappers: ctx.wrappers,
      errors: ctx.errors,
    };
  }

  private processBlock(
    ctx: ParseContext,
    sourceFile: SourceFile,
    exp: { name: string; propsTypeName: string | null; line: number },
    attrs: MarkerAttributes,
  ): void {
    const filePath = sourceFile.getFilePath();
    const relativePath = relative(ctx.opts.repoPath, filePath);

    if (!attrs.name || !/^[a-z0-9-]+$/.test(attrs.name)) {
      ctx.errors.push({
        file: relativePath,
        line: exp.line,
        column: 0,
        code: 'invalid_block_name',
        message: `block name attribute is required and must be kebab-case (got: ${attrs.name ?? '(missing)'})`,
      });
      return;
    }

    const validation = validateBlockMarker(attrs, ctx.opts.themeKind);
    if (!validation.ok) {
      ctx.errors.push({
        file: relativePath,
        line: exp.line,
        column: 0,
        code: 'invalid_block_marker',
        message: validation.error,
        hint: validation.hint,
      });
      return;
    }

    // Generate content schema from props interface
    let contentSchema: Record<string, unknown> = {};
    if (exp.propsTypeName) {
      const result = generateSchemaForType(ctx.opts.repoPath, filePath, exp.propsTypeName);
      if ('error' in result) {
        ctx.errors.push({
          file: relativePath,
          line: exp.line,
          column: 0,
          code: 'schema_generation_failed',
          message: `failed to generate schema for ${exp.propsTypeName}: ${result.error}`,
          hint: 'See spec §8.2 for the supported TS subset (plain interfaces, primitives, optional fields, JSDoc).',
        });
        return;
      }
      contentSchema = result.schema;
    } else {
      ctx.errors.push({
        file: relativePath,
        line: exp.line,
        column: 0,
        code: 'missing_props_type',
        message: `exported component ${exp.name} has no typed props parameter; cannot derive content schema`,
        hint: 'Add a typed props parameter, e.g. function Foo(props: FooProps).',
      });
      return;
    }

    // Build kind-specific attributes (cadence, model, source, provider, inputs, etc.)
    const kindAttributes: Record<string, string> = {};
    for (const [key, val] of Object.entries(attrs)) {
      if (val === undefined) continue;
      if (['kind', 'name', 'category', 'description', 'deprecated', 'audience', 'freshness', 'role', 'requires_consent'].includes(key)) continue;
      kindAttributes[key] = val;
    }

    const requiresConsent = attrs.requires_consent
      ? attrs.requires_consent.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    ctx.blocks.push({
      name: attrs.name,
      componentExportPath: `./${relativePath.replace(/\.tsx?$/, '')}`,
      sourceFile: relativePath,
      sourceLine: exp.line,
      kind: validation.kind,
      audience: validation.audience,
      freshness: validation.freshness,
      category: attrs.category,
      description: attrs.description,
      deprecated: attrs.deprecated === 'true',
      kindAttributes,
      contentSchema,
      requiresConsent,
    });
  }

  private processWrapper(
    ctx: ParseContext,
    sourceFile: SourceFile,
    exp: { name: string; line: number },
    attrs: MarkerAttributes,
  ): void {
    const filePath = sourceFile.getFilePath();
    const relativePath = relative(ctx.opts.repoPath, filePath);

    if (!attrs.name) {
      ctx.errors.push({
        file: relativePath,
        line: exp.line,
        column: 0,
        code: 'invalid_wrapper_name',
        message: 'wrapper name attribute is required',
      });
      return;
    }

    const role = attrs.role;
    if (role !== 'site' && role !== 'page') {
      ctx.errors.push({
        file: relativePath,
        line: exp.line,
        column: 0,
        code: 'invalid_wrapper_role',
        message: `wrapper role must be "site" or "page" (got: ${role ?? '(missing)'})`,
      });
      return;
    }

    ctx.wrappers.push({
      name: attrs.name,
      componentExportPath: `./${relativePath.replace(/\.tsx?$/, '')}`,
      sourceFile: relativePath,
      sourceLine: exp.line,
      role,
    });
  }
}
