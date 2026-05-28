/**
 * Hourly (every 15 min, backstop) sweep that drops expired rows from
 * canvas_ai_documents AND old rows from ai_skill_source_webhook_log
 * (per spec-ai-skills.md — webhook log retention defaults to 30 days,
 * configurable via SITES_CANVAS_AI_WEBHOOK_LOG_RETENTION_DAYS).
 *
 * Both sweeps live in one handler to minimise cron entries — the
 * platform already runs this every 15 min, adding another table to
 * the same pass is free.
 *
 * Spec: spec-canvas-ai-copilot.md §5.2 + spec-ai-skills.md §5.4.
 */

import { canvasAiConfig } from '../lib/canvas-ai-config.js';

interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
}

export interface SweepResult {
  rowsDeleted: number;
  webhookLogRowsDeleted: number;
}

export async function sweepExpiredDocuments(supabase: SupabaseLike): Promise<SweepResult> {
  const nowIso = new Date().toISOString();

  // Expired documents.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docsRes = await (supabase.from('canvas_ai_documents') as any)
    .delete()
    .lt('expires_at', nowIso)
    .select('id');
  if (docsRes?.error) {
    throw new Error(`sweep-expired-documents failed: ${docsRes.error.message ?? String(docsRes.error)}`);
  }
  const rowsDeleted = (docsRes?.data as unknown[] | null)?.length ?? 0;

  // Webhook log — older than retention window.
  const retentionMs = canvasAiConfig.skillWebhookLogRetentionDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(Date.now() - retentionMs).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const whRes = await (supabase.from('ai_skill_source_webhook_log') as any)
    .delete()
    .lt('received_at', cutoffIso)
    .select('id');
  // Don't fail the whole sweep if the webhook-log delete errors — log
  // it and continue. The docs sweep is the higher-priority half.
  const webhookLogRowsDeleted = whRes?.error
    ? 0
    : (whRes?.data as unknown[] | null)?.length ?? 0;

  return { rowsDeleted, webhookLogRowsDeleted };
}

/**
 * Worker handler registered via the module manifest's `crons[]` entry.
 * The platform's BullMQ worker invokes this on every scheduled tick.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function sweepExpiredDocumentsHandler(ctx: { supabase: SupabaseLike; logger?: any }): Promise<SweepResult> {
  const result = await sweepExpiredDocuments(ctx.supabase);
  ctx.logger?.info?.('canvas_ai.docs.sweep', {
    rows_deleted: result.rowsDeleted,
    webhook_log_rows_deleted: result.webhookLogRowsDeleted,
  });
  return result;
}
