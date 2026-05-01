/**
 * Parser entry point: parse(html: string, opts?) -> ParseResult.
 *
 * Walks the source for WRAPPER / BLOCK / BRICK markers, extracts SCHEMA
 * payloads, runs lint passes, and returns structured definitions plus
 * errors and warnings.
 *
 * No filesystem or DB I/O. Pure function over a string.
 */

import type {
  ParsedBlockDef,
  ParsedBrickDef,
  ParsedDefinition,
  ParsedWrapper,
  ParseError,
  ParseResult,
  ParseWarning,
  BlockDefDataSource,
} from '../../types/index.js';
import {
  extractDataSourcePayload,
  extractRichTextTemplate,
  extractSchemaPayload,
  findClose,
  findOpenTags,
  locationAt,
  type OpenTagMatch,
} from './markers.js';
import {
  lintMustacheRefsResolveAgainstSchema,
  lintNoSecretsInHtml,
  lintTripleStashOnlyInHtmlFields,
} from './lint.js';

export interface ParseOptions {
  /** Maximum bytes accepted; throws beyond this. Default 1 MiB. */
  maxBytes?: number;
  /** When true (default), runs the lint passes and adds their issues to errors/warnings. */
  runLint?: boolean;
  /** Source-path label used in error/warning location (e.g. relative path inside a repo). */
  sourcePath?: string | null;
}

const DEFAULT_MAX_BYTES = 1_048_576;

export function parse(html: string, opts: ParseOptions = {}): ParseResult {
  const { maxBytes = DEFAULT_MAX_BYTES, runLint = true, sourcePath = null } = opts;

  if (typeof html !== 'string') {
    return emptyResult([
      {
        code: 'templates.parse.input_not_string',
        message: 'parse() received a non-string input.',
        path: sourcePath,
        line: null,
      },
    ]);
  }

  const byteLength = utf8ByteLength(html);
  if (byteLength > maxBytes) {
    return emptyResult([
      {
        code: 'templates.parse.input_too_large',
        message: `Source is ${byteLength} bytes; max is ${maxBytes}. Trim the source or raise parser_max_bytes_per_file.`,
        path: sourcePath,
        line: null,
      },
    ]);
  }

  const errors: ParseError[] = [];
  const warnings: ParseWarning[] = [];

  // 1. WRAPPERs
  const wrappers = extractWrappers(html, sourcePath, errors, warnings);

  // 2. BLOCKs (and their nested BRICKs)
  const block_defs = extractBlocks(html, sourcePath, errors, warnings, runLint);

  // 3. DEFINITIONs are derived from the source as a whole when at least one
  //    BLOCK is present. The "definition" represents the parsed file as a
  //    starter set; we generate one synthetic definition per file. Sources
  //    that contain ONLY a wrapper or only inline blocks produce no
  //    definition row (and that's fine).
  const definitions: ParsedDefinition[] = [];
  if (block_defs.length > 0) {
    definitions.push({
      key: deriveDefinitionKey(sourcePath),
      name: deriveDefinitionName(sourcePath),
      source_html: html,
      parsed_blocks: block_defs.map((b, i) => ({ key: b.key, sort_order: b.sort_order ?? i })),
      default_block_order: block_defs
        .slice()
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((b) => b.key),
      meta_block_keys: wrappers[0]?.meta_block_keys ?? [],
    });
  }

  return { wrappers, definitions, block_defs, errors, warnings };
}

// ---------------------------------------------------------------------------
// WRAPPER extraction
// ---------------------------------------------------------------------------

