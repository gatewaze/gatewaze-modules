/**
 * Per-recipient blast dispatcher — used for SMS + WhatsApp blasts.
 *
 * Per spec-calendars-microsites §8.5: "Both [SMS + WhatsApp] are
 * optional: the Messaging tab disables those channels if the module
 * isn't installed." Spec §8.4 says SMS/WhatsApp should mirror the
 * email-batch-send shape (per-channel batch endpoints), but until those
 * land, the cron worker fans out to the existing single-recipient
 * sms-send / whatsapp-send functions inline.
 *
 * Pure orchestration — DB + send function are passed in so tests can
 * exercise every branch without a real Supabase or Twilio.
 */

export interface AudienceRecipient {
  member_id: string;
  email: string | null;
  phone: string | null;
}

export interface PerRecipientSupabaseClient {
  // Structural shape — accepts both the service-role admin client and the
  // narrow query interface used by tests. The actual chained-builder type
  // is too complex to express usefully without generated Database types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any;
  rpc(fn: string, args: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface SingleSendFn {
  send(args: {
    to: string;
    body: string;
    metadata: { blast_id: string; calendar_id: string; member_id: string };
  }): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export interface PerRecipientDeps {
  supabase: PerRecipientSupabaseClient;
  channel: 'sms' | 'whatsapp';
  send: SingleSendFn;
  /** ms between sends. Defaults to 250 (4 msg/sec — under Twilio paid cap). */
  delayMs?: number;
  /** Override sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

export interface PerRecipientResult {
  ok: boolean;
  sent: number;
  failed: number;
  total: number;
  /** Reason when ok=false — set when all recipients failed. */
  reason?: string;
}

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * Run a per-recipient blast against the audience resolver.
 *
 * Final blast status is decided here:
 *   - sent > 0 → status='sent' (partial success counts as sent)
 *   - sent == 0 && failed > 0 → status='failed'
 *   - sent == 0 && failed == 0 (empty audience) → status='sent' (nothing to do)
 *
 * The status flip happens before the function returns, so the cron
 * dispatcher's outer "mark failed" path doesn't double-write.
 */
export async function dispatchPerRecipient(
  blastId: string,
  calendarId: string,
  deps: PerRecipientDeps,
): Promise<PerRecipientResult> {
  const log = deps.logger ?? noopLogger;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delayMs = deps.delayMs ?? 250;

  // 1. Look up the blast body + audience filter
  const blastRes = await deps.supabase
    .from('calendars_blasts')
    .select('body_template, audience_filter')
    .eq('id', blastId)
    .single();
  if (blastRes.error || !blastRes.data) {
    return { ok: false, sent: 0, failed: 0, total: 0, reason: blastRes.error?.message ?? 'blast not found' };
  }
  const body = (blastRes.data as { body_template: string | null }).body_template ?? '';
  const filter = (blastRes.data as { audience_filter: unknown }).audience_filter ?? {};

  // 2. Resolve audience for THIS channel (phone-bearing recipients)
  const audienceRes = await deps.supabase.rpc('resolve_calendar_audience', {
    p_calendar_id: calendarId,
    p_filter: filter,
    p_channel: deps.channel,
  });
  if (audienceRes.error) {
    return { ok: false, sent: 0, failed: 0, total: 0, reason: `audience resolve failed: ${audienceRes.error.message}` };
  }
  const recipients = (audienceRes.data ?? []) as AudienceRecipient[];

  // 3. Per-recipient iteration
  let sent = 0;
  let failed = 0;
  for (const r of recipients) {
    if (!r.phone) {
      failed++;
      log.warn(`${deps.channel}: recipient has no phone`, { blastId, memberId: r.member_id });
      continue;
    }
    const result = await deps.send.send({
      to: r.phone,
      body,
      metadata: { blast_id: blastId, calendar_id: calendarId, member_id: r.member_id },
    });
    if (result.ok) {
      sent++;
    } else {
      failed++;
      log.warn(`${deps.channel}: send failed`, { blastId, memberId: r.member_id, reason: result.reason });
    }
    if (delayMs > 0) await sleep(delayMs);
  }

  // 4. Final status flip — see header comment
  const finalStatus = sent === 0 && failed > 0 ? 'failed' : 'sent';
  await deps.supabase
    .from('calendars_blasts')
    .update({ status: finalStatus })
    .eq('id', blastId);

  log.info(`${deps.channel}: blast complete`, { blastId, sent, failed, total: recipients.length });

  if (sent === 0 && failed > 0) {
    return { ok: false, sent, failed, total: recipients.length, reason: `all ${failed} recipient(s) failed` };
  }
  return { ok: true, sent, failed, total: recipients.length };
}
