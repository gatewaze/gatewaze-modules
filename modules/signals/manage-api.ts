// Signals management API — mounted at /api/v1/signals, every route requires
// the `signals:write` scope. This is the programmatic surface the MCP tools
// wrap and the path local verification uses to run evaluations on demand
// (the BullMQ worker covers scheduled evaluation in deployed environments).

// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require('./lib/engine.js');

const CHANNEL_TYPES = ['log', 'webhook', 'portal_pin', 'broadcast_draft'];
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

function sendError(res: any, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

/** Validate a rule definition payload; returns an error message or null. */
function validateDefinition(d: any): string | null {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return 'definition must be an object';
  if (d.topics !== undefined) {
    if (!Array.isArray(d.topics) || d.topics.some((t: unknown) => typeof t !== 'string' || !TOPIC_RE.test(t))) {
      return 'definition.topics must be an array of kebab-case topic slugs';
    }
  }
  const channelType = d.channel?.type ?? 'log';
  if (!CHANNEL_TYPES.includes(channelType)) {
    return `definition.channel.type must be one of: ${CHANNEL_TYPES.join(', ')}`;
  }
  if (channelType === 'webhook' && !/^https?:\/\//.test(d.channel?.config?.url ?? '')) {
    return 'webhook channel requires definition.channel.config.url';
  }
  const hasTopics = Array.isArray(d.topics) && d.topics.length > 0;
  const hasHrefs = Array.isArray(d.content?.hrefs) && d.content.hrefs.length > 0;
  if (!hasTopics && !hasHrefs) return 'definition needs topics or content.hrefs to match anything';
  for (const key of ['min_overlap', 'interval_minutes', 'max_fires_per_run'] as const) {
    if (d[key] !== undefined && (!Number.isInteger(d[key]) || d[key] < 0)) return `definition.${key} must be a non-negative integer`;
  }
  return null;
}

export function registerManageApi(router: any, ctx: any): void {
  const supabase = ctx.supabase;
  const write = ctx.requireScope('write');

  // ── Rules ──────────────────────────────────────────────────────────────
  router.get('/rules', write, async (_req: any, res: any) => {
    const { data, error } = await supabase.from('signals_rules').select('*').order('created_at', { ascending: false });
    if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
    res.json({ data });
  });

  router.post('/rules', write, async (req: any, res: any) => {
    try {
      const body = req.body ?? {};
      if (typeof body.name !== 'string' || !body.name.trim()) return sendError(res, 400, 'VALIDATION_ERROR', 'name is required');
      const defError = validateDefinition(body.definition ?? {});
      if (defError) return sendError(res, 400, 'VALIDATION_ERROR', defError);
      const { data, error } = await supabase.from('signals_rules').insert({
        name: body.name.trim(),
        description: typeof body.description === 'string' ? body.description : null,
        // proposals land paused; a human (or an explicit status update) activates
        status: body.status === 'active' ? 'active' : 'paused',
        definition: body.definition ?? {},
        created_by: typeof body.created_by === 'string' ? body.created_by : 'api',
      }).select().single();
      if (error) {
        if (/duplicate key/.test(error.message)) return sendError(res, 409, 'CONFLICT', 'a rule with this name exists');
        return sendError(res, 500, 'QUERY_ERROR', error.message);
      }
      res.status(201).json({ data });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  router.patch('/rules/:id', write, async (req: any, res: any) => {
    try {
      const body = req.body ?? {};
      const updates: Record<string, unknown> = {};
      if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
      if (body.description !== undefined) updates.description = body.description;
      if (body.status !== undefined) {
        if (!['active', 'paused'].includes(body.status)) return sendError(res, 400, 'VALIDATION_ERROR', "status must be 'active' or 'paused'");
        updates.status = body.status;
      }
      if (body.definition !== undefined) {
        const defError = validateDefinition(body.definition);
        if (defError) return sendError(res, 400, 'VALIDATION_ERROR', defError);
        updates.definition = body.definition;
      }
      if (Object.keys(updates).length === 0) return sendError(res, 400, 'VALIDATION_ERROR', 'no updatable fields provided');
      updates.updated_at = new Date().toISOString();
      const { data, error } = await supabase.from('signals_rules').update(updates).eq('id', req.params.id).select().maybeSingle();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      if (!data) return sendError(res, 404, 'NOT_FOUND', 'Rule not found');
      res.json({ data });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'Internal server error');
    }
  });

  router.delete('/rules/:id', write, async (req: any, res: any) => {
    const { error } = await supabase.from('signals_rules').delete().eq('id', req.params.id);
    if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
    res.json({ data: { deleted: true } });
  });

  // ── Evaluation ─────────────────────────────────────────────────────────
  // ?dry_run=1 scores without firing or dispatching — the preview surface.
  router.post('/rules/:id/evaluate', write, async (req: any, res: any) => {
    try {
      const { data: rule, error } = await supabase.from('signals_rules').select('*').eq('id', req.params.id).maybeSingle();
      if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
      if (!rule) return sendError(res, 404, 'NOT_FOUND', 'Rule not found');
      const dryRun = req.query?.dry_run === '1' || req.body?.dry_run === true;
      const summary = await engine.evaluateRule(supabase, rule, { dryRun });
      res.json({ data: summary });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'evaluation failed');
    }
  });

  router.post('/evaluate-due', write, async (req: any, res: any) => {
    try {
      const force = req.query?.force === '1' || req.body?.force === true;
      const results = await engine.evaluateDueRules(supabase, { force });
      res.json({ data: results });
    } catch (err: any) {
      sendError(res, 500, 'INTERNAL', err?.message ?? 'evaluation failed');
    }
  });

  // ── Fires + outcomes + telemetry ───────────────────────────────────────
  router.get('/fires', write, async (req: any, res: any) => {
    let q = supabase.from('signals_fires').select('*').order('created_at', { ascending: false }).limit(100);
    if (req.query?.rule_id) q = q.eq('rule_id', req.query.rule_id);
    if (req.query?.status) q = q.eq('status', req.query.status);
    const { data, error } = await q;
    if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
    res.json({ data });
  });

  router.post('/outcomes', write, async (req: any, res: any) => {
    const body = req.body ?? {};
    if (typeof body.fire_id !== 'string' || typeof body.kind !== 'string') {
      return sendError(res, 400, 'VALIDATION_ERROR', 'fire_id and kind are required');
    }
    const { error } = await supabase.from('signals_outcomes').insert({
      fire_id: body.fire_id,
      kind: body.kind,
      source: typeof body.source === 'string' ? body.source : 'api',
    });
    if (error) return sendError(res, 400, 'VALIDATION_ERROR', error.message);
    res.status(201).json({ data: { recorded: true } });
  });

  router.get('/stats', write, async (_req: any, res: any) => {
    const { data, error } = await supabase.from('signals_rule_stats').select('*');
    if (error) return sendError(res, 500, 'QUERY_ERROR', error.message);
    res.json({ data });
  });
}
