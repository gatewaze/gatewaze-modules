/**
 * REST endpoints under /api/v1/fetch/* (spec §5).
 *
 * Phase 2 vertical slice: full handler for POST /api/v1/fetch in mode:fast,
 * plus GET /api/v1/fetch/quota. Phase 3 fills out screenshot, audit
 * listing, and the remaining modes / extraction kinds.
 */

import type { Router, Request, Response } from 'express';
import type { PublicApiContext } from '@gatewaze/shared';
import { z } from 'zod';

import { resolveSettings, resolveUserAgent } from './lib/settings.js';
import { parseAndNormalize, InvalidUrlError } from './lib/normalize.js';
import { evaluateHost } from './lib/domains.js';
import { evaluateRobots } from './lib/robots.js';
import {
  ScraplingFetcherClient,
  UpstreamError,
} from './lib/client.js';
import { getCircuitBreaker } from './lib/circuitBreaker.js';
import {
  readDomainRules,
  debitAndStart,
  writeBlockedAuditRow,
  finalizeAuditRow,
  reconcileQuotaAndLedger,
} from './lib/db.js';
import { newUlid, insertRefund } from './lib/ledger.js';
import { buildTruncatedRequest } from './lib/audit.js';
import { defaultLimits, toQuotaState } from './lib/quotas.js';
import { uploadAndSign } from './lib/storage.js';
import {
  cacheKey as buildIdempotencyKey,
  getIdempotencyBackend,
} from './lib/idempotency.js';
import type {
  ApiKeyContext,
  ErrorClass,
  ExtractKind,
  FetchInput,
  FetchMode,
  ResponseStorage,
  SuccessEnvelope,
  Surface,
} from './lib/types.js';

// -------------------------------------------------- request validation
const RequestSchema = z.object({
  url: z.string().url().max(2048),
  mode: z.enum(['fast', 'stealth', 'browser']).default('fast'),
  extract: z
    .array(z.enum(['html', 'markdown', 'metadata', 'next_data', 'links', 'json_ld']))
    .default(['html']),
  wait_for: z.string().max(256).nullable().optional(),
  timeout_ms: z.number().int().min(1000).max(60000).default(30000),
  ignore_robots: z.boolean().default(false),
  screenshot: z.union([z.boolean(), z.object({}).passthrough()]).default(false),
  user_agent: z
    .string()
    .max(256)
    // §5.1 anti-spoofing
    .regex(/^[\x20-\x7e]+$/u, 'user_agent must be printable ASCII without control chars')
    .refine(
      (v) =>
        !/(googlebot|bingbot|applebot|duckduckbot|yandexbot|baiduspider|gptbot)/i.test(v),
      'user_agent contains a disallowed bot identifier',
    )
    .nullable()
    .optional(),
  response_storage: z.enum(['inline', 'signed_url', 'signed-url']).default('inline'),
});

type ValidatedFetchInput = z.infer<typeof RequestSchema>;

