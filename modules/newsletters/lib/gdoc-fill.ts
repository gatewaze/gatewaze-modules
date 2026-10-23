/**
 * Fill an existing edition's blocks from a Google Doc: the pure parts.
 *
 *   parseGoogleDocId   a Docs URL (or a bare id) → the document id
 *   cleanDocHtml       Google's HTML export → compact HTML the model can read
 *   buildFillPrompt    the edition's blocks + the doc → one prompt
 *   validateProposal   the model's JSON → only fields each block's schema has,
 *                      each value coerced to its field type and sanitised
 *
 * Nothing here talks to the network or the database, so the route
 * (api/gdoc-fill-routes.ts) stays thin and this file is unit-tested.
 */

import { sanitizeInline, stripTags } from './sanitize-inline.js';
import type { SchemaFieldDef } from './schema-defaults.js';

/** Google Docs ids are base64url-ish and 25+ characters. */
const DOC_ID = /^[A-Za-z0-9_-]{25,100}$/;

export function parseGoogleDocId(input: string): string | null {
  const s = String(input ?? '').trim();
  if (!s) return null;
  if (DOC_ID.test(s)) return s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com') return null;
  const m = /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{25,100})(?:\/|$)/.exec(url.pathname);
  return m ? m[1] : null;
}

/** Google's export wraps every link in https://www.google.com/url?q=<real>&sa=… */
function unwrapGoogleRedirect(href: string): string {
  try {
    const u = new URL(href.replace(/&amp;/g, '&'));
    if ((u.hostname === 'www.google.com' || u.hostname === 'google.com') && u.pathname === '/url') {
      const q = u.searchParams.get('q');
      if (q) return q;
    }
  } catch {
    // not a URL; returned as is
  }
  return href.replace(/&amp;/g, '&');
}

/**
 * Reduce Google's HTML export to the structure that carries meaning:
 * headings, paragraphs, lists, bold, italic, links and image sources. The
 * export marks bold and italic with class-based CSS on spans, so those spans
 * are turned into <strong>/<em> (by reading the stylesheet) before every
 * class and style attribute is dropped.
 */
