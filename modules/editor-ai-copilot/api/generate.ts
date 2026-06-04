/**
 * POST /api/admin/modules/editor-ai-copilot/generate
 *
 * The core AI generation endpoint. Resolves the target via the
 * polymorphic HostAdapter, builds the prompt + tool schema, calls
 * the LLM, validates output, persists an audit row, returns
 * PuckData.
 *
 * Per spec-canvas-ai-copilot.md §4.1.
 */

import type { Request, Response } from 'express';
import { canvasAiConfig, isCanvasAiUsable } from '../lib/canvas-ai-config.js';
import { checkGenerateRateLimit } from '../lib/rate-limiter.js';
import { insertAuditRow } from '../lib/audit-log.js';
import { getHostAdapter } from '../lib/host-adapter-registry.js';
import {
  buildGeneratePrompt,
  buildEditBlockPrompt,
  buildGenerateToolSchema,
  buildEditBlockToolSchema,
  type SourceDocSummary,
} from '../lib/prompt-builder.js';
import {
  validateGenerateOutput,
  validateEditBlockOutput,
} from '../lib/output-validator.js';
import { dispatchToolCall } from '../lib/web-tools/dispatch.js';
import { copilotStatusLabel } from '../lib/transcript.js';
// Phase-2: full skills-repo moved to @gatewaze-modules/ai. Editor
// keeps a minimal local shim with just the SkillRow type + the
// readSkillsByIds helper — see lib/skills/skills-repo.ts for the
// rationale (single-purpose, no business logic).
import { readSkillsByIds, readSkillByRef } from '../lib/skills/skills-repo.js';
import { selectActiveSkillsForPrompt, type SkillSelectionResult } from '../lib/skills/select-for-prompt.js';
import { editorUseCaseFor } from '../lib/use-case.js';
import {
  InvalidToolOutputError,
  ProviderError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  type BlockDefView,
  type GenerateMode,
  type HostKind,
  type AuditStatus,
  type ProviderName,
} from '../lib/types.js';

interface RequestWithUser extends Request {
  userId?: string;
}

// Structural Supabase surface this module needs. Must match the
// SupabaseLike used by audit-log.ts / rate-limiter.ts so we can hand
// the same client through without coercion.
interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: any | null }>;
}

interface CreateGenerateRouteDeps {
  supabase: SupabaseLike;
  logger: {
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    info: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
  assertCanAdminHost: (
    hostKind: HostKind,
    hostId: string,
    userId: string,
  ) => Promise<{ ok: true } | { ok: false; httpStatus: number; code: string; message: string }>;
}

interface GenerateRequestBody {
  host_kind?: HostKind;
  host_id?: string;
  target_id?: string;
  prompt?: string;
  mode?: GenerateMode;
  anchorBlockId?: string;
  blockId?: string;
  doc_ids?: string[];
  provider?: 'anthropic' | 'openai';
  model?: string;
  /**
   * Optional client-supplied block defs (newsletters' react-email
   * registry case). When present we bypass the DB query against
   * `templates_block_defs`. We still ajv-compile each entry's schema —
   * malformed defs are filtered out by the validator at output time,
   * and an attacker can't smuggle past the host adapter (which still
   * ran assertCanAdminHost above this point).
   */
  block_defs?: unknown[];
}

function sendError(res: Response, status: number, code: string, message: string, details?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });
}