// -------------------------------------------------- registration
export async function registerPublicApiRoutes(
  router: unknown,
  ctx: PublicApiContext,
): Promise<void> {
  const r = router as Router;
  const settings = resolveSettings(ctx.moduleConfig);

  // Resolve and freeze the robots UA at module init.
  const instanceHost = process.env.GATEWAZE_INSTANCE_HOST ?? 'localhost';
  let robotsUserAgent: string;
  try {
    robotsUserAgent = resolveUserAgent(settings.robots_user_agent_template, instanceHost);
  } catch (e) {
    ctx.logger.error('failed to resolve robots UA template', { err: (e as Error).message });
    throw e;
  }

  // scrapling-fetcher backend — REQUIRED env at boot.
  const backendUrl = process.env.GATEWAZE_FETCH_BACKEND_URL;
  const internalToken = process.env.SCRAPLING_INTERNAL_TOKEN;
  if (!backendUrl || !internalToken) {
    ctx.logger.error('GATEWAZE_FETCH_BACKEND_URL and SCRAPLING_INTERNAL_TOKEN are required');
    throw new Error('gatewaze-fetch: missing backend configuration');
  }
  const client = new ScraplingFetcherClient({
    baseUrl: backendUrl,
    internalToken,
  });

  const breaker = getCircuitBreaker();

  // Lifted to outer scope so all route handlers (POST /, GET /quota,
  // GET /audit, POST /screenshot) share the same supabase client.
  const supabase = ctx.supabase as never as import('@supabase/supabase-js').SupabaseClient;

  // ---- POST /fetch -------------------------------------------------
  r.post('/', ctx.requireScope('read') as never, async (req: Request, res: Response) => {
    const requestId = req.header('x-request-id') ?? newUlid();
    res.setHeader('x-request-id', requestId);

    const apiKey = (req as Request & { apiKey?: ApiKeyContext }).apiKey;
    if (!apiKey) {
      return sendError(res, requestId, 401, 'UNAUTHORIZED', 'API key required.', false);
    }

    // ---- §9.3 step 1: validation -----------------------------------
    const parsed = RequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(
        res,
        requestId,
        400,
        'VALIDATION_ERROR',
        'Request body failed validation.',
        false,
        { issues: parsed.error.issues },
      );
    }
    const input = parsed.data;

    // ---- §4.3 scope mapping ---------------------------------------
    // mode-based scopes
    if (input.mode === 'stealth' && !apiKey.scopes.includes('gatewaze-fetch:stealth')) {
      return sendError(res, requestId, 403, 'SCOPE_REQUIRED', 'gatewaze-fetch:stealth scope required.', false);
    }
    if (input.mode === 'browser' && !apiKey.scopes.includes('gatewaze-fetch:browser')) {
      return sendError(res, requestId, 403, 'SCOPE_REQUIRED', 'gatewaze-fetch:browser scope required.', false);
    }
    // screenshot implies browser. After zod parsing `input.screenshot`
    // is `boolean | object`; `wantsScreenshot` is true for either
    // `true` or any object value. We avoid `=== false` because zod's
    // inferred union narrows away the literal-false case after the
    // truthiness check.
    const wantsScreenshot = !!input.screenshot;
    if (wantsScreenshot) {
      if (input.mode !== 'fast' && input.mode !== 'browser') {
        return sendError(res, requestId, 400, 'VALIDATION_ERROR', 'screenshot requires mode: browser.', false);
      }
      if (!apiKey.scopes.includes('gatewaze-fetch:screenshot')) {
        return sendError(res, requestId, 403, 'SCOPE_REQUIRED', 'gatewaze-fetch:screenshot scope required.', false);
      }
      // Auto-upgrade fast → browser for screenshot (per §5.3 screenshot
      // implies browser). Audit will record mode_used = 'browser' from upstream.
      input.mode = 'browser' as FetchMode;
      if (!apiKey.scopes.includes('gatewaze-fetch:browser')) {
        return sendError(res, requestId, 403, 'SCOPE_REQUIRED', 'gatewaze-fetch:browser scope required for screenshot.', false);
      }
    }
    // ignore_robots requires its own scope on top
    if (input.ignore_robots && !apiKey.scopes.includes('gatewaze-fetch:ignore-robots')) {
      return sendError(res, requestId, 403, 'SCOPE_REQUIRED', 'gatewaze-fetch:ignore-robots scope required.', false);
    }

    // extraction-kind scope: any non-html/non-empty extract requires
    // gatewaze-fetch:extract. `next_data` is provided by scrapling-fetcher
    // server-side and is treated as a passthrough (no extract scope needed).
    const extractKinds: ExtractKind[] = input.extract;
    const requiresExtractScope = extractKinds.some(
      k => k !== 'html' && k !== 'next_data',
    );
    if (requiresExtractScope && !apiKey.scopes.includes('gatewaze-fetch:extract')) {
      return sendError(res, requestId, 403, 'SCOPE_REQUIRED', 'gatewaze-fetch:extract scope required.', false);
    }

    // ---- §9.3 step 1 (continued): URL parse -------------------------
    let url;
    try {
      url = parseAndNormalize(input.url);
    } catch (e) {
      const msg = e instanceof InvalidUrlError ? e.message : 'invalid url';
      return sendError(res, requestId, 400, 'INVALID_URL', msg, false);
    }

    // ---- §9.3 step 2: circuit breaker probe ------------------------
    if (breaker.isOpen()) {
      const retryAfter = breaker.retryAfterSeconds();
      res.setHeader('Retry-After', String(retryAfter));
      ctx.logger.warn('gw_fetch.circuit_open_reject', {
        request_id: requestId,
        api_key_prefix: apiKey.prefix,
        url_host: url.host,
        retry_after_s: retryAfter,
      });
      return sendError(
        res,
        requestId,
        503,
        'SERVICE_UNAVAILABLE',
        'Upstream is temporarily unavailable.',
        true,
      );
    }

    // Read domain rules once (used for both pre-fetch and post-fetch checks).
    const rules = await readDomainRules(supabase, apiKey.id);
    const truncatedRequest = buildTruncatedRequest(
      input as FetchInput,
      settings.fetch_audit_redact_query_params,
    );

    // ---- §9.3 step 2a: idempotency-cache lookup --------------------
    // Check the Idempotency-Key header; on cache hit, replay the prior
    // response WITHOUT writing audit/ledger/quota. (RPM rate-limit
    // bucket has already been debited by upstream middleware.)
    const idempotencyKey = req.header('idempotency-key') ?? null;
    const idem = getIdempotencyBackend();
    const idemTtl = settings.idempotency_ttl_seconds;
    let idemKey: string | null = null;
    if (idempotencyKey && idemTtl > 0) {
      idemKey = buildIdempotencyKey({
        apiKeyId: apiKey.id,
        idempotencyKey,
        canonicalBody: JSON.stringify(input),
        domainRulesVersion: rules.version,
        robotsOriginVersion: 0, // resolved below per-origin; for the cache key we use 0 cold-start
      });
      const hit = await idem.get(idemKey);
      if (hit && hit.expiresAt > Date.now()) {
        res.setHeader('x-request-id', hit.requestId);
        res.setHeader('idempotency-replay', 'true');
        res.status(hit.status).type('application/json').send(hit.responseBody);
        return;
      }
    }

    // ---- §9.3 step 3: pre-fetch domain governance ------------------
    const preDecision = evaluateHost(url.host, {
      instanceDeny: rules.instanceDeny,
      instanceAllow: rules.instanceAllow,
      keyDeny: rules.keyDeny,
      keyAllow: rules.keyAllow,
    });
    if (!preDecision.ok) {
      await writeBlockedAuditRow(supabase, {
        requestId,
        apiKeyId: apiKey.id,
        surface: 'rest',
        requestedUrl: url.href,
        urlHost: url.host,
        mode: input.mode,
        blockedBy: preDecision.rule,
        blockedStage: 'pre_fetch',
        status: 403,
        truncatedRequest,
      });
      return sendError(
        res,
        requestId,
        403,
        'DOMAIN_BLOCKED',
        'URL host is blocked by domain governance.',
        false,
        { rule: preDecision.rule, pattern: preDecision.pattern },
      );
    }

    // ---- §9.3 step 4: robots.txt evaluation ------------------------
    const effectiveUa = input.user_agent ?? robotsUserAgent;
    if (!input.ignore_robots) {
      const robots = await evaluateRobots(url, effectiveUa, {
        db: makeDbAdapter(supabase),
        settings,
        fetchRobots: async (origin: string) => {
          // Use scrapling-fetcher to fetch robots.txt — keeps the §0.1
          // network-egress invariant.
          try {
            const out = await client.fetch({
              url: `${origin}/robots.txt`,
              mode: 'fast',
              extract_next_data: false,
              wait_for: null,
              timeout_ms: 5000,
              proxy: 'never',
              api_key_id: apiKey.id,
              user_agent: robotsUserAgent,
            });
            return { status: out.status, body: out.html };
          } catch (e) {
            return { status: 0, body: '', error: (e as Error).message };
          }
        },
      });
      if (!robots.ok) {
        await writeBlockedAuditRow(supabase, {
          requestId,
          apiKeyId: apiKey.id,
          surface: 'rest',
          requestedUrl: url.href,
          urlHost: url.host,
          mode: input.mode,
          blockedBy: 'robots',
          blockedStage: 'robots',
          status: 403,
          truncatedRequest,
        });
        return sendError(
          res,
          requestId,
          403,
          'ROBOTS_DISALLOWED',
          'URL is disallowed by robots.txt.',
          false,
          {
            robots_url: robots.robots_url,
            user_agent: robots.user_agent,
            rule_line: robots.disallowed_by,
          },
        );
      }
    }

    // ---- §9.3 step 5: debit + ledger + audit-start (one tx) -------
    const debitId = newUlid();
    const limits = defaultLimits(settings);
    const browserSecondsEstimate =
      input.mode === 'browser' ? settings.browser_seconds_reservation : 0;
    const debit = await debitAndStart(supabase, {
      apiKeyId: apiKey.id,
      requestId,
      debitId,
      surface: 'rest',
      requestedUrl: url.href,
      urlHost: url.host,
      mode: input.mode,
      ignoredRobots: input.ignore_robots ?? false,
      userAgentUsed: effectiveUa,
      truncatedRequest,
      requestsLimit: limits.requests_limit,
      browserSecondsLimit: limits.browser_seconds_limit,
      proxyBytesLimit: limits.proxy_bytes_limit,
      browserSecondsEstimate,
      costUsdEstimate: settings.cost_usd_per_request +
        browserSecondsEstimate * settings.cost_usd_per_browser_second,
    });
    if (!debit.ok) {
      await writeBlockedAuditRow(supabase, {
        requestId,
        apiKeyId: apiKey.id,
        surface: 'rest',
        requestedUrl: url.href,
        urlHost: url.host,
        mode: input.mode,
        blockedBy: 'quota',
        blockedStage: 'quota',
        status: 429,
        truncatedRequest,
      });
      return sendError(
        res,
        requestId,
        429,
        'QUOTA_EXHAUSTED',
        `Monthly quota exceeded for dimension '${debit.dimension}'.`,
        false,
        { quota: debit.dimension, reset_at: monthEndIso() },
      );
    }

    // ---- §9.3 steps 6-7: upstream fetch ----------------------------
    const screenshotOpts =
      typeof input.screenshot === 'object' && input.screenshot !== null
        ? (input.screenshot as { full_page?: boolean; clip?: { x: number; y: number; width: number; height: number } | null })
        : null;
    let upstream;
    try {
      upstream = await client.fetch({
        url: url.href,
        mode: input.mode,
        extract_next_data: extractKinds.includes('next_data'),
        wait_for: input.wait_for ?? null,
        timeout_ms: input.timeout_ms,
        proxy: input.mode === 'fast' ? 'never' : 'auto',
        user_agent: input.user_agent ?? undefined,
        api_key_id: apiKey.id,
        capture_screenshot: !!wantsScreenshot,
        screenshot_full_page: screenshotOpts?.full_page ?? false,
        screenshot_clip: screenshotOpts?.clip ?? null,
      });
      breaker.recordSuccess();
    } catch (e) {
      breaker.recordFailure();
      const ue = e as UpstreamError;
      const httpStatus = ue.httpStatus ?? 502;
      const errClass: ErrorClass = ue.errorClass ?? 'upstream_5xx_other';
      const code = httpStatus === 504
        ? 'UPSTREAM_TIMEOUT'
        : httpStatus === 503
          ? 'SERVICE_UNAVAILABLE'
          : 'UPSTREAM_ERROR';
      await finalizeAuditRow(supabase, requestId, {
        status: httpStatus,
        error_class: errClass,
      });
      if (ue.retryable) {
        await insertRefund(makeDbAdapter(supabase), {
          id: newUlid(),
          request_id: requestId,
          api_key_id: apiKey.id,
          cost_usd_per_request_estimate: settings.cost_usd_per_request,
          reason: errClass,
        });
      }
      return sendError(
        res,
        requestId,
        httpStatus,
        code,
        ue.message || 'Upstream error.',
        ue.retryable ?? true,
      );
    }

    // ---- §9.3 step 7: reconcile -----------------------------------
    const browserSecondsDelta = upstream.browser_seconds - browserSecondsEstimate;
    const proxyBytesDelta = upstream.proxy_bytes;
    if (browserSecondsDelta !== 0 || proxyBytesDelta !== 0) {
      const costDelta =
        proxyBytesDelta * 0 + // provider per-GB cost is recorded inside scrapling-fetcher's ledger
        browserSecondsDelta * settings.cost_usd_per_browser_second;
      await reconcileQuotaAndLedger(supabase, {
        apiKeyId: apiKey.id,
        requestId,
        ledgerId: newUlid(),
        browserSecondsDelta,
        proxyBytesDelta,
        costUsdDelta: costDelta,
      });
    }

    // ---- §9.3 step 8: post-fetch domain governance on final URL ---
    const finalUrlHost = upstream.final_url
      ? safeNormalizeHost(upstream.final_url)
      : url.host;
    if (
      upstream.final_url &&
      finalUrlHost &&
      finalUrlHost !== url.host
    ) {
      const finalDecision = evaluateHost(finalUrlHost, {
        instanceDeny: rules.instanceDeny,
        instanceAllow: rules.instanceAllow,
        keyDeny: rules.keyDeny,
        keyAllow: rules.keyAllow,
      });
      if (!finalDecision.ok) {
        await finalizeAuditRow(supabase, requestId, {
          status: 403,
          blocked_by: 'final_url_domain_blocked',
          blocked_stage: 'post_fetch',
          final_url: upstream.final_url,
          final_url_host: finalUrlHost,
          redirect_chain: upstream.redirect_chain,
          duration_ms: upstream.timing.total_ms,
          bytes_in: upstream.bytes_in,
          bytes_out: upstream.bytes_out,
          proxy_bytes: upstream.proxy_bytes,
          browser_seconds: upstream.browser_seconds,
        });
        await insertRefund(makeDbAdapter(supabase), {
          id: newUlid(),
          request_id: requestId,
          api_key_id: apiKey.id,
          cost_usd_per_request_estimate: settings.cost_usd_per_request,
          reason: 'final_url_blocked',
        });
        return sendError(
          res,
          requestId,
          403,
          'DOMAIN_BLOCKED_FINAL',
          'Final URL host is blocked by domain governance.',
          false,
          {
            rule: finalDecision.rule,
            pattern: finalDecision.pattern,
            requested_host: url.host,
            final_host: finalUrlHost,
          },
        );
      }
    }

    // ---- §9.3 step 9: content-type check (text-extract only) ------
    const textExtractKinds: ExtractKind[] = [
      'html', 'markdown', 'metadata', 'links', 'json_ld', 'next_data',
    ];
    const wantsText = extractKinds.some(k => textExtractKinds.includes(k));
    if (wantsText && !wantsScreenshot && extractKinds.length > 0) {
      const ct = (upstream.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
      const allowed = !ct
        ? sniffLooksLikeText(upstream.html)
        : isAllowedContentType(ct);
      if (!allowed) {
        await finalizeAuditRow(supabase, requestId, {
          status: 415,
          error_class: 'unsupported_media_type',
          duration_ms: upstream.timing.total_ms,
          bytes_in: upstream.bytes_in,
          bytes_out: upstream.bytes_out,
          proxy_bytes: upstream.proxy_bytes,
          browser_seconds: upstream.browser_seconds,
          final_url: upstream.final_url,
          final_url_host: finalUrlHost ?? null,
          redirect_chain: upstream.redirect_chain,
        });
        await insertRefund(makeDbAdapter(supabase), {
          id: newUlid(),
          request_id: requestId,
          api_key_id: apiKey.id,
          cost_usd_per_request_estimate: settings.cost_usd_per_request,
          reason: 'unsupported_media_type',
        });
        return sendError(
          res,
          requestId,
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Upstream content-type is not supported for text extraction.',
          false,
          { content_type: ct || '<missing>' },
        );
      }
    }

    // ---- §9.3 step 10: extraction --------------------------------
    let extracted: import('./lib/extract.js').ExtractOutput | null = null;
    const responseWarnings: { code: string; [k: string]: unknown }[] = [];
    if (extractKinds.length > 0) {
      const { runExtraction } = await import('./lib/extract.js');
      extracted = await runExtraction({
        html: upstream.html,
        url: upstream.final_url || url.href,
        upstream_next_data: upstream.next_data,
        kinds: extractKinds,
      });
      responseWarnings.push(...extracted.warnings);
    }

    // ---- §9.3 step 11: finalize audit -----------------------------
    await finalizeAuditRow(supabase, requestId, {
      status: upstream.status,
      duration_ms: upstream.timing.total_ms,
      bytes_in: upstream.bytes_in,
      bytes_out: upstream.bytes_out,
      proxy_bytes: upstream.proxy_bytes,
      browser_seconds: upstream.browser_seconds,
      final_url: upstream.final_url,
      final_url_host: finalUrlHost ?? null,
      redirect_chain: upstream.redirect_chain ?? null,
      error_class: extracted?.timed_out ? 'extraction_timeout' : null,
    });

    // ---- response ------------------------------------------------
    const data: Record<string, unknown> = {
      url: url.href,
      final_url: upstream.final_url,
      redirect_chain: upstream.redirect_chain ?? [],
      status: upstream.status,
      mode_used: upstream.mode_used,
      fetched_at: new Date().toISOString(),
      timing: upstream.timing,
      request_id: requestId,
    };
    if (extractKinds.includes('html')) {
      const inlineCap = settings.response_inline_html_max_bytes;
      if (Buffer.byteLength(upstream.html, 'utf-8') <= inlineCap) {
        data.html = upstream.html;
        data.html_truncated = false;
      } else {
        data.html = upstream.html.slice(0, inlineCap);
        data.html_truncated = true;
      }
    }
    // Screenshot artifact (when capture was requested + upstream returned it).
    if (wantsScreenshot && upstream.screenshot_png_b64) {
      const responseStorage: ResponseStorage =
        input.response_storage === 'signed-url'
          ? 'signed_url'
          : (input.response_storage as ResponseStorage);
      if (responseStorage === 'signed_url') {
        try {
          const png = Buffer.from(upstream.screenshot_png_b64, 'base64');
          const artifact = await uploadAndSign(supabase, {
            apiKeyId: apiKey.id,
            requestId,
            bucket: settings.storage_bucket_screenshots,
            fileBytes: png,
            mimeType: 'image/png',
            kind: 'screenshot',
            ext: 'png',
            ttlSeconds: settings.signed_url_ttl_seconds,
            width: upstream.screenshot_width ?? undefined,
            height: upstream.screenshot_height ?? undefined,
          });
          data.screenshot = artifact;
        } catch (e) {
          ctx.logger.warn('screenshot signed-url upload failed', { err: (e as Error).message });
          // Fall back to inline if storage isn't configured.
          data.screenshot = {
            kind: 'inline_base64',
            mime_type: 'image/png',
            base64: upstream.screenshot_png_b64,
            width: upstream.screenshot_width,
            height: upstream.screenshot_height,
          };
          responseWarnings.push({
            code: 'STORAGE_FALLBACK_INLINE',
            reason: (e as Error).message,
          });
        }
      } else {
        data.screenshot = {
          kind: 'inline_base64',
          mime_type: 'image/png',
          base64: upstream.screenshot_png_b64,
          width: upstream.screenshot_width,
          height: upstream.screenshot_height,
        };
      }
    }

    if (extracted) {
      if (extractKinds.includes('markdown')) {
        const md = extracted.markdown ?? null;
        const mdInlineCap = settings.response_inline_markdown_max_bytes;
        if (md !== null && Buffer.byteLength(md, 'utf-8') > mdInlineCap) {
          data.markdown = md.slice(0, mdInlineCap);
          data.markdown_truncated = true;
        } else {
          data.markdown = md;
          if (md !== null) data.markdown_truncated = false;
        }
      }
      if (extractKinds.includes('metadata')) {
        data.metadata = extracted.metadata ?? null;
      }
      if (extractKinds.includes('links')) {
        data.links = extracted.links ?? null;
      }
      if (extractKinds.includes('json_ld')) {
        data.json_ld = extracted.json_ld ?? null;
      }
      if (extractKinds.includes('next_data')) {
        data.next_data = extracted.next_data ?? null;
      }
    }

    const envelope: SuccessEnvelope<typeof data> = {
      data,
      meta: { request_id: requestId },
      billing: {
        request_count_used: 1,
        proxy_bytes_used: upstream.proxy_bytes,
        browser_seconds_used: upstream.browser_seconds,
      },
      warnings: responseWarnings,
    };

    // Cache the successful response under the idempotency key (only
    // for HTTP 200 — error replays are not cached, per §10.5).
    const responseBody = JSON.stringify(envelope);
    if (idemKey) {
      await idem.set(
        idemKey,
        {
          responseBody,
          status: 200,
          requestId,
          expiresAt: Date.now() + idemTtl * 1000,
        },
        idemTtl,
      );
    }

    res.status(200).type('application/json').send(responseBody);
  });

  // ---- POST /fetch/screenshot (spec §5.6) -------------------------
  // Convenience over POST /fetch with `screenshot: true` and
  // `mode: browser`. Different request shape (`options` instead of
  // `screenshot: object`); the handler reshapes to the canonical
  // POST /fetch body and forwards to the same handler chain.
  r.post('/screenshot', ctx.requireScope('screenshot') as never, async (req: Request, res: Response) => {
    const ScreenshotSchema = z.object({
      url: z.string().url().max(2048),
      timeout_ms: z.number().int().min(1000).max(60000).default(45000),
      wait_for: z.string().max(256).nullable().optional(),
      ignore_robots: z.boolean().default(false),
      user_agent: z
        .string()
        .max(256)
        .regex(/^[\x20-\x7e]+$/u)
        .nullable()
        .optional(),
      options: z
        .object({
          full_page: z.boolean().optional(),
          format: z.enum(['png', 'jpeg']).optional(),
          clip: z
            .object({
              x: z.number(),
              y: z.number(),
              width: z.number(),
              height: z.number(),
            })
            .nullable()
            .optional(),
        })
        .optional(),
      // Accept legacy 'storage' alias on input; canonical is response_storage.
      response_storage: z.enum(['inline', 'signed_url', 'signed-url']).optional(),
      storage: z.enum(['inline', 'signed_url', 'signed-url']).optional(),
    });
    const parsed = ScreenshotSchema.safeParse(req.body);
    if (!parsed.success) {
      const requestId = req.header('x-request-id') ?? newUlid();
      return sendError(
        res,
        requestId,
        400,
        'VALIDATION_ERROR',
        'Request body failed validation.',
        false,
        { issues: parsed.error.issues },
      );
    }
    // Reshape into the POST /fetch shape: extract: [], screenshot: <opts>.
    req.body = {
      url: parsed.data.url,
      mode: 'browser',
      extract: [],
      wait_for: parsed.data.wait_for ?? null,
      timeout_ms: parsed.data.timeout_ms,
      ignore_robots: parsed.data.ignore_robots,
      user_agent: parsed.data.user_agent ?? null,
      screenshot: parsed.data.options ?? true,
      response_storage: parsed.data.response_storage ?? parsed.data.storage ?? 'inline',
    };
    // Delegate to the POST /fetch handler by re-emitting the route.
    // We can't simply `next()` to it because Express routes are by URL,
    // not by handler. The least-magic approach is to trigger the same
    // logic by letting the upstream router re-dispatch. For simplicity,
    // we install a thin re-entry: replicate the relevant guard then
    // call the same handler logic by setting req.url and using the
    // router's internal handle() — but Express types make that ugly.
    //
    // Cleaner: call the POST / handler directly. We re-emit the
    // request to the router with method=POST, url='/'.
    const originalUrl = req.url;
    req.url = '/';
    (r as never as { handle: (req: Request, res: Response, next: (err?: unknown) => void) => void })
      .handle(req, res, (err?: unknown) => {
        req.url = originalUrl;
        if (err) {
          ctx.logger.error('screenshot delegate failed', { err: String(err) });
          if (!res.headersSent) {
            sendError(res, 'unknown', 500, 'INTERNAL_ERROR', 'screenshot delegate failed', true);
          }
        }
      });
  });

  // ---- GET /fetch/quota --------------------------------------------
  r.get('/quota', ctx.requireScope('read') as never, async (req: Request, res: Response) => {
    const requestId = req.header('x-request-id') ?? newUlid();
    res.setHeader('x-request-id', requestId);
    const apiKey = (req as Request & { apiKey?: ApiKeyContext }).apiKey;
    if (!apiKey) {
      return sendError(res, requestId, 401, 'UNAUTHORIZED', 'API key required.', false);
    }
    const { data: row } = await supabase
      .schema('fetch')
      .from('quotas')
      .select(
        'period_start, period_end, requests_limit, requests_used, browser_seconds_limit, browser_seconds_used, proxy_bytes_limit, proxy_bytes_used',
      )
      .eq('api_key_id', apiKey.id)
      .maybeSingle();

    // If the key has never made a fetch, there's no row yet — return
    // defaults derived from settings. (Lazy-create happens on first
    // fetch, not on first GET /quota call.)
    if (!row) {
      const limits = defaultLimits(settings);
      const now = new Date();
      const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const periodEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const state = toQuotaState(
        {
          period_start: periodStart.toISOString(),
          period_end: periodEnd.toISOString(),
          requests_limit: limits.requests_limit,
          requests_used: 0,
          browser_seconds_limit: limits.browser_seconds_limit,
          browser_seconds_used: 0,
          proxy_bytes_limit: limits.proxy_bytes_limit,
          proxy_bytes_used: 0,
        },
        apiKey.rateLimitRpm,
      );
      return res.status(200).json({ data: state, meta: { request_id: requestId } });
    }

    const state = toQuotaState(row as never, apiKey.rateLimitRpm);
    res.status(200).json({ data: state, meta: { request_id: requestId } });
  });

  // ---- GET /fetch/audit (spec §5.8) -------------------------------
  // Tenant-scoped — returns ONLY rows belonging to req.apiKey.id.
  r.get('/audit', ctx.requireScope('read') as never, async (req: Request, res: Response) => {
    const requestId = req.header('x-request-id') ?? newUlid();
    res.setHeader('x-request-id', requestId);
    const apiKey = (req as Request & { apiKey?: ApiKeyContext }).apiKey;
    if (!apiKey) {
      return sendError(res, requestId, 401, 'UNAUTHORIZED', 'API key required.', false);
    }

    // Validate query params.
    const auditQuery = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      offset: z.coerce.number().int().min(0).default(0),
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
      host: z.string().max(253).optional(),
      mode: z.enum(['fast', 'stealth', 'browser']).optional(),
      blocked_by: z
        .enum([
          'instance_denylist',
          'instance_allowlist_violation',
          'key_denylist',
          'key_allowlist_violation',
          'final_url_domain_blocked',
          'robots',
          'quota',
          'none',
        ])
        .optional(),
      blocked_stage: z
        .enum(['pre_fetch', 'robots', 'quota', 'post_fetch', 'none'])
        .optional(),
      error_class: z.string().max(64).optional(),
      include_redirect_chain: z
        .union([z.literal('true'), z.literal('false'), z.boolean()])
        .default(false)
        .transform(v => v === true || v === 'true'),
    });
    const qParsed = auditQuery.safeParse(req.query);
    if (!qParsed.success) {
      return sendError(
        res,
        requestId,
        400,
        'VALIDATION_ERROR',
        'Invalid query parameters.',
        false,
        { issues: qParsed.error.issues },
      );
    }
    const q = qParsed.data;

    // Build the supabase select.
    let query = supabase
      .schema('fetch')
      .from('audit_log')
      .select(
        'request_id, fetched_at, surface, requested_url, url_host, ' +
          'final_url, final_url_host, redirect_chain, mode, status, ' +
          'blocked_by, blocked_stage, ignored_robots, browser_seconds, ' +
          'proxy_bytes, duration_ms, cost_usd_estimate, error_class',
      )
      .eq('api_key_id', apiKey.id)
      .order('fetched_at', { ascending: false })
      .order('request_id', { ascending: false })
      .range(q.offset, q.offset + q.limit - 1);

    if (q.from) query = query.gte('fetched_at', q.from);
    if (q.to) query = query.lt('fetched_at', q.to);
    if (q.host) query = query.eq('url_host', q.host.toLowerCase());
    if (q.mode) query = query.eq('mode', q.mode);
    if (q.blocked_by === 'none') {
      query = query.is('blocked_by', null);
    } else if (q.blocked_by) {
      query = query.eq('blocked_by', q.blocked_by);
    }
    if (q.blocked_stage === 'none') {
      query = query.is('blocked_stage', null);
    } else if (q.blocked_stage) {
      query = query.eq('blocked_stage', q.blocked_stage);
    }
    if (q.error_class === 'none') {
      query = query.is('error_class', null);
    } else if (q.error_class) {
      query = query.eq('error_class', q.error_class);
    }

    const { data: items, error } = await query;
    if (error) {
      ctx.logger.error('audit query failed', { err: error.message, request_id: requestId });
      return sendError(res, requestId, 500, 'INTERNAL_ERROR', 'Audit query failed.', true);
    }

    // Strip redirect_chain from items unless include_redirect_chain=true.
    // Supabase's typed select() returns a union including its
    // GenericStringError wrapper when the select string is dynamically
    // built; we cast through `unknown` because we trust the runtime
    // shape after the `error` early-return above.
    const rows = ((items ?? []) as unknown as Array<Record<string, unknown>>).map(row => {
      const r: Record<string, unknown> = { ...row };
      if (!q.include_redirect_chain) {
        delete r.redirect_chain;
      } else {
        const rc = (row as { redirect_chain?: unknown[] | null }).redirect_chain;
        r.redirect_chain = rc ?? [];
      }
      return r;
    });

    // Page-of-results convention: include next_offset when the page is full.
    const nextOffset = rows.length === q.limit ? q.offset + q.limit : undefined;

    res.status(200).json({
      data: { items: rows },
      meta: {
        request_id: requestId,
        ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
      },
    });
  });

  ctx.logger.info('public-api routes registered', {
    base: '/fetch',
    endpoints: ['POST /', 'POST /screenshot', 'GET /quota', 'GET /audit'],
  });
}

