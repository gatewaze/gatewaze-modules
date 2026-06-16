/**
 * Turn a declarative block source (html-ish + SCHEMA) into an EmailBlockEntry,
 * so a git-authored block plugs into exactly the same registry the hand-coded
 * react-email blocks use — same editor, same export, same publish path.
 *
 * The SCHEMA comment is a flat field map (close to Puck's field config):
 *   { "title":   { "type": "text",     "label": "Title" },
 *     "body":    { "type": "richtext", "label": "Body"  },
 *     "links":   { "type": "array",    "label": "Links",
 *                  "fields": { "title": {"type":"text"}, "url": {"type":"text"} } } }
 */

import type { Field } from '@puckeditor/core';
import type { EmailBlockEntry } from '../registry-types.js';
import { parseTemplate } from './parse-template.js';
import { DeclarativeBlock, type Content } from './render.js';
import { NewsletterImageFieldAdapter } from '../image-field-adapter.js';

interface DeclField {
  type?: 'text' | 'textarea' | 'richtext' | 'array' | 'number' | 'slot' | 'image';
  label?: string;
  fields?: Record<string, DeclField>;
  default?: unknown;
}

function titleCase(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function toField(key: string, def: DeclField): Field {
  const label = def.label ?? titleCase(key);
  switch (def.type) {
    case 'richtext':
      return { type: 'richtext', label } as Field;
    case 'textarea':
      return { type: 'textarea', label } as Field;
    case 'number':
      return { type: 'number', label } as Field;
    case 'slot':
      // Puck slot field — entryHasSlot() looks for a `children` field of this
      // type; the renderer's <slot> element fills it.
      return { type: 'slot', label } as Field;
    case 'image':
      // Drag-drop / choose-file / paste-URL uploader (host-media → CDN URL),
      // the same field every hand-coded image block uses. Edited in the
      // sidebar, not inline.
      return { type: 'custom', label, render: NewsletterImageFieldAdapter as never } as Field;
    case 'array': {
      const arrayFields: Record<string, Field> = {};
      const sub = def.fields ?? {};
      for (const [k, v] of Object.entries(sub)) arrayFields[k] = toField(k, v);
      return { type: 'array', label, arrayFields, defaultItemProps: defaultsFor(sub) } as Field;
    }
    default:
      return { type: 'text', label } as Field;
  }
}

function defaultFor(def: DeclField): unknown {
  if (def.default !== undefined) return def.default;
  if (def.type === 'array' || def.type === 'slot') return [];
  if (def.type === 'number') return 0;
  return '';
}

function defaultsFor(fields: Record<string, DeclField>): Content {
  const out: Content = {};
  for (const [k, v] of Object.entries(fields)) out[k] = defaultFor(v);
  return out;
}

export interface DeclarativeBlockOptions {
  componentId: string;
  label: string;
  category?: string;
  /** The html-ish block source (SCHEMA comment + element tree). */
  source: string;
  /**
   * Field schema, used when the SCHEMA comment was already stripped from
   * the source before it reached the editor — e.g. the server-side
   * `templates_apply_source` RPC extracts the comment into the
   * `templates_block_defs.schema` JSONB column and stores only the body
   * HTML in `html`. Wins over any schema parseTemplate manages to
   * recover from the source. When omitted the parsed source is the
   * authority (legacy + test usage).
   */
  schema?: Record<string, unknown>;
}

export function declarativeBlockEntry(opts: DeclarativeBlockOptions): EmailBlockEntry {
  const { schema: parsedSchema, nodes } = parseTemplate(opts.source);
  const schemaMap = (opts.schema ?? parsedSchema ?? {}) as Record<string, DeclField>;

  const fields: Record<string, Field> = {};
  const defaultProps: Content = {};
  // Inline-editable field keys (text / textarea / richtext, plus the bare-text
  // default). An empty one of these stays visible in the editor even behind an
  // `if` guard, so the operator can click in and fill it.
  const editableFields = new Set<string>();
  for (const [k, v] of Object.entries(schemaMap)) {
    fields[k] = toField(k, v);
    defaultProps[k] = defaultFor(v);
    if (v.type === undefined || v.type === 'text' || v.type === 'textarea' || v.type === 'richtext') {
      editableFields.add(k);
    }
  }

  const Component = ((props: Content) => (
    <DeclarativeBlock nodes={nodes} content={props} editableFields={editableFields} />
  )) as EmailBlockEntry['Component'];

  return {
    componentId: opts.componentId,
    label: opts.label,
    ...(opts.category ? { category: opts.category } : {}),
    fields,
    defaultProps: defaultProps as never,
    Component,
  };
}