export function createGenerateRoute(deps: CreateGenerateRouteDeps) {
  return async function generateHandler(req: RequestWithUser, res: Response): Promise<void> {
    if (!isCanvasAiUsable()) {
      sendError(res, 503, 'ai_provider_unavailable', 'no provider key configured or feature disabled');
      return;
    }
    const userId = req.userId;
    if (!userId) {
      sendError(res, 401, 'unauthenticated', 'session required');
      return;
    }
    const body = req.body as GenerateRequestBody;
    const hostKind = body.host_kind;
    const hostId = body.host_id;
    const targetId = body.target_id;
    const mode = body.mode;
    const prompt = (body.prompt ?? '').trim();

    if (!hostKind || !hostId || !targetId) {
      sendError(res, 400, 'invalid_input', 'host_kind, host_id, target_id required');
      return;
    }
    if (!mode) {
      sendError(res, 400, 'invalid_input', 'mode required');
      return;
    }
    if (!prompt) {
      sendError(res, 400, 'invalid_input', 'prompt required');
      return;
    }
    if (prompt.length > canvasAiConfig.maxPromptChars) {
      sendError(res, 400, 'invalid_input', `prompt exceeds ${canvasAiConfig.maxPromptChars} chars`);
      return;
    }
    if (mode === 'insert-after' && !body.anchorBlockId) {
      sendError(res, 400, 'invalid_input', 'mode=insert-after requires anchorBlockId');
      return;
    }
    if (mode === 'edit-block' && !body.blockId) {
      sendError(res, 400, 'invalid_input', 'mode=edit-block requires blockId');
      return;
    }
    if (body.doc_ids && body.doc_ids.length > canvasAiConfig.maxDocsPerRequest) {
      sendError(res, 400, 'invalid_input', `max ${canvasAiConfig.maxDocsPerRequest} doc_ids per request`);
      return;
    }

    // Turn context for transcript persistence — host_kind/host_id/target_id
    // are guaranteed non-null past the guards above.
    const turnCtx: TurnContext = { hostKind, hostId, targetId, userId, prompt };

    // Authorization — host-kind-aware. Falls back to assertCanAdminHost
    // from the route dep (which is the legacy canvas-auth helper).
    const auth = await deps.assertCanAdminHost(hostKind, hostId, userId);
    if (!auth.ok) {
      sendError(res, auth.httpStatus, auth.code, auth.message);
      return;
    }

    // Rate limits.
    const rate = await checkGenerateRateLimit(deps.supabase, userId, hostKind, hostId);
    if (!rate.ok) {
      res.setHeader('Retry-After', String(rate.retryAfterSec));
      sendError(res, 429, 'rate_limited', `quota exceeded (${rate.scope})`, {
        retry_after_seconds: rate.retryAfterSec,
        scope: rate.scope,
      });
      return;
    }

    // Resolve host → PuckData + library_id.
    const adapter = getHostAdapter(hostKind);
    if (!adapter) {
      sendError(res, 400, 'invalid_input', `no host adapter registered for ${hostKind}`);
      return;
    }
    let loaded: Awaited<ReturnType<typeof adapter.loadTarget>>;
    try {
      loaded = await adapter.loadTarget({ hostKind, hostId, targetId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'site_page_not_found' || msg === 'newsletter_edition_not_found' || msg === 'page_not_in_blocks_mode') {
        sendError(res, 404, 'not_found', msg);
        return;
      }
      sendError(res, 500, 'internal_error', msg);
      return;
    }

    // Block defs come from EITHER the client (preferred when supplied —
    // newsletters' react-email registry case, where no DB rows back the
    // available components) OR a DB query against `templates_block_defs`
    // (the sites case). Either way we end up with a `BlockDefView[]`
    // that the prompt-builder, tool-schema-builder, and output-validator
    // consume identically.
    let blockDefs: BlockDefView[];
    if (Array.isArray(body.block_defs) && body.block_defs.length > 0) {
      blockDefs = sanitiseClientBlockDefs(body.block_defs, loaded.themeKind);
    } else {
      const blockDefsRes = await deps.supabase
        .from('templates_block_defs')
        .select('id, key, name, description, schema, has_bricks, theme_kind')
        .eq('library_id', loaded.libraryId)
        .eq('is_current', true)
        .eq('theme_kind', loaded.themeKind);
      blockDefs = ((blockDefsRes?.data as BlockDefView[] | null) ?? [])
        .filter((d) => d.theme_kind === loaded.themeKind);
    }

    if (blockDefs.length === 0) {
      await writeAudit(deps, {
        hostKind, hostId, targetId,
        userId, prompt, mode,
        blockId: body.blockId ?? null,
        provider: 'anthropic', model: '?',
        inputTokens: 0, outputTokens: 0, durationMs: 0,
        status: 'no_blocks',
        blocksReturned: 0, blocksDropped: 0,
        docIds: body.doc_ids ?? [],
        warnings: [],
      });
      sendError(res, 422, 'ai_no_blocks', `no ${loaded.themeKind} blocks in this library — connect a theme repo`);
      return;
    }

    // Phase F — load source docs if any.
    let sourceDocs: SourceDocSummary[] = [];
    if (body.doc_ids && body.doc_ids.length > 0) {
      const nowIso = new Date().toISOString();
      const docsRes = await deps.supabase
        .from('canvas_ai_documents')
        .select('id, filename, source, extracted_text')
        .in('id', body.doc_ids)
        .eq('user_id', userId)
        .eq('host_kind', hostKind)
        .eq('host_id', hostId)
        .eq('target_id', targetId)
        .gt('expires_at', nowIso);
      type DocRow = { id: string; filename: string; source: 'upload' | 'url'; extracted_text: string };
      const docs = (docsRes?.data as DocRow[] | null) ?? [];
      if (docs.length !== body.doc_ids.length) {
        // At least one doc missing / expired / not owned.
        sendError(res, 404, 'not_found', 'one or more doc_ids are missing, expired, or belong to a different target');
        return;
      }
      sourceDocs = docs.map((d) => ({ doc_id: d.id, filename: d.filename, source: d.source, extracted_text: d.extracted_text }));
    }

    // AI Skills (git-driven brand guidelines). Killswitch gates the
    // whole subsystem; when disabled, generation proceeds without
    // brand-specific guidance. Otherwise we read the host's
    // `active_skill_ids`, look up the bodies in `ai_skills`, and run
    // them through the budget enforcer.
    const skillSelection = await loadActiveSkills(deps.supabase, hostKind, hostId);

    // Provider + model are now resolved inside @gatewaze-modules/ai's
    // runChat via ProviderRouter (per-user credentials + use_case
    // defaults from ai_use_cases). The editor only forwards optional
    // overrides — runChat validates the model against the use_case's
    // allowed_models allow-list. Audit logging gets the resolved
    // provider/model back via dispatchToolCall's return shape.

    // Build prompt + tool schema based on mode.
    if (mode === 'edit-block') {
      await handleEditBlockMode({
        deps, res, body, loaded, blockDefs, sourceDocs, userId, prompt, hostKind, hostId, targetId,
        skillSelection,
      });
      return;
    }

    // generate / append / insert-after / edit
    //
    // The current page state is ALWAYS passed to the prompt builder.
    // For edit mode it's the source-of-truth for the revision; for
    // other modes the prompt builder formats it as a read-only outline
    // so the AI can spot duplicates, reference specific blocks the
    // user mentioned, and avoid emitting conflicting content.
    const promptResult = buildGeneratePrompt({
      mode,
      hostKind,
      themeKind: loaded.themeKind,
      blockDefs,
      userPrompt: prompt,
      currentData: loaded.data,
      sourceDocs,
      activeSkills: skillSelection.included,
      ...(loaded.pageTitle ? { pageTitle: loaded.pageTitle } : {}),
      ...(loaded.pagePath ? { pagePath: loaded.pagePath } : {}),
    });
    const toolSchemaResult = buildGenerateToolSchema(blockDefs, { allowIdField: mode === 'edit' });
    const allWarnings: string[] = [...promptResult.warnings];
    if (toolSchemaResult.truncatedBlockKeys.length > 0) {
      allWarnings.push(`large_library_truncated: ${toolSchemaResult.truncatedBlockKeys.length} blocks dropped to fit tool-schema cap`);
    }

    let toolCall;
    try {
      toolCall = await dispatchToolCall({
        supabase: deps.supabase,
        systemPrompt: promptResult.systemPrompt,
        userPrompt: prompt,
        toolName: 'emit_page',
        toolDescription: 'Emit the page content in the structured format described.',
        toolInputSchema: toolSchemaResult.schema,
        maxOutputTokens: canvasAiConfig.maxOutputTokens,
        // Full-page/newsletter compose enables the web-tools loop
        // (web_search + fetch_url do multiple AI-module round-trips), so
        // it needs the longer web-tools wall-clock — not the 30s
        // single-shot providerTimeoutMs. Capping it at 30s is what made
        // a "build me a newsletter about <event>" request 504 with
        // ai_timeout mid-search. The AI module itself budgets 120s.
        timeoutMs: canvasAiConfig.webToolsTimeoutMs,
        userId,
        useCase: editorUseCaseFor(hostKind),
        ...(body.provider ? { providerOverride: body.provider } : {}),
        ...(body.model ? { modelOverride: body.model } : {}),
      });
    } catch (err) {
      await handleProviderError(deps, res, err, {
        hostKind, hostId, targetId, blockId: null,
        userId, prompt, mode,
        provider: (body.provider ?? 'anthropic') as ProviderName,
        docIds: body.doc_ids ?? [],
      });
      return;
    }

    const validation = validateGenerateOutput({
      output: toolCall.input,
      blockDefs,
      mode,
      ...(mode === 'edit' ? { currentData: loaded.data } : {}),
    });
    allWarnings.push(...validation.warnings);

    let status: AuditStatus;
    if (validation.blocksReturned === 0) {
      status = 'invalid_output';
    } else if (validation.data.content.length === 0) {
      status = 'validation_dropped_all';
    } else {
      status = 'ok';
    }

    const auditId = await writeAudit(deps, {
      hostKind, hostId, targetId,
      userId, prompt, mode,
      blockId: body.blockId ?? null,
      provider: editorProvider(toolCall.providerName), model: toolCall.model,
      inputTokens: toolCall.inputTokens, outputTokens: toolCall.outputTokens, durationMs: toolCall.durationMs,
      status,
      blocksReturned: validation.blocksReturned, blocksDropped: validation.blocksDropped,
      docIds: body.doc_ids ?? [],
      warnings: allWarnings,
      ...skillsAuditFields(skillSelection),
      webSearches: toolCall.webSearches,
      fetchedUrls: toolCall.fetchedUrls,
    });

    if (status !== 'ok') {
      // Three failure shapes:
      //   - blocksReturned === 0 → the LLM produced an empty content
      //     array. Per the system prompt this is the formal "refusal"
      //     signal: the AI couldn't fulfil the request without
      //     fabricating facts (e.g. asked to research an event it
      //     doesn't have grounded info for). Tell the user explicitly
      //     — the canvas isn't a surface for AI apologies.
      //   - blocksReturned > 0 but everything was dropped → schema
      //     violations etc. The drop_reasons explain why.
      const friendly =
        validation.blocksReturned === 0
          ? "The AI couldn't fulfil this request without making up facts. Try giving it the details (dates, names, venue, links), attaching a source document via the + button, or asking it to write a placeholder draft you'll fill in."
          : `${validation.blocksDropped} of ${validation.blocksReturned} blocks failed validation. See drop_reasons for details.`;
      const errorCode =
        validation.blocksReturned === 0 ? 'ai_needs_info' : 'ai_invalid_output';
      void persistCopilotTurn(deps, turnCtx, { ok: false, errorCode, message: friendly });
      sendError(res, 422, errorCode, friendly, {
        drop_reasons: validation.dropReasons,
        blocks_returned: validation.blocksReturned,
        blocks_dropped: validation.blocksDropped,
      });
      return;
    }

    void persistCopilotTurn(deps, turnCtx, {
      ok: true,
      statusLabel: copilotStatusLabel(mode, validation.data.content.length),
      inputTokens: toolCall.inputTokens,
      outputTokens: toolCall.outputTokens,
      durationMs: toolCall.durationMs,
      costApprox: toolCall.costMicroUsd / 1_000_000,
      provider: editorProvider(toolCall.providerName),
      model: toolCall.model,
    });

    res.status(200).json({
      data: validation.data,
      warnings: allWarnings,
      usage: {
        input_tokens: toolCall.inputTokens,
        output_tokens: toolCall.outputTokens,
        provider: editorProvider(toolCall.providerName),
        model: toolCall.model,
        duration_ms: toolCall.durationMs,
        cost_micro_usd: toolCall.costMicroUsd,
      },
      // Per spec-ai-chatbot-web-search.md §5.2 — operators see what
      // tools the model used. Both arrays are empty unless web tools
      // were enabled for this request.
      tool_calls: {
        web_searches: toolCall.webSearches,
        fetched_urls: toolCall.fetchedUrls,
      },
      audit_id: auditId,
    });
  };
}

// ---------------------------------------------------------------------------

interface HandleEditBlockArgs {
  deps: CreateGenerateRouteDeps;
  res: Response;
  body: GenerateRequestBody;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  loaded: any;
  blockDefs: BlockDefView[];
  sourceDocs: SourceDocSummary[];
  userId: string;
  prompt: string;
  hostKind: HostKind;
  hostId: string;
  targetId: string;
  skillSelection: SkillSelectionResult;
}

async function handleEditBlockMode(args: HandleEditBlockArgs): Promise<void> {
  const blockId = args.body.blockId!;
  const ebCtx: TurnContext = {
    hostKind: args.hostKind,
    hostId: args.hostId,
    targetId: args.targetId,
    userId: args.userId,
    prompt: args.prompt,
  };
  // Find the block in the loaded tree (recursive walk for nested bricks).
  const block = findBlock(args.loaded.data.content, blockId);
  if (!block) {
    await writeAudit(args.deps, {
      hostKind: args.hostKind, hostId: args.hostId, targetId: args.targetId,
      userId: args.userId, prompt: args.prompt, mode: 'edit-block',
      blockId,
      provider: (args.body.provider ?? 'anthropic') as ProviderName, model: '?',
      inputTokens: 0, outputTokens: 0, durationMs: 0,
      status: 'block_not_found',
      blocksReturned: 0, blocksDropped: 0,
      docIds: args.body.doc_ids ?? [],
      warnings: [],
      ...skillsAuditFields(args.skillSelection),
    });
    sendError(args.res, 404, 'block_not_found', 'blockId not on this page');
    return;
  }
  const def = args.blockDefs.find((d) => d.key === block.type);
  if (!def) {
    sendError(args.res, 422, 'ai_invalid_output', `block type ${block.type} has no current def (theme drift)`);
    return;
  }

  const promptResult = buildEditBlockPrompt({
    blockDef: def,
    currentProps: block.props,
    currentData: args.loaded.data,
    blockId,
    userPrompt: args.prompt,
    sourceDocs: args.sourceDocs,
    activeSkills: args.skillSelection.included,
  });
  const toolSchema = buildEditBlockToolSchema(def);

  let toolCall;
  try {
    toolCall = await dispatchToolCall({
      supabase: args.deps.supabase,
      systemPrompt: promptResult.systemPrompt,
      userPrompt: args.prompt,
      toolName: 'emit_block_props',
      toolDescription: 'Emit the updated block props in the structured format described.',
      toolInputSchema: toolSchema,
      maxOutputTokens: canvasAiConfig.maxOutputTokens,
      timeoutMs: canvasAiConfig.providerTimeoutMs,
      userId: args.userId,
      useCase: editorUseCaseFor(args.hostKind),
      ...(args.body.provider ? { providerOverride: args.body.provider } : {}),
      ...(args.body.model ? { modelOverride: args.body.model } : {}),
    });
  } catch (err) {
    await handleProviderError(args.deps, args.res, err, {
      hostKind: args.hostKind, hostId: args.hostId, targetId: args.targetId, blockId,
      userId: args.userId, prompt: args.prompt, mode: 'edit-block',
      provider: (args.body.provider ?? 'anthropic') as ProviderName,
      docIds: args.body.doc_ids ?? [],
    });
    return;
  }

  const validation = validateEditBlockOutput(toolCall.input, def);
  if (!validation.ok) {
    await writeAudit(args.deps, {
      hostKind: args.hostKind, hostId: args.hostId, targetId: args.targetId,
      userId: args.userId, prompt: args.prompt, mode: 'edit-block',
      blockId,
      provider: editorProvider(toolCall.providerName), model: toolCall.model,
      inputTokens: toolCall.inputTokens, outputTokens: toolCall.outputTokens, durationMs: toolCall.durationMs,
      status: 'invalid_output',
      blocksReturned: 1, blocksDropped: 1,
      docIds: args.body.doc_ids ?? [],
      warnings: [],
      ...skillsAuditFields(args.skillSelection),
      webSearches: toolCall.webSearches,
      fetchedUrls: toolCall.fetchedUrls,
    });
    void persistCopilotTurn(args.deps, ebCtx, { ok: false, errorCode: 'ai_invalid_output', message: validation.reason });
    sendError(args.res, 422, 'ai_invalid_output', validation.reason, validation.details as Record<string, unknown> | undefined);
    return;
  }

  const auditId = await writeAudit(args.deps, {
    hostKind: args.hostKind, hostId: args.hostId, targetId: args.targetId,
    userId: args.userId, prompt: args.prompt, mode: 'edit-block',
    blockId,
    provider: editorProvider(toolCall.providerName), model: toolCall.model,
    inputTokens: toolCall.inputTokens, outputTokens: toolCall.outputTokens, durationMs: toolCall.durationMs,
    status: 'ok',
    blocksReturned: 1, blocksDropped: 0,
    docIds: args.body.doc_ids ?? [],
    warnings: validation.warnings,
    ...skillsAuditFields(args.skillSelection),
    webSearches: toolCall.webSearches,
    fetchedUrls: toolCall.fetchedUrls,
  });

  void persistCopilotTurn(args.deps, ebCtx, {
    ok: true,
    statusLabel: copilotStatusLabel('edit-block', 1),
    inputTokens: toolCall.inputTokens,
    outputTokens: toolCall.outputTokens,
    durationMs: toolCall.durationMs,
    costApprox: toolCall.costMicroUsd / 1_000_000,
    provider: editorProvider(toolCall.providerName),
    model: toolCall.model,
  });

  args.res.status(200).json({
    data: {
      content: [{ type: block.type, props: { id: blockId, ...validation.props } }],
      root: { props: {} },
    },
    warnings: validation.warnings,
    usage: {
      input_tokens: toolCall.inputTokens,
      output_tokens: toolCall.outputTokens,
      provider: editorProvider(toolCall.providerName),
      model: toolCall.model,
      duration_ms: toolCall.durationMs,
      cost_micro_usd: toolCall.costMicroUsd,
    },
    tool_calls: {
      web_searches: toolCall.webSearches,
      fetched_urls: toolCall.fetchedUrls,
    },
    audit_id: auditId,
  });
}

/**
 * Validate client-supplied block defs and coerce to BlockDefView[].
 * Drops entries that lack a key, name, or compileable JSON schema —
 * those would crash ajv downstream anyway. Caller has already passed
 * the host-admin check, so this is shape validation, not authorisation.
 */
function sanitiseClientBlockDefs(raw: unknown[], themeKind: 'website' | 'email'): BlockDefView[] {
  const out: BlockDefView[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.key !== 'string' || obj.key.length === 0) continue;
    if (typeof obj.name !== 'string' || obj.name.length === 0) continue;
    if (!obj.schema || typeof obj.schema !== 'object' || Array.isArray(obj.schema)) continue;
    out.push({
      id: typeof obj.id === 'string' ? obj.id : `client:${i}`,
      key: obj.key,
      name: obj.name,
      description: typeof obj.description === 'string' ? obj.description : null,
      schema: obj.schema as Record<string, unknown>,
      has_bricks: typeof obj.has_bricks === 'boolean' ? obj.has_bricks : false,
      // Force the theme to match what the host adapter declared — we
      // don't trust the client to flip this and bypass cross-theme
      // generation (e.g. asking for website blocks on an email host).
      theme_kind: themeKind,
    });
  }
  return out;
}

