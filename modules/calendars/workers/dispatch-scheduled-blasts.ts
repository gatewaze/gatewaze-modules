// @ts-nocheck — depends on @supabase/supabase-js which resolves at runtime
// via the api package's node_modules. Excluded from strict tsconfig (same
// pattern as gatewaze-modules/sites/workers/cron-dispatchers.ts and
// gatewaze-modules/templates/workers/cron-dispatchers.ts).
/**
 * Default-export job handler for the calendars scheduled-blast cron.
 *
 * Per spec-calendars-microsites §9.3 (Schedule action) — picks up
 * `calendars_blasts` rows whose `scheduled_at` has passed and routes them
 * to the per-channel send worker (email-batch-send for email; SMS/WhatsApp
 * gated on the respective module being installed).
 */

import { createClient } from '@supabase/supabase-js';
import {
  dispatchScheduledBlasts,
  type ChannelDispatcher,
} from '../lib/blast-dispatcher/index.js';
import { dispatchPerRecipient } from '../lib/blast-dispatcher/per-recipient.js';

interface BullJob {
  name: string;
  data: { kind?: string };
}

const supabase = createClient(
  process.env.SUPABASE_URL ?? '',
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const logger = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[calendars:cron] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[calendars:cron] ${msg}`, meta ?? ''),
  error: (msg: string, meta?: Record<string, unknown>) =>
    console.error(`[calendars:cron] ${msg}`, meta ?? ''),
};

// Per-channel dispatchers wrap the existing edge functions.
//
// EMAIL: returns ok=true when email-batch-send accepts the request; the
// batch-send worker flips the blast row to 'sent'/'failed' when it
// finishes.
//
// SMS / WHATSAPP: there's no batch-send entrypoint on twilio-sms /
// whatsapp yet (per spec §8.5 those are optional follow-ups). We iterate
// per-recipient inline using `resolve_calendar_audience`, fan out to the
// existing sms-send / whatsapp-send single-recipient functions, and flip
// the blast status ourselves at the end. Keeps SMS/WhatsApp blasts
// usable today without waiting for those modules to expose a batch API.

// Per spec §7.3 + §8.4: create an email_batch_jobs row of type
// 'calendar_blast' first, then invoke email-batch-send with {jobId}.
// Mirrors CalendarBlastService.sendBlast browser-side path.
const emailDispatcher: ChannelDispatcher = {
  async dispatch({ blastId, calendarId }) {
    // 1. Look up the blast to get subject + body + audience filter
    const blastRes = await supabase
      .from('calendars_blasts')
      .select('subject, body_template, audience_filter, recipient_count')
      .eq('id', blastId)
      .single();
    if (blastRes.error || !blastRes.data) {
      return { ok: false, reason: blastRes.error?.message ?? 'blast not found' };
    }
    const blast = blastRes.data;

    // 2. Create the email_batch_jobs row
    const jobInsert = await supabase
      .from('email_batch_jobs')
      .insert({
        email_type: 'calendar_blast',
        source_type: 'calendar',
        source_id: calendarId,
        subject_template: blast.subject ?? '',
        content_template: blast.body_template ?? '',
        status: 'pending',
        total_recipients: blast.recipient_count ?? 0,
        config: { blast_id: blastId, audience_filter: blast.audience_filter ?? {} },
      })
      .select('id')
      .single();
    if (jobInsert.error || !jobInsert.data) {
      return { ok: false, reason: jobInsert.error?.message ?? 'email_batch_jobs insert failed' };
    }
    const jobId = jobInsert.data.id;

    // 3. Stamp the blast so the drawer can correlate per-recipient logs
    await supabase
      .from('calendars_blasts')
      .update({ email_batch_job_id: jobId })
      .eq('id', blastId);

    // 4. Hand off to email-batch-send
    const { error: sendErr } = await supabase.functions.invoke('email-batch-send', {
      body: { jobId },
    });
    if (sendErr) return { ok: false, reason: sendErr.message ?? 'email-batch-send failed' };
    return { ok: true };
  },
};

/**
 * Build a per-recipient dispatcher that fans out to a single-recipient
 * channel function (sms-send or whatsapp-send) via the existing audience
 * resolver. Concurrency: serial — provider rate limits + the simplicity
 * of single-pass error counting make parallelism not worth it for the
 * typical < 1000-recipient calendar blast.
 *
 * Twilio's per-second cap is 1 msg/sec for trial accounts, 100 msg/sec
 * for paid. The 250ms delay = 4 msg/sec stays under the trial cap so a
 * fresh install can use this without provisioning a paid-tier project
 * first.
 */
function makePerRecipientDispatcher(channel: 'sms' | 'whatsapp', functionName: string): ChannelDispatcher {
  return {
    async dispatch({ blastId, calendarId }) {
      const result = await dispatchPerRecipient(blastId, calendarId, {
        supabase: supabase as any,
        channel,
        delayMs: 250,
        send: {
          async send({ to, body, metadata }) {
            try {
              const { error } = await supabase.functions.invoke(functionName, {
                body: { to, body, metadata },
              });
              if (error) return { ok: false, reason: error.message ?? `${functionName} failed` };
              return { ok: true };
            } catch (e) {
              return { ok: false, reason: e instanceof Error ? e.message : String(e) };
            }
          },
        },
        logger,
      });
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? 'per-recipient dispatch failed' };
    },
  };
}

const smsDispatcher = makePerRecipientDispatcher('sms', 'sms-send');
const whatsappDispatcher = makePerRecipientDispatcher('whatsapp', 'whatsapp-send');

const channels = {
  email: emailDispatcher,
  sms: smsDispatcher,
  whatsapp: whatsappDispatcher,
};

export default async function handler(job: BullJob): Promise<unknown> {
  const kind = job.data?.kind ?? job.name;
  logger.info('cron tick', { kind, jobName: job.name });

  switch (kind) {
    case 'calendars:dispatch-scheduled-blasts': {
      return dispatchScheduledBlasts({
        supabase: supabase as any,
        channels,
        logger,
      });
    }
    default:
      logger.warn('unknown calendars cron kind', { kind });
      return { ok: false, reason: 'unknown_kind', kind };
  }
}
