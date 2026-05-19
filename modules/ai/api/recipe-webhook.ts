/**
 * Public webhook receiver for recipe-source instant-sync.
 *
 * Mirrors `api/skill-webhook.ts` exactly per spec-ai-workflows-and-
 * skill-interop.md §3.1 ("same webhook plumbing"). Mounted under
 *
 *   POST /api/modules/ai/admin/recipe-sources/:id/webhook
 *
 * Even though the route lives under `/admin/`, it's PUBLIC (no JWT)
 * because the caller is the git provider. Authentication is
 * provider-specific (github HMAC / gitlab token / gitea token+HMAC).
 *
 * The body must be the raw bytes git sent — we mount express.raw at
 * the route level so HMAC checks against the unparsed payload.
 */

import type { Response, Router } from 'express';
import express from 'express';
import { createHmac, timingSafeEqual, randomInt } from 'node:crypto';

import { recipesConfig } from '../lib/recipes/recipes-config.js';
import { getRecipeWebhookSecret, writeRecipeWebhookLog } from '../lib/recipes/recipes-repo.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

interface RequestWithRaw {
  params: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer | Record<string, unknown>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface Deps {
  supabase: SupabaseLike;
  enqueueJob?: (queue: string, name: string, data: Record<string, unknown>) => Promise<{ id: string }>;
}

// Per-source token bucket. Process-local; resets on restart (cap is
// to deter misconfigured CI loops, not adversaries).
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

function checkRate(sourceId: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(sourceId);
  if (!b || b.resetAt < now) {
    buckets.set(sourceId, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count < max) {
    b.count += 1;
    return true;
  }
  return false;
}

function jitter(): Promise<void> {
  return new Promise((r) => setTimeout(r, randomInt(5, 16)));
}

function getHeader(headers: Record<string, string | string[] | undefined>, name: string): string {
  const lower = name.toLowerCase();
  const v = headers[lower];
  if (Array.isArray(v)) return v[0] ?? '';
  return v ?? '';
}

function verifyGitHub(secret: string, rawBody: Buffer, signature: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const sigHex = signature.slice('sha256='.length);
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (sigHex.length !== expectedHex.length) return false;
  try {
    return timingSafeEqual(Buffer.from(sigHex, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

interface PushPayload {
  ref?: string;
}

function isPushEventOnBranch(
  provider: 'github' | 'gitlab' | 'gitea',
  headers: Record<string, string | string[] | undefined>,
  body: PushPayload,
  expectedBranch: string,
): { matches: boolean; eventType: string; reason?: string } {
  let eventType = '';
  if (provider === 'github') eventType = getHeader(headers, 'X-GitHub-Event');
  else if (provider === 'gitlab') eventType = getHeader(headers, 'X-Gitlab-Event');
  else if (provider === 'gitea') eventType = getHeader(headers, 'X-Gitea-Event');

  const pushEventName = provider === 'gitlab' ? 'Push Hook' : 'push';
  if (eventType !== pushEventName) {
    return { matches: false, eventType, reason: `event_type ${eventType || '(none)'} != ${pushEventName}` };
  }

  const ref = typeof body?.ref === 'string' ? body.ref : '';
  const expected = `refs/heads/${expectedBranch}`;
  if (ref !== expected) {
    return { matches: false, eventType, reason: `ref ${ref || '(none)'} != ${expected}` };
  }
  return { matches: true, eventType };
}

export function mountRecipeWebhookRoute(router: Router, deps: Deps): void {
  router.post(
    '/recipe-sources/:id/webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
    async (req: RequestWithRaw, res: Response) => {
      const sourceId = req.params.id;
      if (!sourceId) {
        res.status(400).json({ error: 'invalid_input' });
        return;
      }
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const remoteAddr = req.ip ?? req.socket?.remoteAddress ?? null;

      const secretInfo = await getRecipeWebhookSecret(deps.supabase, sourceId);
      if (!secretInfo) {
        await jitter();
        res.status(404).json({ error: 'not_found' });
        return;
      }

      const provider = secretInfo.provider;
      let signatureValid = false;
      let authReason = '';
      if (provider === 'github') {
        const sig = getHeader(req.headers, 'X-Hub-Signature-256');
        signatureValid = sig.length > 0 && verifyGitHub(secretInfo.secret, rawBody, sig);
        if (!signatureValid) authReason = sig ? 'hmac_mismatch' : 'missing_signature';
      } else if (provider === 'gitlab') {
        const tok = getHeader(req.headers, 'X-Gitlab-Token');
        signatureValid = tok.length > 0 && constantTimeEq(tok, secretInfo.secret);
        if (!signatureValid) authReason = tok ? 'token_mismatch' : 'missing_token';
      } else if (provider === 'gitea') {
        const sig = getHeader(req.headers, 'X-Hub-Signature-256');
        const tok = getHeader(req.headers, 'X-Gitea-Token');
        if (sig.length > 0) {
          signatureValid = verifyGitHub(secretInfo.secret, rawBody, sig);
          if (!signatureValid) authReason = 'hmac_mismatch';
        } else if (tok.length > 0) {
          signatureValid = constantTimeEq(tok, secretInfo.secret);
          if (!signatureValid) authReason = 'token_mismatch';
        } else {
          authReason = 'missing_signature';
        }
      }

      if (!signatureValid) {
        await jitter();
        await writeRecipeWebhookLog(deps.supabase, {
          source_id: sourceId,
          remote_addr: remoteAddr,
          provider,
          event_type: null,
          status: 'auth_failed',
          status_reason: authReason || 'auth_failed',
          payload_size: rawBody.byteLength,
          signature_valid: false,
        });
        res.status(401).json({ error: 'unauthorized' });
        return;
      }

      if (!checkRate(sourceId, recipesConfig.recipeWebhookRateMax, 60_000)) {
        await writeRecipeWebhookLog(deps.supabase, {
          source_id: sourceId,
          remote_addr: remoteAddr,
          provider,
          event_type: null,
          status: 'rate_limited',
          status_reason: 'per_source_per_minute_cap',
          payload_size: rawBody.byteLength,
          signature_valid: true,
        });
        res.setHeader('Retry-After', '60');
        res.status(429).json({ error: { code: 'rate_limited', message: 'webhook rate limit exceeded' } });
        return;
      }

      let parsed: PushPayload = {};
      try {
        parsed = JSON.parse(rawBody.toString('utf-8')) as PushPayload;
      } catch {
        await writeRecipeWebhookLog(deps.supabase, {
          source_id: sourceId,
          remote_addr: remoteAddr,
          provider,
          event_type: null,
          status: 'ignored',
          status_reason: 'body_not_json',
          payload_size: rawBody.byteLength,
          signature_valid: true,
        });
        res.status(200).json({ status: 'ignored', source_id: sourceId, reason: 'body_not_json' });
        return;
      }

      const branchRes = await deps.supabase
        .from('ai_recipe_sources')
        .select('branch')
        .eq('id', sourceId)
        .maybeSingle();
      const expectedBranch = (branchRes?.data as { branch: string } | null)?.branch ?? 'main';

      const matched = isPushEventOnBranch(provider, req.headers, parsed, expectedBranch);
      if (!matched.matches) {
        await writeRecipeWebhookLog(deps.supabase, {
          source_id: sourceId,
          remote_addr: remoteAddr,
          provider,
          event_type: matched.eventType || null,
          status: 'ignored',
          status_reason: matched.reason ?? 'not_push_on_branch',
          payload_size: rawBody.byteLength,
          signature_valid: true,
        });
        res.status(200).json({
          status: 'ignored',
          source_id: sourceId,
          reason: matched.reason,
        });
        return;
      }

      if (!deps.enqueueJob) {
        await writeRecipeWebhookLog(deps.supabase, {
          source_id: sourceId,
          remote_addr: remoteAddr,
          provider,
          event_type: matched.eventType,
          status: 'queued',
          status_reason: 'enqueue_helper_unavailable_no_job',
          payload_size: rawBody.byteLength,
          signature_valid: true,
        });
        res.status(202).json({ status: 'queued', source_id: sourceId });
        return;
      }

      let jobId: string;
      try {
        const job = await deps.enqueueJob('jobs', 'ai.sync-one-recipe-source', {
          kind: 'ai.sync-one-recipe-source',
          source_id: sourceId,
          trigger: 'webhook',
        });
        jobId = job.id;
      } catch (err) {
        await writeRecipeWebhookLog(deps.supabase, {
          source_id: sourceId,
          remote_addr: remoteAddr,
          provider,
          event_type: matched.eventType,
          status: 'ignored',
          status_reason: `enqueue_failed: ${err instanceof Error ? err.message : String(err)}`,
          payload_size: rawBody.byteLength,
          signature_valid: true,
        });
        res.status(500).json({ error: { code: 'internal_error', message: 'enqueue failed' } });
        return;
      }

      await writeRecipeWebhookLog(deps.supabase, {
        source_id: sourceId,
        remote_addr: remoteAddr,
        provider,
        event_type: matched.eventType,
        status: 'queued',
        status_reason: null,
        payload_size: rawBody.byteLength,
        signature_valid: true,
      });
      res.status(202).json({ status: 'queued', source_id: sourceId, job_id: jobId });
    },
  );
}
