import type { Job } from 'bullmq';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

interface DispatchJobData { kind: string }

// Resolve a reminder's from-key to an address from the worker env (mirrors the
// admin's EmailService.getFromAddresses, which reads VITE_SENDGRID_FROM_*).
function resolveFromAddress(fromKey: string | null): string {
  const up = (fromKey || 'events').toUpperCase();
  return process.env[`SENDGRID_FROM_${up}`]
    || process.env[`VITE_SENDGRID_FROM_${up}`]
    || process.env.BULK_EMAIL_FROM_ADDRESS
    || process.env.EMAIL_FROM
    || '';
}

interface ReminderSetting {
  event_id: string;
  reminder_email_subject: string | null;
  reminder_email_content: string | null;
  reminder_email_from_key: string | null;
  reminder_email_reply_to: string | null;
  reminder_email_cc: string | null;
  reminder_email_lead_hours: number | null;
}

/**
 * Lifecycle reminder dispatcher (date-driven). Each tick finds events whose
 * reminder is enabled, not yet sent, and now within its configured lead window
 * (reminder_email_lead_hours before event_start), then creates a 'reminder'
 * email_batch_jobs row + invokes email-batch-send — which, under
 * SEND_ENGINE_USE_WORKER, enqueues the recipients for the Tier-2 worker drip
 * (same path as an admin-triggered reminder). reminder_email_sent_at is set
 * BEFORE invoking so an overlapping tick can't double-send.
 */
export default async function handleEventReminders(_job: Job<DispatchJobData>) {
  const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  try {
    const { data: settings, error } = await supabase
      .from('events_communication_settings')
      .select('event_id, reminder_email_subject, reminder_email_content, reminder_email_from_key, reminder_email_reply_to, reminder_email_cc, reminder_email_lead_hours')
      .eq('reminder_email_enabled', true)
      .is('reminder_email_sent_at', null);
    if (error) throw new Error(error.message);
    const rows = (settings ?? []) as ReminderSetting[];
    if (rows.length === 0) return { due: 0 };

    // Resolve each setting's event start time (settings.event_id → events.id).
    const eventIds = rows.map((r) => r.event_id);
    const { data: events } = await supabase.from('events').select('id, event_start').in('id', eventIds);
    const startById = new Map<string, string | null>((events ?? []).map((e: { id: string; event_start: string | null }) => [e.id, e.event_start]));

    const now = Date.now();
    let dispatched = 0;
    for (const r of rows) {
      const startStr = startById.get(r.event_id);
      if (!startStr) continue;
      const start = new Date(startStr).getTime();
      const leadMs = (r.reminder_email_lead_hours ?? 24) * 3600_000;
      if (start <= now) continue;            // event already started / past — don't remind
      if (start - now > leadMs) continue;     // not yet within the lead window
      if (!r.reminder_email_subject || !r.reminder_email_content) continue; // nothing to send

      const { data: job, error: jobErr } = await supabase
        .from('email_batch_jobs')
        .insert({
          event_id: r.event_id,
          email_type: 'reminder',
          subject_template: r.reminder_email_subject,
          content_template: r.reminder_email_content,
          from_address: resolveFromAddress(r.reminder_email_from_key),
          reply_to: r.reminder_email_reply_to || null,
          cc: r.reminder_email_cc || null,
          config: {},
          status: 'pending',
        })
        .select('id')
        .single();
      if (jobErr || !job) { console.error('[event-reminders] job insert failed', jobErr); continue; }

      // Mark sent first (idempotency guard against overlapping ticks), then fire.
      await supabase.from('events_communication_settings')
        .update({ reminder_email_sent_at: new Date().toISOString() })
        .eq('event_id', r.event_id);

      await fetch(`${supabaseUrl}/functions/v1/email-batch-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseServiceKey}` },
        body: JSON.stringify({ jobId: job.id }),
      }).catch((e) => console.error('[event-reminders] invoke failed', e));
      dispatched++;
    }
    if (dispatched) console.log(`[event-reminders] dispatched ${dispatched} reminder(s)`);
    return { due: rows.length, dispatched };
  } catch (err) {
    console.error('[event-reminders] failed:', err);
    return { error: (err as Error).message };
  }
}