interface BlockEntry {
  type: string;
  props: { id: string; children?: BlockEntry[]; [k: string]: unknown };
}

/**
 * The editor's audit log only tracks 'anthropic' | 'openai' (the
 * provider columns predate Gemini support). When runChat resolves
 * a Gemini model we collapse it onto 'openai' for audit-log purposes
 * — the per-call cost row in ai_usage_events still carries the
 * accurate provider for billing.
 */
function editorProvider(p: 'anthropic' | 'openai' | 'gemini'): ProviderName {
  return p === 'anthropic' ? 'anthropic' : 'openai';
}

function findBlock(content: ReadonlyArray<BlockEntry>, blockId: string): BlockEntry | null {
  for (const b of content) {
    if (b.props.id === blockId) return b;
    if (Array.isArray(b.props.children)) {
      const inner = findBlock(b.props.children as BlockEntry[], blockId);
      if (inner) return inner;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Resolve the active skills for a host, applying the inherit/override
 * model introduced in migration 005:
 *
 *   - host.active_skill_ids = NULL  → INHERIT the use case's default
 *     brand skill (ai_use_cases.skill_source_id / skill_path for
 *     newsletter-editor / site-editor).
 *   - host.active_skill_ids = '{}'  → explicit opt-out, no skills.
 *   - host.active_skill_ids = '{…}' → override with exactly that list.
 *
 * When `skillsEnabled` is false (killswitch) we return an empty
 * selection. Errors are swallowed and reported via the empty selection:
 * generation proceeds without brand voice rather than failing.
 */
async function loadActiveSkills(
  supabase: SupabaseLike,
  hostKind: HostKind,
  hostId: string,
): Promise<SkillSelectionResult> {
  const empty: SkillSelectionResult = { included: [], dropped: [], totalIncludedChars: 0, audit: [] };
  if (!canvasAiConfig.skillsEnabled) return empty;

  try {
    const hostTable = hostKind === 'newsletter' ? 'newsletters_template_collections' : 'sites';
    const hostRes = await supabase
      .from(hostTable)
      .select('active_skill_ids')
      .eq('id', hostId)
      .maybeSingle();
    // `null`/`undefined` (column NULL) = inherit; an array (incl. empty)
    // = explicit override.
    const activeIds = (hostRes?.data as { active_skill_ids?: string[] | null } | null)?.active_skill_ids;

    if (activeIds == null) {
      const defaultSkill = await loadUseCaseDefaultSkill(supabase, hostKind);
      if (!defaultSkill) return empty;
      return selectActiveSkillsForPrompt([defaultSkill], canvasAiConfig.maxSkillsBytes);
    }

    if (activeIds.length === 0) return empty;

    const skills = await readSkillsByIds(supabase, activeIds);
    return selectActiveSkillsForPrompt(skills, canvasAiConfig.maxSkillsBytes);
  } catch {
    return empty;
  }
}

/**
 * Resolve the default brand skill bound to this host kind's editor use
 * case via its (skill_source_id, skill_path) soft reference. Returns
 * null when the use case has no skill bound or the row is missing/
 * unparsed, in which case inheriting hosts simply get no skills.
 */
async function loadUseCaseDefaultSkill(
  supabase: SupabaseLike,
  hostKind: HostKind,
): Promise<Awaited<ReturnType<typeof readSkillByRef>> | null> {
  const ucRes = await supabase
    .from('ai_use_cases')
    .select('skill_source_id, skill_path')
    .eq('id', editorUseCaseFor(hostKind))
    .maybeSingle();
  const ref = ucRes?.data as { skill_source_id?: string | null; skill_path?: string | null } | null;
  if (!ref?.skill_source_id || !ref.skill_path) return null;
  return readSkillByRef(supabase, ref.skill_source_id, ref.skill_path);
}

/**
 * Build the audit-row skill payload (ids / hashes / truncations) from
 * a SkillSelectionResult. Returns a partial-AuditRow that callers can
 * spread into their full audit-row.
 */
function skillsAuditFields(selection: SkillSelectionResult): {
  activeSkillIds: string[];
  activeSkillHashes: string[];
  activeSkillTruncations: SkillSelectionResult['audit'];
} {
  return {
    activeSkillIds: selection.included.map((s) => s.id),
    activeSkillHashes: selection.included.map((s) => s.content_hash),
    activeSkillTruncations: selection.audit,
  };
}

async function writeAudit(deps: CreateGenerateRouteDeps, row: Parameters<typeof insertAuditRow>[1]): Promise<string | null> {
  const r = await insertAuditRow(deps.supabase, row);
  if (!r.ok) {
    deps.logger.warn('canvas_ai_audit_insert_failed', { error: r.error });
    return null;
  }
  // NOTE: the cost row in ai_usage_events is written by
  // @gatewaze-modules/ai's runChat (the single source of truth for
  // billing), tagged with the host-kind editor use case
  // (newsletter-editor / site-editor), on every terminal
  // path — success, provider error/timeout/rate-limit, and budget-block.
  // The canvas_ai_audit_log row written here is the editor's own
  // block-level audit (which blocks dropped, which skills were active),
  // NOT a second billing record. A prior `recordEditorUsage` helper that
  // also wrote to ai_usage_events was removed: it read snake_case fields
  // off the camelCase AuditRow (so it was silently a no-op) and, had it
  // ever resolved, would have double-counted every LLM row runChat
  // already records.
  return r.id;
}

// ---------------------------------------------------------------------------
// Transcript persistence — DB-backed copilot chat history.
//
// Each completed turn writes a user + assistant row to the ai module's
// ai_threads / ai_messages tables, keyed by the natural 4-tuple
// (use_case, host_kind, host_id, thread_key=target_id) where use_case is
// the host-kind editor use case (newsletter-editor / site-editor).
// The sidebar rehydrates from these on reload. Best-effort: a failure
// here never blocks the generate response (mirrors writeAudit). The
// server is the source of truth and re-derives the thread from the
// request on every call, so the client never has to track a thread id.

interface TurnContext {
  hostKind: HostKind;
  hostId: string;
  targetId: string;
  userId: string;
  prompt: string;
}

type TurnOutcome =
  | {
      ok: true;
      statusLabel: string;
      inputTokens: number;
      outputTokens: number;
      durationMs: number;
      costApprox: number;
      provider: ProviderName;
      model: string;
    }
  | { ok: false; errorCode: string; message: string };

async function ensureCopilotThread(deps: CreateGenerateRouteDeps, ctx: TurnContext): Promise<string | null> {
  const sb = deps.supabase;
  const useCase = editorUseCaseFor(ctx.hostKind);
  const byKey = () =>
    sb
      .from('ai_threads')
      .select('id')
      .eq('use_case', useCase)
      .eq('host_kind', ctx.hostKind)
      .eq('host_id', ctx.hostId)
      .eq('thread_key', ctx.targetId)
      .maybeSingle();

  const sel = await byKey();
  if (sel?.data?.id) return sel.data.id as string;

  const ins = await sb
    .from('ai_threads')
    .insert({
      use_case: useCase,
      host_kind: ctx.hostKind,
      host_id: ctx.hostId,
      thread_key: ctx.targetId,
      status: 'idle',
      created_by: ctx.userId,
    })
    .select('id')
    .maybeSingle();
  if (ins?.data?.id) return ins.data.id as string;

  // Lost an insert race against a concurrent turn — re-select the winner.
  const re = await byKey();
  return (re?.data?.id as string) ?? null;
}

async function persistCopilotTurn(deps: CreateGenerateRouteDeps, ctx: TurnContext, outcome: TurnOutcome): Promise<void> {
  try {
    const threadId = await ensureCopilotThread(deps, ctx);
    if (!threadId) return;

    await deps.supabase.from('ai_messages').insert({
      thread_id: threadId,
      role: 'user',
      status: 'complete',
      content: ctx.prompt,
      created_by: ctx.userId,
    });

    if (outcome.ok) {
      await deps.supabase.from('ai_messages').insert({
        thread_id: threadId,
        role: 'assistant',
        status: 'complete',
        content: '',
        structured: {
          copilot: { status_label: outcome.statusLabel, status_state: 'success' },
          usage: {
            tokens: outcome.inputTokens + outcome.outputTokens,
            cost_approx: outcome.costApprox,
            duration_ms: outcome.durationMs,
          },
        },
        provider: outcome.provider,
        model: outcome.model,
        input_tokens: outcome.inputTokens,
        output_tokens: outcome.outputTokens,
        cost_micro_usd: Math.round(outcome.costApprox * 1_000_000),
        latency_ms: outcome.durationMs,
        created_by: ctx.userId,
      });
    } else {
      await deps.supabase.from('ai_messages').insert({
        thread_id: threadId,
        role: 'assistant',
        status: 'failed',
        content: outcome.message,
        structured: { copilot: { status_label: `Error: ${outcome.errorCode}`, status_state: 'error' } },
        error_code: outcome.errorCode,
        error_message: outcome.message,
        created_by: ctx.userId,
      });
    }
  } catch (err) {
    deps.logger.warn('copilot.transcript_persist_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface ProviderErrCtx {
  hostKind: HostKind;
  hostId: string;
  targetId: string;
  blockId: string | null;
  userId: string;
  prompt: string;
  mode: GenerateMode;
  provider: 'anthropic' | 'openai';
  docIds: ReadonlyArray<string>;
}

async function handleProviderError(
  deps: CreateGenerateRouteDeps,
  res: Response,
  err: unknown,
  ctx: ProviderErrCtx,
): Promise<void> {
  let status: AuditStatus = 'provider_error';
  let httpStatus = 502;
  let code = 'ai_provider_error';
  let message = err instanceof Error ? err.message : String(err);
  let retryAfter: number | null = null;

  if (err instanceof ProviderTimeoutError) {
    status = 'timeout';
    httpStatus = 504;
    code = 'ai_timeout';
    message = 'provider exceeded wall-clock';
  } else if (err instanceof ProviderRateLimitError) {
    status = 'rate_limited';
    httpStatus = 429;
    code = 'rate_limited';
    message = 'upstream provider rate limited';
    retryAfter = err.retryAfterSeconds;
  } else if (err instanceof ProviderError) {
    httpStatus = 502;
    code = 'ai_provider_error';
    // Surface the upstream detail (Anthropic / OpenAI error body). The
    // SDK's err.message contains the full response body for 4xx errors;
    // earlier this only logged `<provider> <status>`, which made
    // debugging tool/schema rejections impossible.
    message = `${err.provider} ${err.upstreamStatus}: ${err.message}`;
    // eslint-disable-next-line no-console
    console.error('[editor-ai-copilot] provider error', {
      provider: err.provider,
      status: err.upstreamStatus,
      detail: err.message,
    });
  } else if (err instanceof InvalidToolOutputError) {
    status = 'invalid_output';
    httpStatus = 422;
    code = 'ai_invalid_output';
    message = err.message;
  }

  await writeAudit(deps, {
    hostKind: ctx.hostKind, hostId: ctx.hostId, targetId: ctx.targetId,
    userId: ctx.userId, prompt: ctx.prompt, mode: ctx.mode,
    blockId: ctx.blockId,
    provider: ctx.provider, model: '?',
    inputTokens: 0, outputTokens: 0, durationMs: 0,
    status,
    blocksReturned: 0, blocksDropped: 0,
    docIds: ctx.docIds,
    warnings: [message],
  });

  void persistCopilotTurn(
    deps,
    { hostKind: ctx.hostKind, hostId: ctx.hostId, targetId: ctx.targetId, userId: ctx.userId, prompt: ctx.prompt },
    { ok: false, errorCode: code, message },
  );

  if (retryAfter !== null) res.setHeader('Retry-After', String(retryAfter));
  sendError(res, httpStatus, code, message);
}