// =============================================================== helpers

function sendError(
  res: Response,
  requestId: string,
  httpStatus: number,
  code: string,
  message: string,
  retryable: boolean,
  details?: Record<string, unknown>,
): void {
  res.setHeader('x-request-id', requestId);
  res.status(httpStatus).json({
    error: { code, message, details: details ?? null, retryable },
    meta: { request_id: requestId },
  });
}

/**
 * Spec §5.1 content-type allowlist for text extraction.
 */
function isAllowedContentType(ct: string): boolean {
  return (
    ct === 'text/html' ||
    ct === 'application/xhtml+xml' ||
    ct === 'application/xml' ||
    ct === 'text/plain' ||
    ct.startsWith('text/')
  );
}

/**
 * Spec §5.1 sniffing rule for missing Content-Type: decode the first
 * 512 bytes; if they look like text and contain a `<` within the first
 * 64 chars, treat as HTML. Cheap heuristic — best-effort only.
 */
function sniffLooksLikeText(html: string): boolean {
  const head = html.slice(0, 64);
  return /</.test(head);
}

function safeNormalizeHost(href: string): string | null {
  try {
    return parseAndNormalize(href).host;
  } catch {
    return null;
  }
}

function monthEndIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Wrap a Supabase client in the generic DbClient interface used by the
 * lib helpers. PostgREST doesn't support arbitrary SQL — we fall back
 * to the schema().from() path for the small handful of queries the
 * helpers run (robots cache + ledger refund). This is intentionally a
 * thin shim, not a real query engine.
 */
