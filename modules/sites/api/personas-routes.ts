/**
 * Site-personas admin endpoints.
 *
 * Per spec-example-theme-deliverable.md §5.2 and the data model added in
 * migrations/037_site_personas_and_page_variants.sql.
 *
 * Personas are named segments per site (Developer, Enterprise buyer, …)
 * with resolution rules (URL params, UTM tags, self-select). They are
 * the editor-managed source of truth for which segment a request
 * resolves to — replacing the static `theme.json.personas` list.
 *
 *   POST   /admin/sites/:id/personas              — create
 *   GET    /admin/sites/:id/personas              — list
 *   GET    /admin/sites/:id/personas/:personaId   — fetch
 *   PATCH  /admin/sites/:id/personas/:personaId   — update
 *   DELETE /admin/sites/:id/personas/:personaId   — delete
 *   POST   /admin/sites/:id/personas/test-resolve — resolve against a
 *                                                   sample RenderContext;
 *                                                   used by the admin
 *                                                   "test rules" UI
 *
 * Mounted by sites/api/register-routes.ts on the admin router (JWT-protected
 * upstream).
 */

import type { Request, Response, Router } from 'express';
import { canonicalizeRenderContext, type RenderContextFlat } from '../lib/runtime/render-context.js';

interface RequestWithUser extends Request {
  user?: { id: string };
}

interface ErrorEnvelope {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

// Canonical axes drawn from the RenderContext spec. Open-set design —
// adding a new axis here (after adding it to the canonicaliser) makes
// it instantly usable in persona conditions AND variant match contexts
// without any DB changes.
const KNOWN_AXES = new Set([
  'persona',
  'utm.source',
  'utm.medium',
  'utm.campaign',
  'utm.term',
  'utm.content',
  'geo.country',
  'geo.region',
  'geo.city',
  'locale',
  'viewer.authenticated',
  // Special pseudo-axis: the persona is eligible for explicit cookie
  // selection. Doesn't actually compare against a RenderContext field —
  // the resolver short-circuits to "matched" when the cookie already
  // names this persona.
  '*self_select',
] as const);

type Axis = typeof KNOWN_AXES extends Set<infer T> ? T : never;

const KNOWN_OPERATORS = new Set(['eq', 'in', 'exists', 'not_eq'] as const);
type Operator = typeof KNOWN_OPERATORS extends Set<infer T> ? T : never;

interface PersonaCondition {
  axis: Axis;
  operator: Operator;
  // Value shape depends on operator:
  //   eq / not_eq → string | boolean | null (null means "axis is null")
  //   in          → readonly array of strings
  //   exists      → null
  value: string | boolean | null | readonly string[];
  persist: boolean;
}

interface PersonaInput {
  name?: string;
  label?: string;
  description?: string | null;
  is_default?: boolean;
  priority?: number;
  conditions?: PersonaCondition[];
}

// Slug shape mirrors the CHECK on the table — lowercase + dash, must
// start with a letter. Keeping the regex here lets the route return a
// readable error before the DB rejects.
const NAME_SLUG_RE = /^[a-z][a-z0-9-]*$/;

function paramAs(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return undefined;
}

function validateConditions(raw: unknown): { ok: true; value: PersonaCondition[] } | { ok: false; reason: string } {
  if (!Array.isArray(raw)) return { ok: false, reason: 'conditions must be an array' };
  const out: PersonaCondition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return { ok: false, reason: `conditions[${i}] must be an object` };
    }
    const obj = c as Record<string, unknown>;

    const axis = obj.axis;
    if (typeof axis !== 'string' || !KNOWN_AXES.has(axis as Axis)) {
      return {
        ok: false,
        reason: `conditions[${i}].axis must be one of: ${Array.from(KNOWN_AXES).join(', ')}`,
      };
    }
    const operator = obj.operator;
    if (typeof operator !== 'string' || !KNOWN_OPERATORS.has(operator as Operator)) {
      return {
        ok: false,
        reason: `conditions[${i}].operator must be one of: ${Array.from(KNOWN_OPERATORS).join(', ')}`,
      };
    }

