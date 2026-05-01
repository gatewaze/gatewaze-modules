/**
 * classifySchemaDrift(oldSchema, newSchema)
 *
 * Compares two content schemas (the JSON Schema documents stored in
 * templates_content_schemas.schema_json) and labels each detected change
 * as one of:
 *   - 'safe'                  → no migration needed; can auto-apply
 *   - 'potentially_breaking'  → existing content MAY not validate; admin click-through
 *   - 'definitely_breaking'   → existing content WILL fail; explicit migration required
 *
 * Pure function. No DB / network IO.
 *
 * Per spec-sites-theme-kinds §5.4:
 *   safe:                  added optional field, prose-only HTML change, new route
 *   potentially_breaking:  schema field made required, schema field removed (when
 *                          existing variants reference it), wrapper / route removed
 *   definitely_breaking:   schema validation against an existing instance fails
 *
 * The "validate against existing instance" check requires DB access and
 * lives in a separate function (validateInstancesAgainstNewSchema). This
 * classifier works statically over the two schemas.
 */

export type DriftSeverity = 'safe' | 'potentially_breaking' | 'definitely_breaking';

export interface SchemaDriftItem {
  severity: DriftSeverity;
  /** Stable code for filtering / metric grouping. */
  code: string;
  /** Human-readable description of the change. */
  message: string;
  /** JSON Pointer to the affected schema location (best-effort). */
  pointer: string;
}

export interface ClassifySchemaDriftResult {
  /** Aggregate severity = max severity across all items. */
  overall: DriftSeverity;
  items: SchemaDriftItem[];
}

export function classifySchemaDrift(
  oldSchema: Record<string, unknown> | null,
  newSchema: Record<string, unknown>,
): ClassifySchemaDriftResult {
  const items: SchemaDriftItem[] = [];

  if (oldSchema === null) {
    return {
      overall: 'safe',
      items: [
        {
          severity: 'safe',
          code: 'templates.drift.initial_apply',
          message: 'Initial schema apply (no prior version).',
          pointer: '',
        },
      ],
    };
  }

  diffObject(oldSchema, newSchema, '', items, /* parentRequired */ false);

  const overall = aggregateSeverity(items);
  return { overall, items };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function diffObject(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  pointer: string,
  out: SchemaDriftItem[],
  _parentRequired: boolean,
): void {
  // Type change?
  const aType = a['type'];
  const bType = b['type'];
  if (aType !== bType && aType !== undefined && bType !== undefined) {
    out.push({
      severity: 'definitely_breaking',
      code: 'templates.drift.type_changed',
      message: `Type changed from ${JSON.stringify(aType)} to ${JSON.stringify(bType)}.`,
      pointer: pointer + '/type',
    });
  }

  // x-gatewaze-personalize axes change
  const aAxes = a['x-gatewaze-personalize'];
  const bAxes = b['x-gatewaze-personalize'];
  if (Array.isArray(aAxes) && Array.isArray(bAxes)) {
    const aSet = new Set(aAxes as string[]);
    const bSet = new Set(bAxes as string[]);
    for (const axis of aSet) {
      if (!bSet.has(axis)) {
        out.push({
          severity: 'safe',
          code: 'templates.drift.personalization_axis_removed',
          message: `Personalization axis ${JSON.stringify(axis)} removed (less personalization).`,
          pointer: pointer + '/x-gatewaze-personalize',
        });
      }
    }
    for (const axis of bSet) {
      if (!aSet.has(axis)) {
        out.push({
          severity: 'potentially_breaking',
          code: 'templates.drift.personalization_axis_added',
          message: `Personalization axis ${JSON.stringify(axis)} added; existing variants may not match the new axis grammar.`,
          pointer: pointer + '/x-gatewaze-personalize',
        });
      }
    }
  }

  // properties: added / removed / changed
  const aProps = (a['properties'] ?? {}) as Record<string, unknown>;
  const bProps = (b['properties'] ?? {}) as Record<string, unknown>;
  const aRequired = new Set<string>(Array.isArray(a['required']) ? (a['required'] as string[]) : []);
  const bRequired = new Set<string>(Array.isArray(b['required']) ? (b['required'] as string[]) : []);

  // Removed properties
  for (const key of Object.keys(aProps)) {
    if (!(key in bProps)) {
      const wasRequired = aRequired.has(key);
      out.push({
        severity: wasRequired ? 'definitely_breaking' : 'potentially_breaking',
        code: wasRequired ? 'templates.drift.required_field_removed' : 'templates.drift.optional_field_removed',
        message: `Field ${JSON.stringify(key)} ${wasRequired ? '(required)' : '(optional)'} removed.`,
        pointer: pointer + '/properties/' + escapePointer(key),
      });
    }
  }

  // Added properties
  for (const key of Object.keys(bProps)) {
    if (!(key in aProps)) {
      const isRequired = bRequired.has(key);
      out.push({
        severity: isRequired ? 'definitely_breaking' : 'safe',
        code: isRequired ? 'templates.drift.required_field_added' : 'templates.drift.optional_field_added',
        message: `Field ${JSON.stringify(key)} added ${isRequired ? '(required — existing content will fail validation)' : '(optional)'}.`,
        pointer: pointer + '/properties/' + escapePointer(key),
      });
    }
  }

  // Required-flag flips on existing properties
  for (const key of Object.keys(aProps)) {
    if (key in bProps) {
      const wasReq = aRequired.has(key);
      const isReq = bRequired.has(key);
      if (!wasReq && isReq) {
        out.push({
          severity: 'definitely_breaking',
          code: 'templates.drift.field_made_required',
          message: `Field ${JSON.stringify(key)} changed from optional to required.`,
          pointer: pointer + '/required',
        });
      } else if (wasReq && !isReq) {
        out.push({
          severity: 'safe',
          code: 'templates.drift.field_made_optional',
          message: `Field ${JSON.stringify(key)} changed from required to optional.`,
          pointer: pointer + '/required',
        });
      }
    }
  }

  // Recurse into shared properties
  for (const key of Object.keys(aProps)) {
    if (!(key in bProps)) continue;
    const aP = aProps[key];
    const bP = bProps[key];
    if (isPlainObject(aP) && isPlainObject(bP)) {
      diffObject(
        aP as Record<string, unknown>,
        bP as Record<string, unknown>,
        pointer + '/properties/' + escapePointer(key),
        out,
        bRequired.has(key),
      );
    }
  }

  // Recurse into items (array element schemas)
  const aItems = a['items'];
  const bItems = b['items'];
  if (isPlainObject(aItems) && isPlainObject(bItems)) {
    diffObject(
      aItems as Record<string, unknown>,
      bItems as Record<string, unknown>,
      pointer + '/items',
      out,
      false,
    );
  }
}

function aggregateSeverity(items: SchemaDriftItem[]): DriftSeverity {
  let worst: DriftSeverity = 'safe';
  for (const it of items) {
    if (it.severity === 'definitely_breaking') return 'definitely_breaking';
    if (it.severity === 'potentially_breaking') worst = 'potentially_breaking';
  }
  return worst;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function escapePointer(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}