function extractWrappers(
  html: string,
  sourcePath: string | null,
  errors: ParseError[],
  warnings: ParseWarning[],
): ParsedWrapper[] {
  const out: ParsedWrapper[] = [];
  for (const open of findOpenTags('WRAPPER', html)) {
    const close = findClose(html, 'WRAPPER', open.key, open.location.offset + open.rawMatch.length);
    if (!close) {
      errors.push({
        code: 'templates.parse.wrapper_unclosed',
        message: `WRAPPER:${open.key} has no matching </WRAPPER:${open.key}>.`,
        path: sourcePath,
        line: open.location.line,
      });
      continue;
    }

    const bodyStart = open.location.offset + open.rawMatch.length;
    const body = html.substring(bodyStart, close.closeStart);

    if (!body.includes('{{content}}')) {
      errors.push({
        code: 'templates.parse.wrapper_missing_content_slot',
        message: `WRAPPER:${open.key} must contain {{content}} exactly once.`,
        path: sourcePath,
        line: open.location.line,
      });
    } else if (countOccurrences(body, '{{content}}') > 1) {
      errors.push({
        code: 'templates.parse.wrapper_duplicate_content_slot',
        message: `WRAPPER:${open.key} contains {{content}} more than once.`,
        path: sourcePath,
        line: open.location.line,
      });
    }

    const meta_block_keys = extractMetaSlots(body, sourcePath, open.location.line, warnings);

    out.push({
      key: open.key,
      name: open.attrs['name'] ?? humanise(open.key),
      html: body.trim(),
      meta_block_keys,
      // global_seed_blocks come from a `seeds=block1,block2` attribute or are
      // empty. Authors who want auto-seeded blocks declare them on the wrapper.
      global_seed_blocks: parseListAttr(open.attrs['seeds']),
    });
  }
  return out;
}