    // Value shape is operator-driven. Strict because a wrong shape silently
    // misbehaves at resolution time.
    let value: PersonaCondition['value'];
    if (axis === '*self_select') {
      // Pseudo-axis always uses `eq` with null. Editor UI should enforce
      // this; we re-check at the API.
      if (operator !== 'eq' || obj.value !== null) {
        return {
          ok: false,
          reason: `conditions[${i}]: *self_select must use operator=eq, value=null`,
        };
      }
      value = null;
    } else if (operator === 'exists') {
      // No value needed — the axis being present is the whole check.
      value = null;
    } else if (operator === 'in') {
      if (!Array.isArray(obj.value) || obj.value.length === 0) {
        return {
          ok: false,
          reason: `conditions[${i}]: operator=in requires a non-empty array value`,
        };
      }
      const arr = obj.value as unknown[];
      for (let j = 0; j < arr.length; j++) {
        if (typeof arr[j] !== 'string') {
          return {
            ok: false,
            reason: `conditions[${i}].value[${j}] must be a string`,
          };
        }
        if ((arr[j] as string).length === 0 || (arr[j] as string).length > 200) {
          return {
            ok: false,
            reason: `conditions[${i}].value[${j}] must be 1..200 chars`,
          };
        }
      }
      value = arr as readonly string[];
    } else {
      // eq | not_eq
      if (axis === 'viewer.authenticated') {
        // Boolean axis — accept true/false. Editor UI can render as toggle.
        if (typeof obj.value !== 'boolean') {
          return {
            ok: false,
            reason: `conditions[${i}]: viewer.authenticated requires a boolean value`,
          };
        }
        value = obj.value;
      } else {
        if (typeof obj.value !== 'string' || obj.value.length === 0 || obj.value.length > 200) {
          return {
            ok: false,
            reason: `conditions[${i}]: operator=${operator} requires a 1..200 char string value`,
          };
        }
        value = obj.value.trim();
      }
    }

    const persist = typeof obj.persist === 'boolean' ? obj.persist : false;
    out.push({ axis: axis as Axis, operator: operator as Operator, value, persist });
  }
  return { ok: true, value: out };
}

