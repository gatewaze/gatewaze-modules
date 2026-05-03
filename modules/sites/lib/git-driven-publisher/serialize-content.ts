/**
 * Content serialization (§6.3.5 of spec-sites-theme-kinds).
 *
 * Converts a draft's structured `pages_nextjs_drafts.content` (JSONB)
 * into the file format declared by `theme.json.content.format`. The
 * transformation is deterministic and side-effect-free so a no-op publish
 * never produces a spurious git commit.
 *
 *   mdx   → YAML (or TOML) frontmatter + body from `__body__` field
 *   json  → JSON.stringify(content, null, 2)
 *   yaml  → YAML 1.2 with sorted keys
 *
 * Plus path-template substitution: {route} / {slug} per the spec.
 */

export type ContentFormat = 'mdx' | 'json' | 'yaml';
export type FrontmatterFormat = 'yaml' | 'toml';

export interface SerializeContentInput {
  content: Record<string, unknown>;
  format: ContentFormat;
  /** Only meaningful for `format='mdx'`. */
  frontmatterFormat?: FrontmatterFormat;
}

export interface SerializeContentResult {
  /** UTF-8 encoded text ready to commit. */
  text: string;
}

export function serializeContent(input: SerializeContentInput): SerializeContentResult {
  switch (input.format) {
    case 'json':
      return { text: JSON.stringify(deepSortKeys(input.content), null, 2) + '\n' };
    case 'yaml':
      return { text: stringifyYaml(deepSortKeys(input.content)) };
    case 'mdx': {
      // Pull out the body field (if present); the rest is frontmatter.
      const { __body__, ...rest } = input.content as Record<string, unknown>;
      const body = typeof __body__ === 'string' ? __body__ : '';
      const fmFormat = input.frontmatterFormat ?? 'yaml';
      const sorted = deepSortKeys(rest) as Record<string, unknown>;
      const fmText =
        fmFormat === 'toml'
          ? stringifyToml(sorted)
          : stringifyYaml(sorted);
      return { text: `---\n${fmText}---\n\n${body}\n` };
    }
  }
}

/**
 * Substitute the page's route into a path template.
 * Per §6.3.5:
 *   1. Let path = page.full_path (e.g. '/', '/about', '/for/developer', '/blog/').
 *   2. If path ends with '/' (incl. '/'), append 'index'.
 *   3. Strip the leading '/'.
 *   4. Substitute {route} in template.
 *   5. If {slug} appears, substitute with last '/'-separated segment.
 */
export function substitutePathTemplate(template: string, fullPath: string): string {
  let path = fullPath;
  if (path.endsWith('/')) {
    path = path + 'index';
  }
  path = path.replace(/^\//, '');
  const segments = path.split('/');
  const slug = segments[segments.length - 1] ?? '';
  return template.replace(/\{route\}/g, path).replace(/\{slug\}/g, slug);
}

// ---------------------------------------------------------------------------
// Implementation: deterministic key sort
// ---------------------------------------------------------------------------

function deepSortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepSortKeys);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[k] = deepSortKeys((value as Record<string, unknown>)[k]);
  }
  return sorted;
}

// ---------------------------------------------------------------------------
// Tiny deterministic YAML 1.2 stringifier — sufficient for content
// frontmatter. Avoids pulling in `js-yaml` for v0.1.
//
// Coverage:
//   - scalars (string, number, boolean, null)
//   - flow-style strings always single-quoted (unless safe-bare)
//   - block-style mappings + sequences
//   - 2-space indent
//
// Not covered (out of scope for content frontmatter):
//   - anchors / aliases
//   - tags
//   - flow mappings / sequences
//   - multi-line block scalars (|, >)
// ---------------------------------------------------------------------------

function stringifyYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null) return 'null\n';
  if (typeof value === 'boolean') return (value ? 'true' : 'false') + '\n';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null\n';
    return String(value) + '\n';
  }
  if (typeof value === 'string') return scalarYaml(value) + '\n';

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]\n';
    let out = indent === 0 ? '' : '\n';
    for (const item of value) {
      out += `${pad}- `;
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        // Inline scalar / array
        out += scalarYamlInline(item);
        out += '\n';
      } else {
        // Block-style nested map
        const nested = stringifyYaml(item, indent + 1);
        // First key sits on the same line as the dash if nested is a single-line block
        out += '\n' + nested;
      }
    }
    return out;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}\n';
    let out = indent === 0 ? '' : '\n';
    for (const k of keys) {
      const v = obj[k];
      if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        out += `${pad}${scalarYamlInline(k)}: ${scalarYamlInline(v)}\n`;
      } else {
        out += `${pad}${scalarYamlInline(k)}:`;
        out += stringifyYaml(v, indent + 1);
      }
    }
    return out;
  }
  return 'null\n';
}

function scalarYaml(s: string): string {
  // Bare-safe: matches a-z A-Z 0-9 _ - and is non-empty, doesn't start
  // with - + or . or digit, doesn't contain colon or hash.
  if (/^[A-Za-z_][A-Za-z0-9_./-]*$/.test(s) && !YAML_RESERVED.has(s.toLowerCase())) {
    return s;
  }
  return "'" + s.replace(/'/g, "''") + "'";
}

function scalarYamlInline(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
  if (typeof v === 'string') return scalarYaml(v);
  // Arrays / objects shouldn't reach inline path — caller dispatches block-style.
  return JSON.stringify(v);
}

// YAML 1.2 reserved scalar values that need quoting to avoid being parsed
// as bool / null / number.
const YAML_RESERVED = new Set(['true', 'false', 'null', 'yes', 'no', 'on', 'off', '~']);

// ---------------------------------------------------------------------------
// Tiny TOML stringifier — only top-level scalars + nested objects-as-tables.
// Sufficient for content frontmatter; punts on arrays-of-tables and complex
// types (those are out of scope for v0.1 mdx frontmatter).
// ---------------------------------------------------------------------------

function stringifyToml(value: Record<string, unknown>, prefix = ''): string {
  let out = '';
  // Scalars first
  for (const [k, v] of Object.entries(value)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      out += `${tomlKey(k)} = ${tomlScalar(v)}\n`;
    }
  }
  // Then nested tables
  for (const [k, v] of Object.entries(value)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const tableName = prefix ? `${prefix}.${tomlKey(k)}` : tomlKey(k);
      out += `\n[${tableName}]\n`;
      out += stringifyToml(v as Record<string, unknown>, tableName);
    }
  }
  return out;
}

function tomlKey(k: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(k)) return k;
  return JSON.stringify(k);
}

function tomlScalar(v: unknown): string {
  if (v === null) return '""';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(tomlScalar).join(', ') + ']';
  }
  return JSON.stringify(v);
}
