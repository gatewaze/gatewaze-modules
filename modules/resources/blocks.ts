// Structured blocks — shared kind registry and write-layer functions.
//
// This is the single implementation of per-kind validation, search-text
// projection and slug derivation consumed by every write path: the manage
// API (Node), the MCP tools (via the manage API), and the admin UI
// (browser). See spec-resources-structured-blocks.md in the specs repo.
//
// Environment-agnostic on purpose: no DOM, no Node APIs, no dependencies.
// HTML handling uses the small tokenizer below (one parser everywhere, per
// the spec's single-parser rule) rather than an external library, because
// module deps are operationally expensive to add and this file must bundle
// into the browser admin as well as run inside the API container.

export const BLOCK_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
export const BLOCK_KIND_RE = /^[a-z][a-z0-9_]{0,40}$/;
export const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
export const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;
export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Serialized-data byte ceiling for typed kinds; `html` is bounded by its own field limit. */
export const TYPED_DATA_MAX_BYTES = 256 * 1024;
export const HTML_FIELD_MAX_CHARS = 500_000;
/** html search-text projection truncation — relevance beyond this is noise. */
export const HTML_SEARCH_TEXT_MAX_CHARS = 200_000;

export interface BlockInput {
  kind: string;
  slug: string | null;
  sort_order: number;
  data: Record<string, unknown>;
}

export interface ValidationIssue {
  path: string;      // e.g. "blocks[2].data.speaker.name"
  keyword: string;   // schema keyword or rule name — never a field value
  message: string;
}

// ── Minimal HTML tokenizer ──────────────────────────────────────────────────
//
// Contract (matching parse5 fragment behavior for the two properties the spec
// pins down): top-level text/comment nodes are ignored for slug derivation,
// and `id` attribute values are preserved exactly. Handles comments, doctype,
// single/double/unquoted attributes, void elements and raw-text elements.

const VOID = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);

interface OpenTag { name: string; attrs: Record<string, string>; selfClosing: boolean }

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&');
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const name = m[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Walk the fragment, calling visitors. Return false from a visitor to stop early. */
function scanHtml(
  html: string,
  on: {
    open?: (tag: OpenTag, depth: number) => boolean | void;
    close?: (name: string, depth: number) => boolean | void;
    text?: (text: string, depth: number) => boolean | void;
  },
): void {
  let i = 0;
  let depth = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      if (on.text && i < n && on.text(html.slice(i), depth) === false) return;
      return;
    }
    if (lt > i && on.text && on.text(html.slice(i, lt), depth) === false) return;
    // comment / doctype / CDATA
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) return; // truncated tag — stop
    const raw = html.slice(lt + 1, gt);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().toLowerCase();
      if (depth > 0) depth--;
      if (on.close && on.close(name, depth) === false) return;
      i = gt + 1;
      continue;
    }
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
    if (!nameMatch) { i = gt + 1; continue; }
    const name = nameMatch[1].toLowerCase();
    const selfClosing = raw.endsWith('/') || VOID.has(name);
    const tag: OpenTag = { name, attrs: parseAttrs(raw.slice(nameMatch[0].length)), selfClosing };
    if (on.open && on.open(tag, depth) === false) return;
    i = gt + 1;
    if (!selfClosing && RAW_TEXT.has(name)) {
      // raw-text content: skip to the matching close tag, emit nothing
      const closeRe = new RegExp(`</${name}\\s*>`, 'i');
      const m = closeRe.exec(html.slice(i));
      i = m ? i + m.index + m[0].length : n;
      continue;
    }
    if (!selfClosing) depth++;
  }
}

/**
 * Deterministic slug derivation for `html` blocks: considering only element
 * children at the top level (text/comment nodes ignored), if there is exactly
 * one element and it has an `id` matching the slug regex, that id is the
 * slug; otherwise null. (Spec: Block Kinds → html → slug rules.)
 */
export function deriveHtmlSlug(html: string): string | null {
  let topCount = 0;
  let firstId: string | null = null;
  scanHtml(html, {
    open(tag, depth) {
      if (depth === 0) {
        topCount++;
        if (topCount === 1) firstId = tag.attrs['id'] ?? null;
        if (topCount > 1) return false;
      }
    },
  });
  if (topCount !== 1 || !firstId) return null;
  return BLOCK_SLUG_RE.test(firstId) ? firstId : null;
}

/** True when any element in the fragment carries exactly this id. */
export function htmlContainsId(html: string, id: string): boolean {
  let found = false;
  scanHtml(html, {
    open(tag) {
      if (tag.attrs['id'] === id) { found = true; return false; }
    },
  });
  return found;
}

/** Plain-text projection of an HTML fragment: text nodes joined, whitespace normalized. */
export function stripHtmlText(html: string): string {
  const parts: string[] = [];
  scanHtml(html, { text(t) { parts.push(t); } });
  return decodeEntities(parts.join(' ')).replace(/\s+/g, ' ').trim();
}