function validatePersonaPayload(body: unknown, partial: boolean): { ok: true; value: PersonaInput } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'request body must be an object' };
  }
  const obj = body as Record<string, unknown>;
  const out: PersonaInput = {};

  if ('name' in obj || !partial) {
    if (typeof obj.name !== 'string') return { ok: false, reason: 'name required (string)' };
    const name = obj.name.trim();
    if (!NAME_SLUG_RE.test(name) || name.length > 64) {
      return { ok: false, reason: 'name must be a slug ([a-z][a-z0-9-]{0,63})' };
    }
    out.name = name;
  }
  if ('label' in obj || !partial) {
    if (typeof obj.label !== 'string' || obj.label.trim().length === 0) {
      return { ok: false, reason: 'label required (non-empty string)' };
    }
    if (obj.label.length > 200) return { ok: false, reason: 'label exceeds 200 chars' };
    out.label = obj.label.trim();
  }
  if ('description' in obj) {
    if (obj.description === null) out.description = null;
    else if (typeof obj.description === 'string') {
      out.description = obj.description.trim() || null;
    } else {
      return { ok: false, reason: 'description must be string or null' };
    }
  }
  if ('is_default' in obj) {
    if (typeof obj.is_default !== 'boolean') return { ok: false, reason: 'is_default must be boolean' };
    out.is_default = obj.is_default;
  }
  if ('priority' in obj) {
    if (typeof obj.priority !== 'number' || !Number.isInteger(obj.priority)) {
      return { ok: false, reason: 'priority must be an integer' };
    }
    if (obj.priority < 0 || obj.priority > 10_000) {
      return { ok: false, reason: 'priority must be 0..10000' };
    }
    out.priority = obj.priority;
  }
  if ('conditions' in obj) {
    const v = validateConditions(obj.conditions);
    if (!v.ok) return v;
    out.conditions = v.value;
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// Resolution algorithm (used by test-resolve endpoint AND eventually by the
// runtime API). Kept here because it operates on the same row shape the
// CRUD endpoints produce — keeping it co-located avoids drift.
// ---------------------------------------------------------------------------

export interface StoredPersona {
  id: string;
  name: string;
  label: string;
  is_default: boolean;
  priority: number;
  conditions: PersonaCondition[];
}

/**
 * Resolve which persona a request matches given the site's persona list
 * + a `RenderContext`. Returns `null` if no condition matches and there
 * is no `is_default` persona configured.
 *
 * Resolution order:
 *   1. *self_select short-circuit — if the request carries a persona
 *      claim (typically via cookie value on `persona` axis) and that
 *      name matches a persona AND that persona has a *self_select
 *      condition, use it.
 *   2. Rule walk — visit personas sorted by priority asc; for each,
 *      check each condition; return on first match.
 *   3. Default — fall back to the persona marked is_default.
 */
export function resolvePersonaFromContext(
  personas: StoredPersona[],
  context: RenderContextFlat,
): { persona: StoredPersona; matched_condition: PersonaCondition | null } | null {
  // (1) Self-select short-circuit.
  const claim = context['persona'];
  if (typeof claim === 'string' && claim.length > 0) {
    const direct = personas.find((p) => p.name === claim);
    if (direct) {
      const selfSelect = direct.conditions.find((c) => c.axis === '*self_select') ?? null;
      // Even when there's no explicit *self_select condition, accept the
      // claim — it might be sticky from a previous URL-param visit. The
      // resolver returns the persona; telemetry can note the missing
      // condition.
      return { persona: direct, matched_condition: selfSelect };
    }
    // Cookie referenced a deleted persona — fall through.
  }

  // (2) Sort once. <10 personas per site typically; sort cost negligible.
  const sorted = [...personas].sort((a, b) => a.priority - b.priority);
  for (const persona of sorted) {
    for (const cond of persona.conditions) {
      if (conditionMatches(cond, context)) {
        return { persona, matched_condition: cond };
      }
    }
  }

  // (3) Default fallback.
  const def = sorted.find((p) => p.is_default);
  if (def) return { persona: def, matched_condition: null };
  return null;
}

function conditionMatches(cond: PersonaCondition, context: RenderContextFlat): boolean {
  // *self_select is handled in resolvePersonaFromContext via cookie path.
  if (cond.axis === '*self_select') return false;

  const requestValue = context[cond.axis];

  switch (cond.operator) {
    case 'exists':
      return requestValue !== undefined && requestValue !== null && requestValue !== '';

    case 'eq':
      // Booleans compare loosely against string "true"/"false" for the
      // case where middleware passes the value as a string. The
      // canonicaliser should normalise, but be defensive.
      if (typeof cond.value === 'boolean') {
        if (typeof requestValue === 'boolean') return requestValue === cond.value;
        if (typeof requestValue === 'string') {
          return (cond.value && requestValue === 'true') || (!cond.value && requestValue === 'false');
        }
        return false;
      }
      return requestValue === cond.value;

    case 'not_eq':
      if (typeof cond.value === 'boolean') {
        if (typeof requestValue === 'boolean') return requestValue !== cond.value;
        if (typeof requestValue === 'string') {
          return (cond.value && requestValue !== 'true') || (!cond.value && requestValue !== 'false');
        }
        // Axis absent ≠ explicit value; treat as not-equal.
        return true;
      }
      return requestValue !== cond.value;

    case 'in':
      if (!Array.isArray(cond.value)) return false;
      if (typeof requestValue !== 'string') return false;
      return (cond.value as readonly string[]).includes(requestValue);

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface PersonasRoutesDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: { from(table: string): any };
  logger: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export function createPersonasRoutes(deps: PersonasRoutesDeps) {
  const { supabase, logger } = deps;

  async function createPersona(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const validated = validatePersonaPayload(req.body, /* partial */ false);
    if (!validated.ok) {
      res.status(400).json({ error: 'invalid_input', message: validated.reason } satisfies ErrorEnvelope);
      return;
    }
    const v = validated.value;
    const result = await supabase
      .from('site_personas')
      .insert({
        site_id: siteId,
        name: v.name,
        label: v.label,
        description: v.description ?? null,
        is_default: v.is_default ?? false,
        priority: v.priority ?? 100,
        conditions: v.conditions ?? [],
        created_by: req.user?.id ?? null,
      })
      .select('id, site_id, name, label, description, is_default, priority, conditions, created_at, updated_at')
      .single();

    if (result.error) {
      // Duplicate slug or duplicate-default surfaces here.
      const msg = String(result.error.message ?? '');
      if (msg.includes('site_personas_name_key') || msg.includes('UNIQUE constraint') || msg.includes('site_personas_site_id_name_key')) {
        res.status(409).json({ error: 'duplicate_name', message: `persona "${v.name}" already exists on this site` } satisfies ErrorEnvelope);
        return;
      }
      if (msg.includes('site_personas_one_default_per_site_idx')) {
        res.status(409).json({
          error: 'duplicate_default',
          message: 'another persona is already marked as the default for this site',
        } satisfies ErrorEnvelope);
        return;
      }
      logger.warn('createPersona.db_error', { siteId, error: msg });
      res.status(500).json({ error: 'internal', message: msg } satisfies ErrorEnvelope);
      return;
    }
    res.status(201).json(result.data);
  }

  async function listPersonas(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const result = await supabase
      .from('site_personas')
      .select('id, site_id, name, label, description, is_default, priority, conditions, created_at, updated_at')
      .eq('site_id', siteId)
      .order('priority', { ascending: true });

    if (result.error) {
      res.status(500).json({ error: 'internal', message: String(result.error.message ?? '') } satisfies ErrorEnvelope);
      return;
    }
    res.status(200).json({ personas: result.data ?? [] });
  }

  async function getPersona(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    const personaId = paramAs(req.params.personaId);
    if (!siteId || !personaId) {
      res.status(400).json({ error: 'missing_params', message: 'site id and persona id required' } satisfies ErrorEnvelope);
      return;
    }
    const result = await supabase
      .from('site_personas')
      .select('id, site_id, name, label, description, is_default, priority, conditions, created_at, updated_at')
      .eq('site_id', siteId)
      .eq('id', personaId)
      .maybeSingle();

    if (result.error) {
      res.status(500).json({ error: 'internal', message: String(result.error.message ?? '') } satisfies ErrorEnvelope);
      return;
    }
    if (!result.data) {
      res.status(404).json({ error: 'not_found', message: 'persona not found' } satisfies ErrorEnvelope);
      return;
    }
    res.status(200).json(result.data);
  }

  async function updatePersona(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    const personaId = paramAs(req.params.personaId);
    if (!siteId || !personaId) {
      res.status(400).json({ error: 'missing_params', message: 'site id and persona id required' } satisfies ErrorEnvelope);
      return;
    }
    const validated = validatePersonaPayload(req.body, /* partial */ true);
    if (!validated.ok) {
      res.status(400).json({ error: 'invalid_input', message: validated.reason } satisfies ErrorEnvelope);
      return;
    }
    const v = validated.value;
    // Build patch object — only include fields the caller supplied.
    const patch: Record<string, unknown> = {};
    if (v.name !== undefined) patch.name = v.name;
    if (v.label !== undefined) patch.label = v.label;
    if (v.description !== undefined) patch.description = v.description;
    if (v.is_default !== undefined) patch.is_default = v.is_default;
    if (v.priority !== undefined) patch.priority = v.priority;
    if (v.conditions !== undefined) patch.conditions = v.conditions;
    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: 'empty_patch', message: 'no fields to update' } satisfies ErrorEnvelope);
      return;
    }

    const result = await supabase
      .from('site_personas')
      .update(patch)
      .eq('site_id', siteId)
      .eq('id', personaId)
      .select('id, site_id, name, label, description, is_default, priority, conditions, created_at, updated_at')
      .maybeSingle();

    if (result.error) {
      const msg = String(result.error.message ?? '');
      if (msg.includes('site_personas_one_default_per_site_idx')) {
        res.status(409).json({
          error: 'duplicate_default',
          message: 'another persona is already marked as the default for this site',
        } satisfies ErrorEnvelope);
        return;
      }
      if (msg.includes('site_personas_site_id_name_key')) {
        res.status(409).json({ error: 'duplicate_name', message: `persona name already in use` } satisfies ErrorEnvelope);
        return;
      }
      res.status(500).json({ error: 'internal', message: msg } satisfies ErrorEnvelope);
      return;
    }
    if (!result.data) {
      res.status(404).json({ error: 'not_found', message: 'persona not found' } satisfies ErrorEnvelope);
      return;
    }
    res.status(200).json(result.data);
  }

  async function deletePersona(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    const personaId = paramAs(req.params.personaId);
    if (!siteId || !personaId) {
      res.status(400).json({ error: 'missing_params', message: 'site id and persona id required' } satisfies ErrorEnvelope);
      return;
    }
    // ON DELETE SET NULL on page_variants.persona_id leaves variant rows
    // alive but orphaned — the editor will display them as "(deleted
    // persona)" and the operator can clean up or re-link.
    const result = await supabase
      .from('site_personas')
      .delete()
      .eq('site_id', siteId)
      .eq('id', personaId)
      .select('id')
      .maybeSingle();

    if (result.error) {
      res.status(500).json({ error: 'internal', message: String(result.error.message ?? '') } satisfies ErrorEnvelope);
      return;
    }
    if (!result.data) {
      res.status(404).json({ error: 'not_found', message: 'persona not found' } satisfies ErrorEnvelope);
      return;
    }
    res.status(204).end();
  }

  /**
   * Resolve a sample RenderContext against the site's personas. Used by
   * the admin UI's "test rules" affordance — paste in a URL or pick UTM
   * params, see which persona resolves and which condition matched.
   *
   * Body shape:
   *   { "render_context": { "persona": "developer", "utm.campaign": "..." } }
   *
   * Response:
   *   {
   *     "resolved": {
   *       "persona": { id, name, label, ... },
   *       "matched_condition": { type, match_value, persist } | null
   *     } | null
   *   }
   */
  async function testResolve(req: RequestWithUser, res: Response): Promise<void> {
    const siteId = paramAs(req.params.id);
    if (!siteId) {
      res.status(400).json({ error: 'missing_site_id', message: 'site id required' } satisfies ErrorEnvelope);
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const rawContext = body['render_context'];
    if (!rawContext || typeof rawContext !== 'object') {
      res.status(400).json({
        error: 'invalid_input',
        message: 'render_context object required',
      } satisfies ErrorEnvelope);
      return;
    }

    // Reuse the canonicaliser the runtime API will use — keeps the admin
    // test behaviour and runtime behaviour bit-identical.
    const canon = canonicalizeRenderContext(rawContext);
    if (!canon.ok) {
      res.status(400).json({
        error: 'invalid_render_context',
        message: canon.detail ?? canon.reason,
        details: { reason: canon.reason },
      } satisfies ErrorEnvelope);
      return;
    }
    const context: RenderContextFlat = canon.canonical;

    const personasRes = await supabase
      .from('site_personas')
      .select('id, name, label, is_default, priority, conditions')
      .eq('site_id', siteId);

    if (personasRes.error) {
      res.status(500).json({ error: 'internal', message: String(personasRes.error.message ?? '') } satisfies ErrorEnvelope);
      return;
    }

    const personas = (personasRes.data ?? []) as StoredPersona[];
    const resolved = resolvePersonaFromContext(personas, context);
    res.status(200).json({
      render_context: context,
      resolved: resolved
        ? { persona: resolved.persona, matched_condition: resolved.matched_condition }
        : null,
    });
  }

  return { createPersona, listPersonas, getPersona, updatePersona, deletePersona, testResolve };
}

export function mountPersonasRoutes(router: Router, routes: ReturnType<typeof createPersonasRoutes>): void {
  router.post('/sites/:id/personas', routes.createPersona);
  router.get('/sites/:id/personas', routes.listPersonas);
  router.post('/sites/:id/personas/test-resolve', routes.testResolve);
  router.get('/sites/:id/personas/:personaId', routes.getPersona);
  router.patch('/sites/:id/personas/:personaId', routes.updatePersona);
  router.delete('/sites/:id/personas/:personaId', routes.deletePersona);
}
