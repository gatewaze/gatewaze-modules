import type { PublicApiContext } from '@gatewaze/shared';
import type { Router, Request, Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Public API for audience search + MCP-owned segments
 * (scope segments:people to search/list, segments:write to save).
 *
 * PII surface: rows are names/emails of the whole audience. The scopes are
 * granted deliberately (LF staff group / per-person) and every MCP call is
 * identity-audited upstream. All filtering runs through the SAME SQL engine
 * the admin segment builder and broadcasts use (segments_def_to_sql), so
 * smart country/state matching and the full_name virtual field behave
 * identically everywhere.
 */

const OPERATORS = new Set([
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with',
  'is_set', 'is_not_set', 'greater_than', 'less_than', 'greater_than_or_equal',
  'less_than_or_equal', 'in_list', 'not_in_list', 'matches_regex',
]);
const FIELD_RE = /^[a-zA-Z0-9_.]{1,80}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Condition = { type: 'attribute'; field: string; operator: string; value?: string };

/** Map the simple query params + optional raw conditions JSON to a definition. */
function buildDefinition(query: Record<string, unknown>): { definition: { match: string; conditions: Condition[] }; error?: string } {
  const conditions: Condition[] = [];
  const add = (field: string, operator: string, value?: string) =>
    conditions.push({ type: 'attribute', field, operator, ...(value !== undefined ? { value } : {}) });

  if (query.q) add('full_name', 'contains', String(query.q));
  if (query.country) add('attributes.country', 'equals', String(query.country));
  if (query.state) add('attributes.state', 'equals', String(query.state));
  if (query.city_contains) add('attributes.city', 'contains', String(query.city_contains));
  if (query.email_contains) add('email', 'contains', String(query.email_contains));
  if (query.email_not_contains) add('email', 'not_contains', String(query.email_not_contains));
  if (query.company_contains) add('attributes.company', 'contains', String(query.company_contains));
  if (query.job_title_contains) add('attributes.job_title', 'contains', String(query.job_title_contains));
  if (query.free_email === 'true' || query.free_email === 'false') {
    add('attributes.free_email', 'equals', String(query.free_email));
  }

  if (query.conditions) {
    let raw: unknown;
    try {
      raw = typeof query.conditions === 'string' ? JSON.parse(query.conditions) : query.conditions;
    } catch {
      return { definition: { match: 'all', conditions }, error: 'conditions must be a JSON array' };
    }
    if (!Array.isArray(raw)) return { definition: { match: 'all', conditions }, error: 'conditions must be a JSON array' };
    for (const c of raw as Array<Record<string, unknown>>) {
      const field = String(c?.field ?? '');
      const operator = String(c?.operator ?? '');
      if (!FIELD_RE.test(field)) return { definition: { match: 'all', conditions }, error: `invalid condition field: ${field.slice(0, 80)}` };
      if (!OPERATORS.has(operator)) return { definition: { match: 'all', conditions }, error: `invalid condition operator: ${operator.slice(0, 40)}` };
      add(field, operator, c?.value !== undefined && c?.value !== null ? String(c.value) : undefined);
    }
  }

  const match = query.match === 'any' ? 'any' : 'all';
  return { definition: { match, conditions } };
}

export function registerPublicApi(router: Router, ctx: PublicApiContext) {
  const supabase = ctx.supabase as SupabaseClient;

  // GET /api/v1/segments/people — audience search through the segment engine.
  router.get('/people', ctx.requireScope('people'), async (req: Request, res: Response) => {
    try {
      const { definition, error: defError } = buildDefinition(req.query as Record<string, unknown>);
      if (defError) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: defError } });
      if (definition.conditions.length === 0) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'at least one filter is required' } });
      }
      const limit = Math.min(parseInt(String(req.query.limit)) || 25, 200);
      const { data, error } = await supabase.rpc('segments_preview_service', {
        p_definition: definition,
        p_limit: limit,
      });
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });
      const result = data as { count: number; sample: unknown[] };
      ctx.setCache(res, { kind: 'no-store' });
      res.json({
        data: result.sample ?? [],
        pagination: { total: result.count ?? 0, limit, offset: 0, has_more: (result.count ?? 0) > limit },
        definition,
        note: (result.count ?? 0) > limit ? `showing ${limit} of ${result.count} — refine filters or save as a segment` : undefined,
      });
    } catch (err) {
      console.error('[segments] public-api people error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // POST /api/v1/segments — save the current filter as a named dynamic
  // segment, owned by the calling person (MCP identity).
  router.post('/', ctx.requireScope('write'), async (req: Request, res: Response) => {
    try {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const name = String(b.name ?? '').trim();
      if (!name) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name required' } });
      const personId = String(b.person_id ?? '');
      if (!UUID_RE.test(personId)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'person_id (uuid) required' } });

      let definition: { match: string; conditions: Condition[] };
      if (b.definition && typeof b.definition === 'object') {
        const built = buildDefinition({ conditions: (b.definition as Record<string, unknown>).conditions, match: (b.definition as Record<string, unknown>).match });
        if (built.error) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: built.error } });
        definition = built.definition;
      } else {
        const built = buildDefinition(b);
        if (built.error) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: built.error } });
        definition = built.definition;
      }
      if (definition.conditions.length === 0) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'definition needs at least one condition' } });
      }

      const { data, error } = await supabase
        .from('segments')
        .insert({
          name: name.slice(0, 500),
          description: b.description ? String(b.description).slice(0, 2000) : null,
          definition,
          type: 'dynamic',
          status: 'active',
          created_by_person_id: personId,
          created_via: 'mcp',
        })
        .select('id, name, description, definition, created_at')
        .single();
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });
      ctx.setCache(res, { kind: 'no-store' });
      res.status(201).json({ data });
    } catch (err) {
      console.error('[segments] public-api create error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/segments/mine — segments created by this person via MCP.
  router.get('/mine', ctx.requireScope('people'), async (req: Request, res: Response) => {
    try {
      const personId = String(req.query.person_id ?? '');
      if (!UUID_RE.test(personId)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'person_id (uuid) required' } });
      const { data, error } = await supabase
        .from('segments')
        .select('id, name, description, definition, cached_count, last_calculated_at, created_at')
        .eq('created_by_person_id', personId)
        .neq('status', 'archived')
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });
      ctx.setCache(res, { kind: 'no-store' });
      res.json({ data: data ?? [] });
    } catch (err) {
      console.error('[segments] public-api mine error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });

  // GET /api/v1/segments/:id/people — run a saved segment.
  router.get('/:id/people', ctx.requireScope('people'), async (req: Request, res: Response) => {
    try {
      if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'segment id must be a uuid' } });
      const { data: seg } = await supabase
        .from('segments')
        .select('id, name, definition, status')
        .eq('id', req.params.id)
        .maybeSingle();
      if (!seg) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Segment not found' } });
      const limit = Math.min(parseInt(String(req.query.limit)) || 25, 200);
      const { data, error } = await supabase.rpc('segments_preview_service', {
        p_definition: (seg as { definition: unknown }).definition,
        p_limit: limit,
      });
      if (error) return res.status(500).json({ error: { code: 'QUERY_ERROR', message: error.message } });
      const result = data as { count: number; sample: unknown[] };
      ctx.setCache(res, { kind: 'no-store' });
      res.json({
        data: result.sample ?? [],
        segment: { id: (seg as { id: string }).id, name: (seg as { name: string }).name },
        pagination: { total: result.count ?? 0, limit, offset: 0, has_more: (result.count ?? 0) > limit },
      });
    } catch (err) {
      console.error('[segments] public-api segment people error:', err);
      res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    }
  });
}