// ── JSON-Schema-subset validator ────────────────────────────────────────────
//
// Interprets the subset of JSON Schema the kind schemas use (type, required,
// properties, additionalProperties, min/maxLength, pattern, minimum,
// maxItems, items). Semantics per spec: no type coercion, no defaults, all
// errors collected, pointer-style paths, unknown fields permitted and never
// stripped where additionalProperties is true. Issues carry paths and
// keywords only — never values.

type Schema = Record<string, any>;

function checkSchema(schema: Schema, value: unknown, path: string, issues: ValidationIssue[]): void {
  const t = schema.type;
  if (t === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      issues.push({ path, keyword: 'type', message: 'must be an object' });
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (obj[req] === undefined || obj[req] === null) {
        issues.push({ path: `${path}.${req}`, keyword: 'required', message: 'is required' });
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined && obj[key] !== null) checkSchema(sub as Schema, obj[key], `${path}.${key}`, issues);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in (schema.properties ?? {}))) {
          issues.push({ path: `${path}.${key}`, keyword: 'additionalProperties', message: 'unknown field' });
        }
      }
    }
  } else if (t === 'string') {
    if (typeof value !== 'string') {
      issues.push({ path, keyword: 'type', message: 'must be a string' });
      return;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      issues.push({ path, keyword: 'minLength', message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      issues.push({ path, keyword: 'maxLength', message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      issues.push({ path, keyword: 'pattern', message: 'has an invalid format' });
    }
    if (schema.format === 'https-url') {
      let ok = false;
      try { ok = new URL(value).protocol === 'https:'; } catch { ok = false; }
      if (!ok) issues.push({ path, keyword: 'format', message: 'must be a valid https:// URL' });
    }
  } else if (t === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      issues.push({ path, keyword: 'type', message: 'must be an integer (numeric strings are rejected)' });
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push({ path, keyword: 'minimum', message: `must be >= ${schema.minimum}` });
    }
  } else if (t === 'array') {
    if (!Array.isArray(value)) {
      issues.push({ path, keyword: 'type', message: 'must be an array' });
      return;
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push({ path, keyword: 'maxItems', message: `must have at most ${schema.maxItems} entries` });
    }
    if (schema.items) {
      value.forEach((v, i) => checkSchema(schema.items as Schema, v, `${path}[${i}]`, issues));
    }
  }
}

// ── Kind registry ───────────────────────────────────────────────────────────

export interface BlockKindDef {
  kind: string;
  requireSlug: boolean;
  jsonSchema: Schema;
  searchText: (data: Record<string, unknown>) => string | null;
  /** Extra rules the schema subset can't express. */
  extraChecks?: (data: Record<string, unknown>, slug: string | null, path: string) => ValidationIssue[];
}

function normalizeSearchText(s: string): string | null {
  const out = s.replace(/\s+/g, ' ').trim();
  return out.length > 0 ? out : null;
}

const htmlKind: BlockKindDef = {
  kind: 'html',
  requireSlug: false,
  jsonSchema: {
    type: 'object',
    required: ['html'],
    properties: {
      html: { type: 'string', minLength: 1, maxLength: HTML_FIELD_MAX_CHARS },
    },
    additionalProperties: true,
  },
  searchText: (data) =>
    typeof data.html === 'string'
      ? normalizeSearchText(stripHtmlText(data.html).slice(0, HTML_SEARCH_TEXT_MAX_CHARS))
      : null,
  extraChecks: (data, slug, path) => {
    // An explicit slug must resolve to a real element id inside the payload —
    // a probe hit that can't scroll is a broken deep link (spec: html slug rules).
    if (slug && typeof data.html === 'string' && !htmlContainsId(data.html, slug)) {
      return [{ path: `${path}.slug`, keyword: 'html_slug_unresolved', message: 'no element in data.html has an id equal to the slug' }];
    }
    return [];
  },
};

const talkKind: BlockKindDef = {
  kind: 'talk',
  requireSlug: true,
  jsonSchema: {
    type: 'object',
    required: ['title', 'speaker'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 300 },
      number: { type: 'integer', minimum: 1 },
      speaker: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 120 },
          company: { type: 'string', maxLength: 120 },
          linkedin: { type: 'string', format: 'https-url' },
        },
        additionalProperties: true,
      },
      // Additive field beyond the base spec schema: full multi-speaker
      // fidelity (names + profile links) for talks with more than one
      // speaker. speaker.name stays the canonical display line. `join` is
      // the separator BEFORE this speaker ('&' renders "A & B", default
      // comma) — explicit data, so display never depends on a heuristic.
      speakers: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            url: { type: 'string', format: 'https-url' },
            join: { type: 'string', pattern: '^[&,]$' },
          },
          additionalProperties: true,
        },
      },
      youtube_id: { type: 'string', pattern: YOUTUBE_ID_RE.source },
      // Additive: the talk's canonical external link (title href). When
      // omitted the renderer falls back to https://youtu.be/<youtube_id>.
      url: { type: 'string', format: 'https-url' },
      worth_noting: { type: 'string', maxLength: 5000 },
      quote: { type: 'string', maxLength: 1000 },
      topics: {
        type: 'array',
        maxItems: 25,
        items: { type: 'string', pattern: TOPIC_RE.source },
      },
      // Additive: per-theme accent color for the card chrome (hex like
      // #a78bfa). Presentation metadata, not content.
      accent: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
    },
    additionalProperties: true,
  },
  searchText: (data) => {
    const speaker = (data.speaker ?? {}) as Record<string, unknown>;
    const parts = [
      data.title, speaker.name, speaker.company, data.worth_noting, data.quote,
      ...(Array.isArray(data.topics) ? data.topics : []),
    ].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return normalizeSearchText(parts.join(' · '));
  },
};