export function cleanDocHtml(raw: string, maxChars = 180_000): string {
  let html = String(raw ?? '');
  const styleBlock = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) ?? [])[1] ?? '';
  const boldClasses = new Set<string>();
  const italicClasses = new Set<string>();
  for (const m of styleBlock.matchAll(/\.([A-Za-z0-9_-]+)\{([^}]*)\}/g)) {
    if (/font-weight:\s*(700|bold)/.test(m[2])) boldClasses.add(m[1]);
    if (/font-style:\s*italic/.test(m[2])) italicClasses.add(m[1]);
  }
  const body = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  html = body ? body[1] : html;
  // Repeat until nothing changes, so a removal can't join the pieces of a new
  // <script> or comment together (e.g. "<scr<script></script>ipt>").
  let prevHtml: string;
  do {
    prevHtml = html;
    html = html
      .replace(/<(script|style|head|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  } while (html !== prevHtml);
  // An unclosed <script (no </script>) survives the loop; escape the "<" of
  // any that is left. A single-character replacement can't create a new match.
  html = html.replace(/<(?=\/?(?:script|style|head|noscript)\b)/gi, '&lt;');
  // Spans: bold/italic by class or inline style, otherwise unwrapped.
  html = html.replace(/<span([^>]*)>([\s\S]*?)<\/span>/gi, (_m, attrs: string, inner: string) => {
    const classes = (/class="([^"]*)"/i.exec(attrs)?.[1] ?? '').split(/\s+/);
    const style = /style="([^"]*)"/i.exec(attrs)?.[1] ?? '';
    const bold = classes.some((c) => boldClasses.has(c)) || /font-weight:\s*(700|bold)/.test(style);
    const italic = classes.some((c) => italicClasses.has(c)) || /font-style:\s*italic/.test(style);
    let out = inner;
    if (italic && out.trim()) out = `<em>${out}</em>`;
    if (bold && out.trim()) out = `<strong>${out}</strong>`;
    return out;
  });
  // Links: keep only the real target.
  html = html.replace(/<a\b([^>]*)>/gi, (_m, attrs: string) => {
    const href = /href="([^"]*)"/i.exec(attrs)?.[1];
    return href ? `<a href="${unwrapGoogleRedirect(href).replace(/"/g, '%22')}">` : '<a>';
  });
  // Images: keep the source only.
  html = html.replace(/<img\b([^>]*)>/gi, (_m, attrs: string) => {
    const src = /src="([^"]*)"/i.exec(attrs)?.[1];
    return src && /^https:\/\//i.test(src) ? `<img src="${src.replace(/"/g, '%22')}">` : '';
  });
  // Every other tag: drop all attributes.
  html = html.replace(/<(\/?)(h[1-6]|p|ul|ol|li|table|tr|td|th|tbody|thead|br|hr|strong|em|b|i|u|div|sup|sub)\b[^>]*>/gi, '<$1$2>');
  html = html
    .replace(/<(p|li|h[1-6]|td|div)>\s*<\/\1>/gi, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return html.length > maxChars ? html.slice(0, maxChars) : html;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export interface FillTargetBlock {
  id: string;
  block_type: string;
  name: string;
  description?: string | null;
  schema: Record<string, SchemaFieldDef>;
  /** For research blocks: the field research writes, so the model knows it may fill it. */
  research_field?: string | null;
}

export interface FillLibraryBlock {
  block_type: string;
  name: string;
  description?: string | null;
  schema: Record<string, SchemaFieldDef>;
}

function describeFields(schema: Record<string, SchemaFieldDef>, indent = '    '): string {
  return Object.entries(schema ?? {})
    .filter(([, d]) => d && d.type !== 'slot')
    .map(([k, d]) => {
      const label = typeof d.label === 'string' ? ` — ${d.label}` : '';
      if (d.type === 'array') {
        return `${indent}${k} (list of objects)${label}\n${describeFields(d.fields ?? {}, `${indent}  `)}`;
      }
      return `${indent}${k} (${d.type ?? 'text'})${label}`;
    })
    .join('\n');
}

export function buildFillPrompt(opts: {
  docHtml: string;
  blocks: FillTargetBlock[];
  library: FillLibraryBlock[];
  /** When the draft was split: this is part `index` (1-based) of `total`. */
  part?: { index: number; total: number };
}): string {
  const slots = opts.blocks
    .map((b, i) => [
      `${i + 1}. block_id "${b.id}" — type "${b.block_type}" (${b.name})${b.research_field ? ` [research block; its "${b.research_field}" field is normally filled automatically]` : ''}`,
      b.description ? `   ${b.description}` : '',
      '   fields:',
      describeFields(b.schema),
    ].filter(Boolean).join('\n'))
    .join('\n\n');
  const present = new Set(opts.blocks.map((b) => b.block_type));
  const extra = opts.library
    .filter((d) => !present.has(d.block_type))
    .map((d) => [`- type "${d.block_type}" (${d.name})`, d.description ? `  ${d.description}` : '', '  fields:', describeFields(d.schema, '    ')].filter(Boolean).join('\n'))
    .join('\n');

  return `You are filling a newsletter edition from the editor's draft, which is a Google Doc (given below as HTML).

The edition already has these blocks, in this order:

${slots || '(none)'}

${extra ? `Block types that are not in the edition yet, which you may propose adding for a section that fits none of the blocks above:\n\n${extra}\n\n` : ''}${opts.part && opts.part.total > 1 ? `The draft is long, so you are given PART ${opts.part.index} OF ${opts.part.total}. Map only the sections in this part. Other parts are mapped separately and merged afterwards, so it is fine to use a block that another part may also use.${opts.part.index > 1 ? ' Return null for subject and preheader.' : ''}\n\n` : ''}THE DRAFT (HTML):
${opts.docHtml}

INSTRUCTIONS
1. Read the draft section by section. Put each section's content into the block whose purpose matches it best. Use each existing block_id at most once.
2. Copy the editor's wording exactly. Do not rewrite, shorten, summarise or add content. Leave out anything the draft does not contain.
3. Use only the field names listed for that block. For a "list of objects" field, give a list with one object per item in the draft section, using the listed sub-fields.
4. "richtext" fields take simple HTML: <p>, <strong>, <em>, <ul>, <ol>, <li>, <br> and <a href="https://...">. "text" fields take plain text with no HTML.
5. Keep every link: put a story's main link in its url field and keep inline links in richtext.
6. Only fill a section label field (often called "eyebrow") if the draft gives a different label.
7. If a section fits none of the existing blocks, either propose one of the types that is not in the edition yet (with target_block_id null) or list it in "unmapped".
8. If the draft names a subject line or preheader for the email, return them; otherwise return null.

Return ONLY valid JSON, with no prose before or after it and no code fence. Write it compactly, without indentation or line breaks between fields:
{
  "subject": "string or null",
  "preheader": "string or null",
  "blocks": [
    { "target_block_id": "an existing block_id, or null for a new block", "block_type": "the block's type", "source_heading": "the draft section this came from", "content": { "field": "value" } }
  ],
  "unmapped": [ { "heading": "string", "reason": "string" } ]
}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface FillProposalBlock {
  target_block_id: string | null;
  block_type: string;
  source_heading: string | null;
  content: Record<string, unknown>;
}

export interface FillProposal {
  subject: string | null;
  preheader: string | null;
  blocks: FillProposalBlock[];
  unmapped: Array<{ heading: string; reason: string }>;
}

const MAX_ITEMS = 50;
const MAX_TEXT = 2_000;
const MAX_RICH = 20_000;

/** Schemes that run code if a template ever puts the value in an href or src. */
const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file):/i;

function coerceText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const t = stripTags(String(v)).replace(/\s+/g, ' ').trim();
  if (DANGEROUS_SCHEME.test(t)) return null;
  return t ? t.slice(0, MAX_TEXT) : null;
}

function coerceUrl(v: unknown): string | null {
  const t = coerceText(v);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** A field is a URL field when its name or label says so; those keep only http(s)/mailto URLs. */
function isUrlField(name: string, def: SchemaFieldDef): boolean {
  const label = typeof def.label === 'string' ? def.label : '';
  return /(^|_)(url|href|link)$/i.test(name) || /^(link|url)\b/i.test(label);
}

/** Coerce one value to its schema field. Returns undefined to drop the field. */
export function coerceField(name: string, def: SchemaFieldDef, v: unknown, depth = 0): unknown {
  switch (def.type) {
    case 'array': {
      if (!Array.isArray(v) || depth > 2) return undefined;
      const sub = def.fields ?? {};
      const items = v.slice(0, MAX_ITEMS)
        .map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? coerceObject(sub, item as Record<string, unknown>, depth + 1) : null))
        .filter((item): item is Record<string, unknown> => !!item && Object.keys(item).length > 0);
      return items;
    }
    case 'richtext': {
      if (typeof v !== 'string') return undefined;
      const html = sanitizeInline(v.slice(0, MAX_RICH), { allowAnchors: true }).trim();
      return html || undefined;
    }
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      return v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : undefined;
    case 'image': {
      const u = coerceUrl(v);
      return u && u.startsWith('https://') ? u : undefined;
    }
    case 'slot':
      return undefined;
    default: {
      const t = isUrlField(name, def) ? coerceUrl(v) : coerceText(v);
      return t ?? undefined;
    }
  }
}

function coerceObject(schema: Record<string, SchemaFieldDef>, obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, def] of Object.entries(schema)) {
    if (!(k in obj)) continue;
    const c = coerceField(k, def ?? {}, obj[k], depth);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

function extractJson(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const candidate = fenced ? fenced[1] : t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

/**
 * Turn the model's reply into a proposal the editor can trust: unknown
 * block ids and types are dropped, an existing block is used once, every
 * field is checked against that block's schema.
 */
export function validateProposal(
  replyText: string,
  blocks: FillTargetBlock[],
  library: FillLibraryBlock[],
): FillProposal {
  const raw = extractJson(replyText) as Record<string, unknown>;
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const byType = new Map(library.map((d) => [d.block_type, d]));
  const used = new Set<string>();
  const out: FillProposal = {
    subject: coerceText(raw?.subject),
    preheader: coerceText(raw?.preheader),
    blocks: [],
    unmapped: [],
  };
  for (const item of Array.isArray(raw?.blocks) ? raw.blocks.slice(0, 100) : []) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const targetId = typeof rec.target_block_id === 'string' ? rec.target_block_id : null;
    const content = rec.content && typeof rec.content === 'object' && !Array.isArray(rec.content) ? rec.content as Record<string, unknown> : {};
    let schema: Record<string, SchemaFieldDef> | null = null;
    let blockType: string | null = null;
    let target: string | null = null;
    if (targetId && byId.has(targetId) && !used.has(targetId)) {
      const b = byId.get(targetId)!;
      schema = b.schema;
      blockType = b.block_type;
      target = targetId;
      used.add(targetId);
    } else if (!targetId && typeof rec.block_type === 'string' && byType.has(rec.block_type)) {
      schema = byType.get(rec.block_type)!.schema;
      blockType = rec.block_type;
    }
    if (!schema || !blockType) continue;
    const coerced = coerceObject(schema, content, 0);
    if (Object.keys(coerced).length === 0) continue;
    out.blocks.push({ target_block_id: target, block_type: blockType, source_heading: coerceText(rec.source_heading), content: coerced });
  }
  for (const u of Array.isArray(raw?.unmapped) ? raw.unmapped.slice(0, 50) : []) {
    const rec = (u ?? {}) as Record<string, unknown>;
    const heading = coerceText(rec.heading);
    if (heading) out.unmapped.push({ heading, reason: coerceText(rec.reason) ?? '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Long documents: split into parts, map the parts in parallel, merge.
// One model call per document ran out of output room on a real 3,700-word
// draft (162 links): copying that much content verbatim into JSON needs more
// than one reply can hold, and took minutes. Parts of a few sections each
// keep every reply small, and run side by side.
// ---------------------------------------------------------------------------

/**
 * Split cleaned doc HTML at its headings into parts of at most `maxChars`
 * (a single section longer than that is split at paragraph and list-item
 * boundaries). Whatever comes before the first heading (title, subject,
 * preheader notes) is kept at the front of the first part.
 */
export function splitDocSections(html: string, maxChars = 9_000): string[] {
  const pieces = html.split(/(?=<h[1-4]>)/i).map((p) => p.trim()).filter(Boolean);
  const sized: string[] = [];
  for (const p of pieces) {
    if (p.length <= maxChars) { sized.push(p); continue; }
    // Oversized section: break between block elements, repeating its heading.
    const heading = /^<h[1-4]>[\s\S]*?<\/h[1-4]>/i.exec(p)?.[0] ?? '';
    const body = heading ? p.slice(heading.length) : p;
    const blocks = body.split(/(?<=<\/(?:p|li|ul|ol|table|div)>)/i);
    let cur = heading;
    for (const b of blocks) {
      if (cur.length + b.length > maxChars && cur.length > heading.length) {
        sized.push(cur);
        cur = heading ? `${heading}<p><em>(continued)</em></p>` : '';
      }
      cur += b;
    }
    if (cur.replace(heading, '').trim()) sized.push(cur);
  }
  const parts: string[] = [];
  let cur = '';
  for (const s of sized) {
    if (cur && cur.length + s.length > maxChars) { parts.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + s;
  }
  if (cur) parts.push(cur);
  return parts;
}

function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return false;
}

const MAX_MERGED_ITEMS = 120;

/**
 * Merge the proposals of several parts, in document order. Two parts that
 * fill the same existing block (or the same new block type) are joined: list
 * fields are concatenated, any other field keeps the first non-empty value.
 * Subject and preheader come from the first part that has them.
 */
export function mergeProposals(parts: FillProposal[]): FillProposal {
  const out: FillProposal = { subject: null, preheader: null, blocks: [], unmapped: [] };
  const index = new Map<string, FillProposalBlock>();
  for (const p of parts) {
    out.subject = out.subject ?? p.subject;
    out.preheader = out.preheader ?? p.preheader;
    out.unmapped.push(...p.unmapped);
    for (const b of p.blocks) {
      const key = b.target_block_id ? `id:${b.target_block_id}` : `new:${b.block_type}`;
      const prev = index.get(key);
      if (!prev) {
        const copy: FillProposalBlock = { ...b, content: { ...b.content } };
        index.set(key, copy);
        out.blocks.push(copy);
        continue;
      }
      for (const [k, v] of Object.entries(b.content)) {
        const cur = prev.content[k];
        if (Array.isArray(cur) && Array.isArray(v)) prev.content[k] = [...cur, ...v].slice(0, MAX_MERGED_ITEMS);
        else if (isEmptyValue(cur) && !isEmptyValue(v)) prev.content[k] = v;
      }
      if (!prev.source_heading && b.source_heading) prev.source_heading = b.source_heading;
      else if (b.source_heading && prev.source_heading && !prev.source_heading.includes(b.source_heading)) {
        prev.source_heading = `${prev.source_heading}; ${b.source_heading}`.slice(0, 300);
      }
    }
  }
  return out;
}
