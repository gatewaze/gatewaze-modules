/**
 * Validate a DATA_SOURCE marker of kind "research" at ingest.
 *
 * The apply RPC persists whatever the parser hands it, so the shape is
 * checked here, where the author sees the error against their block file:
 * unknown input/transform kinds, an output field that is not in SCHEMA, a
 * `daily` schedule anywhere a recipe appears (that is daily AI spend), a
 * recipe step with no use case. Returns human-readable messages; an empty
 * list means valid. Pure.
 */

import type { BlockDefDataSourceResearch } from '../../types/index.js';

const INPUT_KINDS = new Set(['discovery_posts', 'recipe']);
const TRANSFORM_KINDS = new Set(['template', 'recipe']);
const SCHEDULES = new Set(['edition', 'daily', 'manual']);
const OUTPUT_FORMATS = new Set(['array', 'richtext', 'text']);
// Research recipes are a named family: a template author may only point a
// block at a use case created for newsletter research, not at any ai_use_cases row.
const USE_CASE_RX = /^newsletter-[a-z0-9_-]{1,90}$/;
const FIELD_RX = /^[a-z][a-z0-9_]{0,63}$/;
// Content keys the editor and renderer own; a research binding may not write them.
const RESERVED_FIELDS = new Set(['research_edits', 'children', '_gate_audience', '_gate_tier', '_gate_placeholder']);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scalarMap(v: unknown): boolean {
  return isObj(v) && Object.keys(v).length <= 20 && Object.entries(v).every(([k, x]) => /^[a-z_][a-z0-9_]{0,63}$/.test(k) && (typeof x === 'string' ? x.length <= 2000 : typeof x === 'number' || typeof x === 'boolean'));
}

/** True when the marker declares a research binding (so the other checks apply). */
export function isResearchBinding(ds: unknown): ds is BlockDefDataSourceResearch {
  return isObj(ds) && ds.kind === 'research';
}

/**
 * @param ds      the parsed DATA_SOURCE payload
 * @param schema  the block's SCHEMA (field name → def), to check output.field
 */
export function validateResearchBinding(ds: unknown, schema: Record<string, unknown>): string[] {
  const errors: string[] = [];
  if (!isObj(ds) || ds.kind !== 'research') return ['DATA_SOURCE kind must be "research"'];

  // input
  const input = ds.input;
  if (!isObj(input) || typeof input.kind !== 'string' || !INPUT_KINDS.has(input.kind)) {
    errors.push(`input.kind must be one of ${[...INPUT_KINDS].join(', ')}`);
  } else if (input.kind === 'recipe') {
    if (typeof input.use_case !== 'string' || !USE_CASE_RX.test(input.use_case)) errors.push('input.use_case is required for a recipe input and must be a newsletter-* use case id');
    if (input.params !== undefined && !scalarMap(input.params)) errors.push('input.params must be an object of strings, numbers and booleans');
  } else {
    if (input.window !== undefined && input.window !== 'since_previous_edition' && !(isObj(input.window) && Number.isInteger(input.window.days) && (input.window.days as number) > 0 && (input.window.days as number) <= 90)) {
      errors.push('input.window must be "since_previous_edition" or { "days": 1..90 }');
    }
    if (input.foundations !== undefined && input.foundations !== 'all' && !(Array.isArray(input.foundations) && input.foundations.every((f) => typeof f === 'string'))) {
      errors.push('input.foundations must be "all" or a list of foundation labels');
    }
    if (input.publish_states !== undefined && !(Array.isArray(input.publish_states) && input.publish_states.every((f) => typeof f === 'string'))) {
      errors.push('input.publish_states must be a list of publish states');
    }
  }

  // transform (optional; default template)
  const transform = ds.transform;
  let transformIsRecipe = false;
  if (transform !== undefined) {
    if (!isObj(transform) || typeof transform.kind !== 'string' || !TRANSFORM_KINDS.has(transform.kind)) {
      errors.push(`transform.kind must be one of ${[...TRANSFORM_KINDS].join(', ')}`);
    } else if (transform.kind === 'recipe') {
      transformIsRecipe = true;
      if (typeof transform.use_case !== 'string' || !USE_CASE_RX.test(transform.use_case)) errors.push('transform.use_case is required for a recipe transform and must be a newsletter-* use case id');
      if (transform.params !== undefined && !scalarMap(transform.params)) errors.push('transform.params must be an object of strings, numbers and booleans');
    } else {
      for (const k of ['max_items', 'max_per_group'] as const) {
        if (transform[k] !== undefined && !(Number.isInteger(transform[k]) && (transform[k] as number) > 0 && (transform[k] as number) <= 500)) errors.push(`transform.${k} must be an integer 1..500`);
      }
      if (transform.group_by !== undefined && transform.group_by !== 'foundation' && transform.group_by !== 'project') errors.push('transform.group_by must be "foundation" or "project"');
    }
  }

  // output
  const output = ds.output;
  if (!isObj(output) || typeof output.field !== 'string' || !FIELD_RX.test(output.field)) {
    errors.push('output.field is required (a SCHEMA field name)');
  } else if (RESERVED_FIELDS.has(output.field)) {
    errors.push(`output.field "${output.field}" is reserved`);
  } else if (!Object.hasOwn(schema, output.field)) {
    // Own keys only: `in` would accept "constructor", "toString" and friends.
    errors.push(`output.field "${output.field}" is not a field in SCHEMA`);
  } else if (output.format !== undefined && (typeof output.format !== 'string' || !OUTPUT_FORMATS.has(output.format))) {
    errors.push(`output.format must be one of ${[...OUTPUT_FORMATS].join(', ')}`);
  } else if (output.format === undefined) {
    // Every reader and the worker take the format from the binding and
    // default to 'array' (newsletters lib/research-merge researchOutputFormat),
    // so a non-array field must say what it is.
    const def = schema[output.field];
    const type = isObj(def) ? def.type : undefined;
    if (type !== 'array') errors.push(`output.format is required for the ${typeof type === 'string' ? type : 'non-array'} field "${output.field}" (one of ${[...OUTPUT_FORMATS].join(', ')})`);
  }

  // schedule
  const schedule = ds.schedule ?? 'edition';
  if (typeof schedule !== 'string' || !SCHEDULES.has(schedule)) {
    errors.push(`schedule must be one of ${[...SCHEDULES].join(', ')}`);
  } else if (schedule === 'daily' && ((isObj(input) && input.kind === 'recipe') || transformIsRecipe)) {
    errors.push('schedule "daily" is not allowed when a recipe is involved (that is daily AI spend); use "edition" or "manual"');
  }

  return errors;
}
