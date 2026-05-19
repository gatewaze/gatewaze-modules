/**
 * tasks:webhook-dispatcher (spec §12.3).
 *
 * Reads pending rows from task_webhook_outbox, hydrates the full
 * task + board context, builds the per-kind payload, POSTs with
 * timeout + retries, and updates the outbox row.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildPayload } from '../../lib/webhook-payload.js';
import { decrypt } from '../../lib/encrypt.js';

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;

export async function runOnce(supabase: SupabaseClient, limit = 100): Promise<{ delivered: number; failed: number }> {
  const { data: rows } = await supabase
    .from('task_webhook_outbox')
    .select('*')
    .is('delivered_at', null)
    .is('abandoned_at', null)
    .order('enqueued_at')
    .limit(limit);
  let delivered = 0;
  let failed = 0;
  for (const r of rows ?? []) {
    // Backoff: skip if last_attempt was less than 2^attempt seconds ago.
    if (r.last_attempt_at) {
      const wait = Math.pow(2, r.attempt_count) * 1000;
      if (new Date(r.last_attempt_at).getTime() + wait > Date.now()) continue;
    }
    const result = await attempt(supabase, r);
    if (result.ok) delivered++; else failed++;
  }
  return { delivered, failed };
}

interface OutboxRow {
  id: string;
  webhook_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
}

async function attempt(supabase: SupabaseClient, row: OutboxRow): Promise<{ ok: boolean; error?: string }> {
  // Hydrate webhook config + task + board.
  const { data: webhook } = await supabase
    .from('board_webhooks')
    .select('*')
    .eq('id', row.webhook_id)
    .single();
  if (!webhook) return await abandon(supabase, row, 'webhook_config_missing');

  const taskId = (row.payload as { task_id?: string }).task_id;
  if (!taskId) return await abandon(supabase, row, 'payload_missing_task_id');

  const { data: task } = await supabase.from('tasks').select('*').eq('id', taskId).maybeSingle();
  if (!task) return await abandon(supabase, row, 'target_gone');

  const { data: board } = await supabase.from('task_boards').select('*').eq('id', webhook.board_id).maybeSingle();
  if (!board) return await abandon(supabase, row, 'board_gone');

  const url = decrypt(webhook.url);
  const secret = webhook.secret ? decrypt(webhook.secret) : null;
  if (!url) return await abandon(supabase, row, 'webhook_url_undecryptable');

  const built = buildPayload(
    row.event_type,
    task,
    board,
    webhook.kind,
    { includeDescription: webhook.include_description !== false },
    secret,
  );
  const headers: Record<string, string> = { 'content-type': built.contentType };
  if (built.signatureHeader) headers[built.signatureHeader.name] = built.signatureHeader.value;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: built.body,
      signal: ac.signal,
    });
    if (res.ok) {
      await supabase
        .from('task_webhook_outbox')
        .update({ delivered_at: new Date().toISOString() })
        .eq('id', row.id);
      await supabase.from('board_webhooks').update({
        last_success_at: new Date().toISOString(),
        failure_count: 0,
      }).eq('id', webhook.id);
      return { ok: true };
    }
    return await onFail(supabase, row, webhook.id, `http_${res.status}`);
  } catch (e) {
    return await onFail(supabase, row, webhook.id, (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

async function onFail(supabase: SupabaseClient, row: OutboxRow, webhookId: string, err: string): Promise<{ ok: false; error: string }> {
  const newAttempt = row.attempt_count + 1;
  await supabase.from('task_webhook_outbox').update({
    attempt_count: newAttempt,
    last_attempt_at: new Date().toISOString(),
    last_error: err,
    abandoned_at: newAttempt >= MAX_ATTEMPTS ? new Date().toISOString() : null,
  }).eq('id', row.id);
  await supabase.from('board_webhooks').update({
    last_failure_at: new Date().toISOString(),
  }).eq('id', webhookId);
  if (newAttempt >= MAX_ATTEMPTS) {
    // Increment failure_count via a separate update.
    const { data } = await supabase.from('board_webhooks').select('failure_count').eq('id', webhookId).single();
    await supabase.from('board_webhooks').update({
      failure_count: (data?.failure_count ?? 0) + 1,
    }).eq('id', webhookId);
  }
  return { ok: false, error: err };
}

async function abandon(supabase: SupabaseClient, row: OutboxRow, err: string): Promise<{ ok: false; error: string }> {
  await supabase.from('task_webhook_outbox').update({
    abandoned_at: new Date().toISOString(),
    last_error: err,
  }).eq('id', row.id);
  return { ok: false, error: err };
}