function extractMetaSlots(
  wrapperBody: string,
  sourcePath: string | null,
  wrapperLine: number,
  warnings: ParseWarning[],
): string[] {
  const keys: string[] = [];
  for (const open of findOpenTags('META', wrapperBody)) {
    const close = findClose(wrapperBody, 'META', open.key, open.location.offset + open.rawMatch.length);
    if (!close) {
      warnings.push({
        code: 'templates.parse.meta_unclosed',
        message: `META:${open.key} (inside WRAPPER) has no matching close tag — slot ignored.`,
        path: sourcePath,
        line: wrapperLine + open.location.line - 1,
      });
      continue;
    }
    keys.push(open.key);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// BLOCK extraction (with nested BRICKs)
// ---------------------------------------------------------------------------

function extractBlocks(
  html: string,
  sourcePath: string | null,
  errors: ParseError[],
  warnings: ParseWarning[],
  runLint: boolean,
): ParsedBlockDef[] {
  const out: ParsedBlockDef[] = [];

  // Skip block matches that fall inside a WRAPPER — those are part of the
  // wrapper body, not standalone block defs. Build a set of wrapper-body
  // ranges first.
  const wrapperRanges: Array<[number, number]> = [];
  for (const w of findOpenTags('WRAPPER', html)) {
    const close = findClose(html, 'WRAPPER', w.key, w.location.offset + w.rawMatch.length);
    if (close) {
      wrapperRanges.push([w.location.offset, close.closeEnd]);
    }
  }

  let blockIndex = 0;

  for (const open of findOpenTags('BLOCK', html)) {
    if (isInsideAnyRange(open.location.offset, wrapperRanges)) continue;

    const close = findClose(html, 'BLOCK', open.key, open.location.offset + open.rawMatch.length);
    if (!close) {
      errors.push({
        code: 'templates.parse.block_unclosed',
        message: `BLOCK:${open.key} has no matching </BLOCK:${open.key}>.`,
        path: sourcePath,
        line: open.location.line,
      });
      continue;
    }

    const bodyStart = open.location.offset + open.rawMatch.length;
    const body = html.substring(bodyStart, close.closeStart);

    const has_bricks = open.attrs['has_bricks'] === 'true';
    const sort_order = open.attrs['sort_order'] !== undefined
      ? parseInt(open.attrs['sort_order'], 10)
      : blockIndex;
    blockIndex++;

    // Schema (required, even if empty)
    let schema: Record<string, unknown> = {};
    let bodyAfterSchema = body;
    try {
      const ext = extractSchemaPayload(body);
      schema = ext.schema;
      bodyAfterSchema = ext.remaining;
    } catch (e) {
      errors.push({
        code: 'templates.parse.block_schema_invalid_json',
        message: `BLOCK:${open.key} SCHEMA payload is not valid JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
        path: sourcePath,
        line: open.location.line,
      });
    }

    // Rich text template (optional)
    let bodyAfterRt = bodyAfterSchema;
    let richText: string | null = null;
    {
      const ext = extractRichTextTemplate(bodyAfterSchema);
      richText = ext.richText;
      bodyAfterRt = ext.remaining;
    }

    // Bricks (when has_bricks=true) — extract before computing the block body
    // so the brick comments and SCHEMAs don't leak into the block's HTML.
    let bricks: ParsedBrickDef[] = [];
    let bodyAfterBricks = bodyAfterRt;
    if (has_bricks) {
      const ext = extractBricks(bodyAfterRt, open.key, sourcePath, errors, open.location.line);
      bricks = ext.bricks;
      bodyAfterBricks = ext.remaining;
    } else if (countOccurrences(bodyAfterRt, '<!-- BRICK:') > 0) {
      // Bricks present but has_bricks=false — author error
      warnings.push({
        code: 'templates.parse.block_bricks_present_without_flag',
        message: `BLOCK:${open.key} contains BRICK markers but does not declare has_bricks=true. Bricks will be ignored.`,
        path: sourcePath,
        line: open.location.line,
      });
    }

    // DATA_SOURCE (optional)
    let data_source: BlockDefDataSource | null = null;
    let bodyAfterDataSource = bodyAfterBricks;
    try {
      const ext = extractDataSourcePayload(bodyAfterBricks);
      bodyAfterDataSource = ext.remaining;
      if (ext.dataSource) {
        // Type-narrow. The data-source schema validation happens elsewhere.
        data_source = ext.dataSource as unknown as BlockDefDataSource;
      }
    } catch (e) {
      errors.push({
        code: 'templates.parse.block_data_source_invalid_json',
        message: `BLOCK:${open.key} DATA_SOURCE payload is not valid JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
        path: sourcePath,
        line: open.location.line,
      });
    }

    const blockHtml = bodyAfterDataSource.trim();

    // Lint passes
    if (runLint) {
      const secretIssues = lintNoSecretsInHtml(blockHtml);
      for (const issue of secretIssues) {
        errors.push({
          code: issue.code,
          message: `BLOCK:${open.key}: ${issue.message}${issue.hint ? ` (\`${issue.hint}\`)` : ''}`,
          path: sourcePath,
          line: open.location.line,
        });
      }

      const tripleIssues = lintTripleStashOnlyInHtmlFields(schema, blockHtml);
      for (const issue of tripleIssues) {
        warnings.push({
          code: issue.code,
          message: `BLOCK:${open.key}: ${issue.message}`,
          path: sourcePath,
          line: open.location.line,
        });
      }

      const refIssues = lintMustacheRefsResolveAgainstSchema(schema, blockHtml);
      for (const issue of refIssues) {
        warnings.push({
          code: issue.code,
          message: `BLOCK:${open.key}: ${issue.message}`,
          path: sourcePath,
          line: open.location.line,
        });
      }
    }

    out.push({
      key: open.key,
      name: open.attrs['name'] ?? humanise(open.key),
      description: open.attrs['description'] ?? null,
      has_bricks,
      sort_order,
      schema,
      html: blockHtml,
      rich_text_template: richText,
      data_source,
      bricks,
    });
  }

  return out;
}

function extractBricks(
  blockBody: string,
  parentBlockKey: string,
  sourcePath: string | null,
  errors: ParseError[],
  parentLine: number,
): { bricks: ParsedBrickDef[]; remaining: string } {
  const bricks: ParsedBrickDef[] = [];
  let firstBrickOffset = -1;
  let lastBrickEnd = -1;
  let brickIndex = 0;

  for (const open of findOpenTags('BRICK', blockBody)) {
    const close = findClose(
      blockBody,
      'BRICK',
      open.key,
      open.location.offset + open.rawMatch.length,
    );
    if (!close) {
      errors.push({
        code: 'templates.parse.brick_unclosed',
        message: `BRICK:${open.key} (inside BLOCK:${parentBlockKey}) has no matching close.`,
        path: sourcePath,
        line: parentLine + open.location.line - 1,
      });
      continue;
    }

    if (firstBrickOffset === -1) firstBrickOffset = open.location.offset;
    lastBrickEnd = close.closeEnd;

    const bodyStart = open.location.offset + open.rawMatch.length;
    const body = blockBody.substring(bodyStart, close.closeStart);

    let schema: Record<string, unknown> = {};
    let bodyAfterSchema = body;
    try {
      const ext = extractSchemaPayload(body);
      schema = ext.schema;
      bodyAfterSchema = ext.remaining;
    } catch (e) {
      errors.push({
        code: 'templates.parse.brick_schema_invalid_json',
        message: `BRICK:${open.key} (inside BLOCK:${parentBlockKey}): SCHEMA payload is not valid JSON: ${
          e instanceof Error ? e.message : String(e)
        }`,
        path: sourcePath,
        line: parentLine + open.location.line - 1,
      });
    }

    let bodyAfterRt = bodyAfterSchema;
    let richText: string | null = null;
    {
      const ext = extractRichTextTemplate(bodyAfterSchema);
      richText = ext.richText;
      bodyAfterRt = ext.remaining;
    }

    const sort_order = open.attrs['sort_order'] !== undefined
      ? parseInt(open.attrs['sort_order'], 10)
      : brickIndex;
    brickIndex++;

    bricks.push({
      key: open.key,
      name: open.attrs['name'] ?? humanise(open.key),
      sort_order,
      schema,
      html: bodyAfterRt.trim(),
      rich_text_template: richText,
    });
  }

  // Replace the brick region with `{{bricks}}` so the parent block's HTML
  // renders the bricks loop. If no bricks were found, leave the block body
  // untouched — the parent has has_bricks=true but the source authored no
  // bricks; the renderer will substitute the empty list.
  let remaining = blockBody;
  if (firstBrickOffset !== -1 && lastBrickEnd !== -1) {
    remaining =
      blockBody.substring(0, firstBrickOffset).trimEnd() +
      '\n{{bricks}}\n' +
      blockBody.substring(lastBrickEnd).trimStart();
  }

  return { bricks, remaining };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function utf8ByteLength(s: string): number {
  // TextEncoder is a Web API available in Node ≥ 11 and all modern browsers,
  // so we avoid pulling @types/node into the parser package.
  return new TextEncoder().encode(s).length;
}

function emptyResult(errors: ParseError[]): ParseResult {
  return {
    wrappers: [],
    definitions: [],
    block_defs: [],
    errors,
    warnings: [],
  };
}

function isInsideAnyRange(offset: number, ranges: Array<[number, number]>): boolean {
  for (const [start, end] of ranges) {
    if (offset > start && offset < end) return true;
  }
  return false;
}

function countOccurrences(s: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  while ((i = s.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

function parseListAttr(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function humanise(key: string): string {
  return key
    .split('_')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function deriveDefinitionKey(sourcePath: string | null): string {
  if (!sourcePath) return 'main';
  const base = sourcePath.replace(/\\/g, '/').split('/').pop() ?? 'main';
  return base.replace(/\.[a-zA-Z0-9]+$/, '').replace(/[^a-z0-9_-]/gi, '_').toLowerCase() || 'main';
}

function deriveDefinitionName(sourcePath: string | null): string {
  return humanise(deriveDefinitionKey(sourcePath));
}

// re-export for convenience
export { locationAt };
