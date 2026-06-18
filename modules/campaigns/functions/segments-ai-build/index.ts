import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'
import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.39.0'

/**
 * Segment AI Copilot — segments-ai-build
 *
 * Turns a plain-language audience description into a VALID segment definition,
 * previews the live count, and returns an editable proposal. It is a TRANSLATOR
 * into the existing segment schema — never a direct DB query generator — so the
 * output is always inspectable, editable, and validated before anything is saved
 * or sent (spec-campaigns-module.md Phase 2).
 *
 * POST { prompt, context? } → 200 { definition, count, sample, explanation, warnings }
 * Errors: 400 invalid prompt; 403 non-admin; 422 un-validatable after one repair;
 *         429 usage cap; 502 upstream LLM error.
 *
 * Admin gate: segments_preview is an is_admin()-gated SECURITY DEFINER RPC, and
 * we call it with the CALLER's JWT — so a non-admin caller fails there (403).
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'

// Live vocabulary mirrored from packages/admin/src/lib/segments/types.ts.
const ATTRIBUTE_FIELDS = [
  'email', 'attributes.first_name', 'attributes.last_name', 'attributes.company',
  'attributes.job_title', 'attributes.country', 'attributes.city', 'attributes.region',
  'attributes.timezone', 'attributes.linkedin_url', 'attributes.twitter_handle',
]
const ATTRIBUTE_OPERATORS = [
  'equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'ends_with',
  'is_set', 'is_not_set', 'greater_than', 'less_than', 'greater_than_or_equal',
  'less_than_or_equal', 'in_list', 'not_in_list', 'matches_regex',
]
const EVENT_TYPES = [
  'event_attended', 'event_registered', 'offer_accepted', 'offer_viewed',
  'competition_entered', 'discount_claimed', 'activity',
]
const EVENT_OPERATORS = ['performed', 'not_performed', 'performed_count', 'performed_at_least', 'performed_at_most']

const conditionSchema: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      required: ['type', 'field', 'operator'],
      additionalProperties: false,
      properties: {
        type: { const: 'attribute' },
        field: { type: 'string', enum: ATTRIBUTE_FIELDS },
        operator: { type: 'string', enum: ATTRIBUTE_OPERATORS },
        value: {},
      },
    },
    {
      type: 'object',
      required: ['type', 'event_type', 'operator'],
      additionalProperties: false,
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
            start_date: { type: 'string' },
            end_date: { type: 'string' },
          },
        },
        event_filters: {
          type: 'array',
          items: {
            type: 'object',
            required: ['property', 'operator', 'value'],
            properties: {
              property: { type: 'string' },
              operator: { type: 'string', enum: ATTRIBUTE_OPERATORS },
              value: {},
            },
          },
        },
      },
    },
    {
      type: 'object',
      required: ['type', 'match', 'conditions'],
      properties: {
        type: { const: 'group' },
        match: { type: 'string', enum: ['all', 'any'] },
        conditions: { type: 'array' },
      },
    },
  ],
}

const TOOL = {
  name: 'emit_segment_definition',
  description: 'Emit a segment definition matching the audience the user described.',
  input_schema: {
    type: 'object',
    required: ['match', 'conditions', 'suggested_name', 'explanation'],
    properties: {
      match: { type: 'string', enum: ['all', 'any'] },
      conditions: { type: 'array', items: conditionSchema },
      suggested_name: { type: 'string' },
      explanation: { type: 'string', description: 'Plain-language readback of what this targets.' },
      warnings: { type: 'array', items: { type: 'string' } },
    },
  },
}

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
    '- When a request cannot be fully expressed (e.g. "surrounding area"/radius targeting, which needs geo lat/long we do not have), still produce the closest approximation AND add a clear note to the warnings array explaining the limitation.',
    '- explanation: a short plain-language readback of exactly who this targets.',
  ].join('\n')
}

// Minimal structural validator (mirrors isValidSegmentDefinition intent).
function validateDefinition(def: any): string | null {
  if (!def || typeof def !== 'object') return 'definition is not an object'
  if (def.match !== 'all' && def.match !== 'any') return 'match must be "all" or "any"'
  if (!Array.isArray(def.conditions) || def.conditions.length === 0) return 'conditions must be a non-empty array'
  const checkCond = (c: any, depth: number): string | null => {
    if (depth > 5) return 'conditions nested too deeply'
    if (!c || typeof c !== 'object') return 'condition is not an object'
    if (c.type === 'attribute') {
      if (typeof c.field !== 'string' || !ATTRIBUTE_FIELDS.includes(c.field)) return `invalid attribute field: ${c.field}`
      if (typeof c.operator !== 'string' || !ATTRIBUTE_OPERATORS.includes(c.operator)) return `invalid attribute operator: ${c.operator}`
      return null
    }
    if (c.type === 'event') {
      if (typeof c.event_type !== 'string') return 'event_type required'
      if (typeof c.operator !== 'string' || !EVENT_OPERATORS.includes(c.operator)) return `invalid event operator: ${c.operator}`
      return null
    }
    if (c.type === 'group') {
      if (c.match !== 'all' && c.match !== 'any') return 'group match must be all/any'
      if (!Array.isArray(c.conditions) || c.conditions.length === 0) return 'group needs conditions'
      for (const sub of c.conditions) { const e = checkCond(sub, depth + 1); if (e) return e }
      return null
    }
    return `unknown condition type: ${c.type}`
  }
  for (const c of def.conditions) { const e = checkCond(c, 0); if (e) return e }
  return null
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json(405, { success: false, error: 'Method not allowed' })

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) return json(503, { success: false, error: 'ANTHROPIC_API_KEY not configured' })

  let prompt = ''
  try {
    const body = await req.json()
    prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : ''
  } catch {
    return json(400, { success: false, error: 'Invalid JSON body' })
  }
  if (!prompt) return json(400, { success: false, error: 'Missing prompt' })

  // Caller-auth client: segments_preview is is_admin()-gated, so this enforces
  // the admin requirement and runs the preview as the caller.
  const authHeader = req.headers.get('Authorization') ?? ''
  const callerClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { global: { headers: { Authorization: authHeader } } },
  )

  // Optional: pull custom event names for the prompt vocabulary (best-effort).
  let eventNames: string[] = []
  try {
    const { data } = await callerClient.rpc('segments_event_names')
    if (Array.isArray(data)) eventNames = (data as string[]).filter((n) => !EVENT_TYPES.includes(n)).slice(0, 40)
  } catch { /* non-fatal */ }

  const anthropic = new Anthropic({ apiKey })
  const model = Deno.env.get('SEGMENTS_COPILOT_MODEL') || DEFAULT_MODEL

  async function callModel(extra?: string): Promise<any | null> {
    const messages: Array<{ role: 'user'; content: string }> = [
      { role: 'user', content: extra ? `${prompt}\n\n${extra}` : prompt },
    ]
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 1500,
      system: buildSystemPrompt(eventNames),
      tools: [TOOL as any],
      tool_choice: { type: 'tool', name: 'emit_segment_definition' } as any,
      messages,
    })
    const block = (msg.content as any[]).find((b) => b.type === 'tool_use')
    return block ? block.input : null
  }

  // Generate → validate → (one repair retry) → preview.
  let out: any
  try {
    out = await callModel()
    let err = out ? validateDefinition(out) : 'model returned no tool call'
    if (err) {
      out = await callModel(`Your previous attempt was invalid: ${err}. Re-emit a corrected emit_segment_definition tool call.`)
      err = out ? validateDefinition(out) : 'model returned no tool call'
      if (err) return json(422, { success: false, error: `Could not build a valid segment: ${err}`, raw: out ?? null })
    }
  } catch (e) {
    const status = (e as { status?: number })?.status
    if (status === 429) return json(429, { success: false, error: 'AI usage limit reached, try again shortly' })
    return json(502, { success: false, error: 'LLM error: ' + (e instanceof Error ? e.message : 'unknown') })
  }

  const definition = { match: out.match, conditions: out.conditions }

  // Live preview (count + sample). Admin-gated; a non-admin caller errors here.
  let count = 0
  let sample: unknown[] = []
  const { data: preview, error: previewError } = await callerClient.rpc('segments_preview', { p_definition: definition, p_limit: 8 })
  if (previewError) {
    const msg = previewError.message || ''
    if (/permission|admin|denied|rls/i.test(msg)) return json(403, { success: false, error: 'Admin privileges required' })
    // Preview failed but the definition is valid — return it so the admin can still edit/use it.
    return json(200, { success: true, definition, suggested_name: out.suggested_name, explanation: out.explanation, warnings: [...(out.warnings ?? []), `Preview unavailable: ${msg}`], count: null, sample: [] })
  }
  count = (preview as { count?: number })?.count ?? 0
  sample = (preview as { sample?: unknown[] })?.sample ?? []

  return json(200, {
    success: true,
    definition,
    suggested_name: out.suggested_name,
    explanation: out.explanation,
    warnings: out.warnings ?? [],
    count,
    sample,
  })
}

export default handler
Deno.serve(handler)