// A `video` block references a canonical `videos` row by `video_id` and carries
// a denormalized render snapshot (`youtube_id`, `title`, speakers) captured at
// author time, so the renderer stays a pure function (reuses the talk facade)
// while `video_id` remains the durable link for dedup/linkage. Curation
// overrides (worth_noting, quote, topics, accent) behave exactly like talk.
const videoKind: BlockKindDef = {
  kind: 'video',
  requireSlug: true,
  jsonSchema: {
    type: 'object',
    required: ['video_id', 'title'],
    properties: {
      video_id: { type: 'string', pattern: UUID_RE.source },
      ...talkKind.jsonSchema.properties,
    },
    additionalProperties: true,
  },
  searchText: talkKind.searchText,
};

export const BLOCK_KINDS: Record<string, BlockKindDef> = {
  html: htmlKind,
  talk: talkKind,
  video: videoKind,
};

// ── Write-layer entry points ────────────────────────────────────────────────

function utf8Bytes(s: string): number {
  // TextEncoder exists in Node >= 11 and every browser
  return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : s.length;
}

/**
 * Validate one block payload. `path` prefixes issue paths, e.g. "blocks[0]".
 * Returns all issues (never throws); an empty array means valid.
 */
export function validateBlock(block: BlockInput, path: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const def = BLOCK_KINDS[block.kind];
  if (!BLOCK_KIND_RE.test(block.kind ?? '')) {
    issues.push({ path: `${path}.kind`, keyword: 'pattern', message: 'invalid kind format' });
    return issues;
  }
  if (!def) {
    issues.push({ path: `${path}.kind`, keyword: 'kind_not_registered', message: `unknown kind '${block.kind}'` });
    return issues;
  }
  if (block.slug !== null && block.slug !== undefined && !BLOCK_SLUG_RE.test(block.slug)) {
    issues.push({ path: `${path}.slug`, keyword: 'slug_format', message: 'invalid slug format' });
  }
  if (def.requireSlug && !block.slug) {
    issues.push({ path: `${path}.slug`, keyword: 'slug_required', message: `kind '${block.kind}' requires a slug` });
  }
  if (!Number.isInteger(block.sort_order) || block.sort_order < 0) {
    issues.push({ path: `${path}.sort_order`, keyword: 'type', message: 'must be a non-negative integer' });
  }
  if (typeof block.data !== 'object' || block.data === null || Array.isArray(block.data)) {
    issues.push({ path: `${path}.data`, keyword: 'type', message: 'must be an object' });
    return issues;
  }
  if (block.kind !== 'html' && utf8Bytes(JSON.stringify(block.data)) > TYPED_DATA_MAX_BYTES) {
    issues.push({ path: `${path}.data`, keyword: 'payload_too_large', message: 'serialized data exceeds 256 KB' });
  }
  checkSchema(def.jsonSchema, block.data, `${path}.data`, issues);
  if (issues.length === 0 && def.extraChecks) {
    issues.push(...def.extraChecks(block.data, block.slug ?? null, path));
  }
  return issues;
}

/** Per-kind plain-text search projection (spec: Search → storage rule). */
export function projectSearchText(kind: string, data: Record<string, unknown>): string | null {
  return BLOCK_KINDS[kind]?.searchText(data) ?? null;
}

/** talk slug generation: lowercase, whitespace→dash, talk- prefix. */
export function generateTalkSlug(title: string, taken: Set<string>): string {
  const base = ('talk-' + title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''))
    .slice(0, 110).replace(/-$/, '');
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base}-${n++}`;
  return slug;
}

/**
 * Canonical item-version serialization: RFC 3339, microsecond precision, Z.
 * One function owns this; clients echo the string verbatim (spec: Canonical
 * item version). PostgREST returns UTC timestamps, so the fast path is a
 * lossless string normalization; anything else degrades via Date (ms).
 */
export function serializeItemVersion(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString().replace(/(\.\d{3})Z$/, (_, f) => `${f}000Z`);
  }
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00(?::?00)?)$/.exec(value.trim());
  if (m) {
    const frac = (m[3] ?? '').padEnd(6, '0').slice(0, 6);
    return `${m[1]}T${m[2]}.${frac}Z`;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('unparseable item version');
  return d.toISOString().replace(/(\.\d{3})Z$/, (_, f) => `${f}000Z`);
}

/** Kind metadata exposed by the resources_block_kinds MCP tool. */
export function describeKinds(): Array<{ kind: string; requireSlug: boolean; jsonSchema: Schema }> {
  return Object.values(BLOCK_KINDS).map((d) => ({
    kind: d.kind,
    requireSlug: d.requireSlug,
    jsonSchema: d.jsonSchema,
  }));
}
