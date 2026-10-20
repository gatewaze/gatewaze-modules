/**
 * The starting value of a declarative block field, from its SCHEMA entry.
 *
 * Extracted from admin/components/puck/email-blocks/declarative/from-template.tsx
 * so the cadence worker (server side, no Puck, no React) seeds a new edition
 * with exactly the content dragging the block from the palette would give.
 * from-template.tsx re-exports this so the two cannot drift.
 */

export interface SchemaFieldDef {
  type?: 'text' | 'textarea' | 'richtext' | 'array' | 'number' | 'slot' | 'image' | 'boolean';
  default?: unknown;
  fields?: Record<string, SchemaFieldDef>;
  [k: string]: unknown;
}

export function defaultFor(def: SchemaFieldDef): unknown {
  // Boolean toggles round-trip as the strings 'true'/'false' (see toField),
  // so normalise the default to a matching string regardless of how it was
  // written in the schema (true / "true" / omitted → 'true'; false → 'false').
  if (def.type === 'boolean') return def.default === false || def.default === 'false' ? 'false' : 'true';
  if (def.default !== undefined) return def.default;
  if (def.type === 'array' || def.type === 'slot') return [];
  if (def.type === 'number') return 0;
  return '';
}

export function defaultsFor(fields: Record<string, SchemaFieldDef> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields ?? {})) {
    if (v && typeof v === 'object') out[k] = defaultFor(v as SchemaFieldDef);
  }
  return out;
}
