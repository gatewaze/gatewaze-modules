/**
 * Segment AI Copilot handler — uses the AI module's runChat (forced tool use)
 * instead of calling Anthropic directly. The AI module owns credential
 * resolution (3-tier: user → use_case pin → env), provider routing, cost
 * recording, and the forced structured-tool call. We supply the system prompt +
 * JSON-Schema tool and translate the result into a validated segment definition,
 * then live-preview the count.
 *
 * Mirrors editor-ai-copilot's dispatch.ts pattern. Runs Node/Express-side only
 * (the AI module is not Deno-compatible). Mounted at
 * /api/admin/modules/campaigns/segments-ai-build.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// --- AI runner types (subset of @gatewaze-modules/ai/lib/runner) ------------
interface RunChatResult { structured: Record<string, unknown> | null; }
type RunChat = (
  ctx: { supabase: unknown },
  opts: {
    useCase: string; userId: string | null; threadId: null; messageId: null;
    systemPrompt: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    structuredTool: { name: string; description: string; inputSchema: Record<string, unknown> };
    maxOutputTokens?: number; timeoutMs?: number;
  },
) => Promise<RunChatResult>;

let cachedRunChat: RunChat | null | undefined;
async function loadRunChat(): Promise<RunChat> {
  if (cachedRunChat) return cachedRunChat;
  // From modules/campaigns/api/, the sibling ai module is two levels up. The
  // @gatewaze-modules path covers the vite/admin build; the relative + source
  // variants cover the api-server clone tree (cf. editor-ai-copilot loadRunChat).
  const attempts = [
    '@gatewaze-modules/ai/lib/runner.js',
    '../../ai/lib/runner.js',
    '../../../../gatewaze-modules/modules/ai/lib/runner.ts',
    '/tmp/module-repos/gatewaze-modules/modules/ai/lib/runner.ts',
  ];
  const failures: string[] = [];
  for (const path of attempts) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await import(path as any)) as { runChat?: RunChat };
      if (typeof mod.runChat === 'function') { cachedRunChat = mod.runChat; return mod.runChat; }
      failures.push(`${path} (runChat is ${typeof mod.runChat})`);
    } catch (e) {
      failures.push(`${path} (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`);
    }
  }
  throw new Error('@gatewaze-modules/ai runChat unavailable — required for the segment copilot. Tried: ' + failures.join('; '));
}

// --- Segment vocabulary (mirrors packages/admin/src/lib/segments/types.ts) --
const ATTRIBUTE_FIELDS = [
  'email', 'attributes.first_name', 'attributes.last_name', 'attributes.company',
  'attributes.job_title', 'attributes.country', 'attributes.city', 'attributes.region',
  'attributes.timezone', 'attributes.linkedin_url', 'attributes.twitter_handle',
];
const ATTRIBUTE_OPERATORS = [
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with',
  'is_set', 'is_not_set', 'greater_than', 'less_than', 'greater_than_or_equal',
  'less_than_or_equal', 'in_list', 'not_in_list', 'matches_regex',
];
const EVENT_TYPES = [
  'event_attended', 'event_registered', 'offer_accepted', 'offer_viewed',
  'competition_entered', 'discount_claimed', 'activity',
];
const EVENT_OPERATORS = ['performed', 'not_performed', 'performed_count', 'performed_at_least', 'performed_at_most'];

const conditionSchema: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object', required: ['type', 'field', 'operator'], additionalProperties: false,
      properties: {
        type: { const: 'attribute' },
        field: { type: 'string', enum: ATTRIBUTE_FIELDS },
        operator: { type: 'string', enum: ATTRIBUTE_OPERATORS },
        value: {},
      },
    },
    {
      type: 'object', required: ['type', 'event_type', 'operator'], additionalProperties: false,
      properties: {
        type: { const: 'event' },
        event_type: { type: 'string', enum: EVENT_TYPES },
        operator: { type: 'string', enum: EVENT_OPERATORS },
        value: { type: 'number' },
        time_window: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['relative', 'absolute'] },
            relative_value: { type: 'number' },
            relative_unit: { type: 'string', enum: ['days', 'weeks', 'months', 'years'] },
            start_date: { type: 'string' }, end_date: { type: 'string' },
          },
        },
        event_filters: {
          type: 'array',
          items: {
            type: 'object', required: ['property', 'operator', 'value'],
            properties: { property: { type: 'string' }, operator: { type: 'string', enum: ATTRIBUTE_OPERATORS }, value: {} },
          },
        },
      },
    },
    {
      type: 'object', required: ['type', 'match', 'conditions'],
      properties: { type: { const: 'group' }, match: { type: 'string', enum: ['all', 'any'] }, conditions: { type: 'array' } },
    },
  ],
};

const TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['match', 'conditions', 'suggested_name', 'explanation'],
  properties: {
    match: { type: 'string', enum: ['all', 'any'] },
    conditions: { type: 'array', items: conditionSchema },
    suggested_name: { type: 'string' },
    explanation: { type: 'string', description: 'Plain-language readback of what this targets.' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

function buildSystemPrompt(eventNames: string[]): string {
  return [
    'You translate a natural-language audience description into a Gatewaze segment definition.',
    'You MUST call the emit_segment_definition tool. Never write prose outside the tool call.',
    '',
    'Rules:',
    '- Use ONLY these attribute fields: ' + ATTRIBUTE_FIELDS.join(', ') + '.',
    '- Use ONLY these event types: ' + EVENT_TYPES.join(', ') + (eventNames.length ? ' (also custom: ' + eventNames.join(', ') + ')' : '') + '.',
    '- For location targeting use attributes.city / attributes.region / attributes.country.',
    '- For "attended/registered for an event in <place>", use an event condition (event_attended/event_registered, operator performed) with event_filters like { property: "event_city", operator: "equals", value: "<place>" }.',
    '- Use match="all" for AND, match="any" for OR. Nest with type:"group" when mixing.',
    '- When a request cannot be fully expressed (e.g. "surrounding area"/radius targeting, which needs geo lat/long we do not have), still produce the closest approximation AND add a clear note to the warnings array.',
    '- explanation: a short plain-language readback of exactly who this targets.',
  ].join('\n');
}

function validateDefinition(def: unknown): string | null {
  const d = def as { match?: unknown; conditions?: unknown };
  if (!d || typeof d !== 'object') return 'definition is not an object';
  if (d.match !== 'all' && d.match !== 'any') return 'match must be "all" or "any"';
  if (!Array.isArray(d.conditions) || d.conditions.length === 0) return 'conditions must be a non-empty array';
  const checkCond = (c: any, depth: number): string | null => {
    if (depth > 5) return 'conditions nested too deeply';
    if (!c || typeof c !== 'object') return 'condition is not an object';
    if (c.type === 'attribute') {
      if (typeof c.field !== 'string' || !ATTRIBUTE_FIELDS.includes(c.field)) return `invalid attribute field: ${c.field}`;
      if (typeof c.operator !== 'string' || !ATTRIBUTE_OPERATORS.includes(c.operator)) return `invalid attribute operator: ${c.operator}`;
      return null;
    }
    if (c.type === 'event') {
      if (typeof c.event_type !== 'string') return 'event_type required';
      if (typeof c.operator !== 'string' || !EVENT_OPERATORS.includes(c.operator)) return `invalid event operator: ${c.operator}`;
      return null;
    }
    if (c.type === 'group') {
      if (c.match !== 'all' && c.match !== 'any') return 'group match must be all/any';
      if (!Array.isArray(c.conditions) || c.conditions.length === 0) return 'group needs conditions';
      for (const sub of c.conditions) { const e = checkCond(sub, depth + 1); if (e) return e; }
      return null;
    }
    return `unknown condition type: ${c.type}`;
  };
  for (const c of (d.conditions as unknown[])) { const e = checkCond(c, 0); if (e) return e; }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = { userId?: string; body?: any; headers: Record<string, string | string[] | undefined> };
interface Res { status: (n: number) => Res; json: (b: unknown) => void; }

interface Deps { supabase: SupabaseClient; logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void } }

const SEGMENTS_COPILOT_USE_CASE = 'segments-copilot';

export function createSegmentsAiBuildRoute(deps: Deps) {
  return async function handler(req: Req, res: Res): Promise<void> {
    const userId = req.userId;
    if (!userId) { res.status(401).json({ success: false, error: 'Unauthorized' }); return; }

    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) { res.status(400).json({ success: false, error: 'Missing prompt' }); return; }

    // Admin gate (service-role check, mirrors editor-ai-copilot).
    try {
      const { data: admin } = await deps.supabase.from('admin_profiles').select('user_id').eq('user_id', userId).eq('is_active', true).maybeSingle();
      if (!admin) { res.status(403).json({ success: false, error: 'Admin privileges required' }); return; }
    } catch {
      res.status(403).json({ success: false, error: 'Admin privileges required' }); return;
    }

    // Caller-auth client for segments_preview (is_admin()-gated SECURITY DEFINER).
    const authHeader = req.headers['authorization'];
    const bearer = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    const callerClient = createClient(
      process.env.SUPABASE_URL ?? '',
      process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      { auth: { autoRefreshToken: false, persistSession: false }, global: { headers: bearer ? { Authorization: bearer } : {} } },
    );

    // Custom event names for the prompt vocabulary (best-effort).
    let eventNames: string[] = [];
    try {
      const { data } = await deps.supabase.rpc('segments_event_names');
      if (Array.isArray(data)) eventNames = (data as string[]).filter((n) => !EVENT_TYPES.includes(n)).slice(0, 40);
    } catch { /* non-fatal */ }

    let runChat: RunChat;
    try { runChat = await loadRunChat(); }
    catch (e) { deps.logger.error('[campaigns] loadRunChat failed', e); res.status(503).json({ success: false, error: 'AI module unavailable' }); return; }

    const ctx = { supabase: deps.supabase as unknown };
    const callModel = async (extra?: string): Promise<Record<string, unknown> | null> => {
      const result = await runChat(ctx, {
        useCase: SEGMENTS_COPILOT_USE_CASE,
        userId,
        threadId: null,
        messageId: null,
        systemPrompt: buildSystemPrompt(eventNames),
        messages: [{ role: 'user', content: extra ? `${prompt}\n\n${extra}` : prompt }],
        structuredTool: {
          name: 'emit_segment_definition',
          description: 'Emit a segment definition matching the audience the user described.',
          inputSchema: TOOL_INPUT_SCHEMA,
        },
        maxOutputTokens: 1500,
        timeoutMs: 60_000,
      });
      return result.structured;
    };

    let out: Record<string, unknown> | null;
    try {
      out = await callModel();
      let err = out ? validateDefinition(out) : 'model returned no tool call';
      if (err) {
        out = await callModel(`Your previous attempt was invalid: ${err}. Re-emit a corrected emit_segment_definition tool call.`);
        err = out ? validateDefinition(out) : 'model returned no tool call';
        if (err) { res.status(422).json({ success: false, error: `Could not build a valid segment: ${err}`, raw: out ?? null }); return; }
      }
    } catch (e) {
      const status = (e as { status?: number })?.status;
      if (status === 429) { res.status(429).json({ success: false, error: 'AI usage limit reached, try again shortly' }); return; }
      deps.logger.error('[campaigns] copilot runChat error', e);
      res.status(502).json({ success: false, error: 'LLM error: ' + (e instanceof Error ? e.message : 'unknown') }); return;
    }

    const o = out as { match: 'all' | 'any'; conditions: unknown[]; suggested_name?: string; explanation?: string; warnings?: string[] };
    const definition = { match: o.match, conditions: o.conditions };

    const { data: preview, error: previewError } = await callerClient.rpc('segments_preview', { p_definition: definition, p_limit: 8 });
    if (previewError) {
      const msg = previewError.message || '';
      if (/permission|admin|denied|rls/i.test(msg)) { res.status(403).json({ success: false, error: 'Admin privileges required' }); return; }
      res.status(200).json({ success: true, definition, suggested_name: o.suggested_name, explanation: o.explanation, warnings: [...(o.warnings ?? []), `Preview unavailable: ${msg}`], count: null, sample: [] });
      return;
    }

    res.status(200).json({
      success: true,
      definition,
      suggested_name: o.suggested_name,
      explanation: o.explanation,
      warnings: o.warnings ?? [],
      count: (preview as { count?: number })?.count ?? 0,
      sample: (preview as { sample?: unknown[] })?.sample ?? [],
    });
  };
}