function makeDbAdapter(
  supabase: import('@supabase/supabase-js').SupabaseClient,
): { query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[] }> } {
  return {
    query: async (sql: string, values?: unknown[]) => {
      // Branch on the SQL fragment we know we get from the helpers.
      // This is a Phase 2 pragmatic compromise — Phase 3 will route
      // these through dedicated supabase.rpc() functions.
      if (sql.includes('from gw_fetch.robots_cache') && sql.startsWith('\n      select')) {
        const origin = values![0] as string;
        const { data } = await supabase
          .schema('fetch')
          .from('robots_cache')
          .select('*')
          .eq('origin', origin)
          .maybeSingle();
        return { rows: data ? [data] : [] };
      }
      if (sql.includes('insert into gw_fetch.robots_cache')) {
        const [origin, fetchedAt, expiresAt, status, body, parseError] = values as [
          string, Date, Date, number, string, string | null,
        ];
        await supabase
          .schema('fetch')
          .from('robots_cache')
          .upsert({
            origin,
            fetched_at: fetchedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
            status,
            body,
            parse_error: parseError,
          });
        return { rows: [] };
      }
      if (sql.includes('extract(epoch from fetched_at)')) {
        const origin = values![0] as string;
        const { data } = await supabase
          .schema('fetch')
          .from('robots_cache')
          .select('fetched_at')
          .eq('origin', origin)
          .maybeSingle();
        if (!data) return { rows: [{ v: 0 }] };
        const v = Math.floor(new Date((data as { fetched_at: string }).fetched_at).getTime() / 1000);
        return { rows: [{ v }] };
      }
      if (sql.includes('insert into gw_fetch.usage_ledger') && sql.includes("'refund'")) {
        const [id, requestId, apiKeyId, costDelta, reason] = values as [
          string, string, string, number, string,
        ];
        await supabase.schema('fetch').from('usage_ledger').upsert(
          {
            id,
            request_id: requestId,
            api_key_id: apiKeyId,
            kind: 'refund',
            request_count_delta: -1,
            cost_usd_estimate_delta: costDelta,
            reason,
          },
          { onConflict: 'request_id,kind', ignoreDuplicates: true },
        );
        return { rows: [] };
      }
      if (sql.includes('update gw_fetch.quotas set requests_used')) {
        const apiKeyId = values![0] as string;
        const { data: cur } = await supabase
          .schema('fetch')
          .from('quotas')
          .select('requests_used')
          .eq('api_key_id', apiKeyId)
          .single();
        if (cur) {
          await supabase
            .schema('fetch')
            .from('quotas')
            .update({ requests_used: Math.max(0, Number(cur.requests_used) - 1) })
            .eq('api_key_id', apiKeyId);
        }
        return { rows: [] };
      }
      throw new Error(`makeDbAdapter: unhandled SQL: ${sql.slice(0, 120)}…`);
    },
  };
}
