/**
 * validateContentSchema(schema) — checks a JSON Schema (the output of
 * compiling content/schema.ts or hand-authored content/schema.json)
 * against the structural requirements from spec-sites-theme-kinds §5.3.
 *
 * Pure function over a JSON Schema document. No filesystem or network IO.
 *
 * Required shape:
 *   - top-level type='object'
 *   - top-level properties.routes is an object
 *   - routes.properties (or routes.patternProperties) define per-route schemas
 *   - each per-route schema is itself a JSON Schema 2020-12 fragment
 *
 * Returns errors with a pointer + message; warnings for non-blocking quirks.
 */

export interface ContentSchemaIssue {
  code: string;
  message: string;
  /** JSON Pointer to the offending location, e.g. '/properties/routes/properties/~1about'. */
  pointer: string;
}

export interface ValidateContentSchemaResult {
  ok: boolean;
  errors: ContentSchemaIssue[];
  warnings: ContentSchemaIssue[];
  /** Discovered route patterns on success (e.g. ['/', '/about', '/for/:persona']). */
  routes: string[];
}

export function validateContentSchema(schema: unknown): ValidateContentSchemaResult {
  const errors: ContentSchemaIssue[] = [];
  const warnings: ContentSchemaIssue[] = [];
  const routes: string[] = [];

  if (!isPlainObject(schema)) {
    errors.push({
      code: 'templates.content_schema.not_object',
      message: 'Content schema must be a JSON Schema object literal at the top level.',
      pointer: '',
    });
    return { ok: false, errors, warnings, routes };
  }

  const s = schema as Record<string, unknown>;

  if (s['type'] !== 'object') {
    errors.push({
      code: 'templates.content_schema.top_level_not_object_type',
      message: `Top-level type must be 'object'; got ${JSON.stringify(s['type'])}.`,
      pointer: '/type',
    });
  }

  const props = s['properties'];
  if (!isPlainObject(props) || !('routes' in (props as Record<string, unknown>))) {
    errors.push({
      code: 'templates.content_schema.missing_routes_property',
      message: 'Top-level properties.routes is required (per spec §5.3).',
      pointer: '/properties/routes',
    });
    return { ok: false, errors, warnings, routes };
  }

  const routesSchema = (props as Record<string, unknown>)['routes'];
  if (!isPlainObject(routesSchema)) {
    errors.push({
      code: 'templates.content_schema.routes_not_object',
      message: 'properties.routes must be an object literal.',
      pointer: '/properties/routes',
    });
    return { ok: false, errors, warnings, routes };
  }

  const r = routesSchema as Record<string, unknown>;
  if (r['type'] !== 'object') {
    errors.push({
      code: 'templates.content_schema.routes_not_object_type',
      message: `properties.routes.type must be 'object'; got ${JSON.stringify(r['type'])}.`,
      pointer: '/properties/routes/type',
    });
  }

  // Routes can be enumerated via `properties` (literal route patterns) or
  // `patternProperties` (regex-matched). At least one must be present and
  // non-empty.
  const routeProps = r['properties'];
  const routePatternProps = r['patternProperties'];
  const hasLiteralRoutes = isPlainObject(routeProps) && Object.keys(routeProps as Record<string, unknown>).length > 0;
  const hasPatternRoutes = isPlainObject(routePatternProps) && Object.keys(routePatternProps as Record<string, unknown>).length > 0;

  if (!hasLiteralRoutes && !hasPatternRoutes) {
    errors.push({
      code: 'templates.content_schema.no_routes_declared',
      message: 'routes must declare at least one entry via properties or patternProperties.',
      pointer: '/properties/routes',
    });
    return { ok: false, errors, warnings, routes };
  }

  if (hasLiteralRoutes) {
    for (const [routePattern, routeSchema] of Object.entries(routeProps as Record<string, unknown>)) {
      routes.push(routePattern);
      if (!isPlainObject(routeSchema)) {
        errors.push({
          code: 'templates.content_schema.route_schema_not_object',
          message: `Route ${routePattern} schema must be an object literal.`,
          pointer: '/properties/routes/properties/' + escapeJsonPointer(routePattern),
        });
        continue;
      }
      const rs = routeSchema as Record<string, unknown>;
      if (rs['type'] !== 'object') {
        warnings.push({
          code: 'templates.content_schema.route_schema_non_object_type',
          message: `Route ${routePattern} type is ${JSON.stringify(rs['type'])}; spec recommends 'object' for editor compatibility.`,
          pointer: '/properties/routes/properties/' + escapeJsonPointer(routePattern) + '/type',
        });
      }
      // Validate the route pattern starts with /
      if (!routePattern.startsWith('/')) {
        errors.push({
          code: 'templates.content_schema.route_pattern_invalid',
          message: `Route pattern ${JSON.stringify(routePattern)} must start with '/'.`,
          pointer: '/properties/routes/properties/' + escapeJsonPointer(routePattern),
        });
      }
    }
  }

  if (hasPatternRoutes) {
    for (const [pattern, routeSchema] of Object.entries(routePatternProps as Record<string, unknown>)) {
      // Pattern keys are regexes; we surface them in the routes list as-is so
      // the editor's "create page" picker can show them with a "<regex>"
      // hint to the admin.
      routes.push(`<pattern:${pattern}>`);
      if (!isPlainObject(routeSchema)) {
        errors.push({
          code: 'templates.content_schema.route_pattern_schema_not_object',
          message: `patternProperties[${JSON.stringify(pattern)}] schema must be an object literal.`,
          pointer: '/properties/routes/patternProperties/' + escapeJsonPointer(pattern),
        });
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings, routes };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Escape a string for use as a single segment in a JSON Pointer per RFC 6901.
 * `/` becomes `~1`; `~` becomes `~0`.
 */
function escapeJsonPointer(s: string): string {
  return s.replace(/~/g, '~0').replace(/\//g, '~1');
}
