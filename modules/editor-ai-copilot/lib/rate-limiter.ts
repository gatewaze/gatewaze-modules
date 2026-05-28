/**
 * Rate-limiting for the AI endpoint. Three layers (§4.3):
 *
 *   1. per-user, 60s window — in-memory
 *   2. per-site, 60s window — in-memory
 *   3. per-user, 24h window — backed by canvas_ai_audit_log row count
 *
 * The two in-memory layers reset on API restart; the 24h budget
 * survives via the audit-log row count.
 */

import { canvasAiConfig } from './canvas-ai-config.js';
import { countUserAuditRows } from './audit-log.js';

interface Window {
  resetAt: number;
  count: number;
}

const buckets = new Map<string, Window>();

function checkWindow(key: string, max: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt < now) {
    buckets.set(key, { resetAt: now + windowMs, count: 1 });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (existing.count < max) {
    existing.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }
  return { allowed: false, retryAfterSec: Math.ceil((existing.resetAt - now) / 1000) };
}

export interface RateCheckResult {
  ok: true;
}

export interface RateRejectResult {
  ok: false;
  scope: 'per_user_per_min' | 'per_site_per_min' | 'per_user_per_day';
  retryAfterSec: number;
}

export async function checkGenerateRateLimit(
  supabase: Parameters<typeof countUserAuditRows>[0],
  userId: string,
  hostKind: 'site' | 'newsletter',
  hostId: string,
): Promise<RateCheckResult | RateRejectResult> {
  // Per-user-per-min
  const userMin = checkWindow(`u:${userId}:1m`, canvasAiConfig.perUserPerMin, 60_000);
  if (!userMin.allowed) return { ok: false, scope: 'per_user_per_min', retryAfterSec: userMin.retryAfterSec };

  // Per-host-per-min
  const siteMin = checkWindow(`h:${hostKind}:${hostId}:1m`, canvasAiConfig.perSitePerMin, 60_000);
  if (!siteMin.allowed) return { ok: false, scope: 'per_site_per_min', retryAfterSec: siteMin.retryAfterSec };

  // Per-user-per-day — DB-backed, only checked when the in-memory
  // windows passed (saves a SELECT on every call).
  const dailyCount = await countUserAuditRows(supabase, userId, 24 * 60 * 60 * 1000);
  if (dailyCount >= canvasAiConfig.perUserPerDay) {
    // Find the oldest row's created_at + 24h for the precise reset.
    // Approximate: 24h - elapsed-since-first-of-window. For a v1
    // implementation we return a coarse 1h retry-after; clients
    // should not retry on 429 immediately anyway.
    return { ok: false, scope: 'per_user_per_day', retryAfterSec: 60 * 60 };
  }

  return { ok: true };
}

/** Separate rate-limit for the documents endpoint (Phase F). */
export function checkDocumentRateLimit(userId: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const r = checkWindow(`docs:u:${userId}:1h`, canvasAiConfig.docsPerUserPerHour, 60 * 60_000);
  return r.allowed ? { ok: true } : { ok: false, retryAfterSec: r.retryAfterSec };
}

/** Test hook — clears all in-memory rate-limit state. */
export function _resetRateLimiterForTests(): void {
  buckets.clear();
}
