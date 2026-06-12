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

interface DeclField {
  type?: 'text' | 'textarea' | 'richtext' | 'array' | 'number' | 'slot';
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
}

export function declarativeBlockEntry(opts: DeclarativeBlockOptions): EmailBlockEntry {
  const { schema, nodes } = parseTemplate(opts.source);
  const schemaMap = (schema ?? {}) as Record<string, DeclField>;

  const fields: Record<string, Field> = {};
  const defaultProps: Content = {};
  for (const [k, v] of Object.entries(schemaMap)) {
    fields[k] = toField(k, v);
    defaultProps[k] = defaultFor(v);
  }

  const Component = ((props: Content) => (
    <DeclarativeBlock nodes={nodes} content={props} />
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
