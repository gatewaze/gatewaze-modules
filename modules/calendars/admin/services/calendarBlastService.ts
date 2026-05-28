/**
 * Calendar Blast Service
 *
 * Wraps the calendars_blasts table + the resolve_calendar_audience() RPC.
 * Used by the Messaging tab on the calendar detail page.
 */

import { supabase } from '@/lib/supabase';

export type BlastChannel = 'email' | 'sms' | 'whatsapp';
export type BlastStatus = 'draft' | 'scheduled' | 'sending' | 'sent' | 'failed' | 'cancelled';

export type AudienceMode = 'any_of' | 'all_of' | 'none_of';
export type AudienceKind = 'registered' | 'attended';
// 'specific'              — match against the explicit event_ids list.
// 'any_past_calendar_event' — match against any event in this calendar that has
//                             already started (event_ids is ignored).
export type AudienceScope = 'specific' | 'any_past_calendar_event';

export interface AudienceParticipationGroup {
  mode: AudienceMode;
  kind: AudienceKind;
  scope?: AudienceScope; // defaults to 'specific' server-side
  event_ids: string[];
}

export interface AudienceFilter {
  membership_types?: string[];
  membership_status?: string[];
  require_email_notifications?: boolean;
  event_participation?: AudienceParticipationGroup[];
}

export interface CalendarBlast {
  id: string;
  calendar_id: string;
  created_by: string;
  channel: BlastChannel;
  subject: string | null;
  body_template: string | null;
  audience_filter: AudienceFilter;
  recipient_count: number;
  email_batch_job_id: string | null;
  sms_job_id: string | null;
  whatsapp_job_id: string | null;
  status: BlastStatus;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateBlastInput {
  calendar_id: string;
  channel: BlastChannel;
  subject?: string;
  body_template?: string;
  audience_filter: AudienceFilter;
  schedule_at?: string | null;
}

export interface AudiencePreviewResult {
  count: number;
  sample: Array<{
    person_id: string | null;
    name: string | null;
    email_masked: string | null;
    membership_type: string | null;
  }>;
}

export interface ServiceResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 1) return email;
  const local = email.substring(0, at);
  const masked =
    local.length <= 2
      ? local[0] + '***'
      : local[0] + '***' + local[local.length - 1];
  return masked + email.substring(at);
}

export class CalendarBlastService {
  /**
   * Live audience preview — calls resolve_calendar_audience() and returns
   * a count plus a small masked sample for the UI.
   */
  static async previewAudience(
    calendarId: string,
    filter: AudienceFilter,
    channel: BlastChannel = 'email'
  ): Promise<ServiceResponse<AudiencePreviewResult>> {
    try {
      const { data, error } = await supabase.rpc('resolve_calendar_audience', {
        p_calendar_id: calendarId,
        p_filter: filter,
        p_channel: channel,
      });

      if (error) {
        console.error('previewAudience RPC error:', error);
        return { success: false, error: error.message };
      }

      const rows = (data || []) as Array<{
        member_id: string;
        person_id: string | null;
        email: string | null;
        phone: string | null;
        membership_type: string | null;
      }>;

      const sample = rows.slice(0, 5).map((r) => ({
        person_id: r.person_id,
        name: null,
        email_masked: maskEmail(r.email),
        membership_type: r.membership_type,
      }));

      return {
        success: true,
        data: { count: rows.length, sample },
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * List past blasts for a calendar (history view).
   */
  static async listBlasts(
    calendarId: string,
    opts: { limit?: number; offset?: number } = {}
  ): Promise<ServiceResponse<{ blasts: CalendarBlast[]; total: number }>> {
    try {
      const limit = opts.limit ?? 50;
      const offset = opts.offset ?? 0;

      const {
        data,
        error,
        count,
      } = await supabase
        .from('calendars_blasts')
        .select('*', { count: 'exact' })
        .eq('calendar_id', calendarId)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (error) return { success: false, error: error.message };

      return {
        success: true,
        data: { blasts: (data || []) as CalendarBlast[], total: count ?? (data?.length ?? 0) },
      };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Create a blast row (status='draft' or 'scheduled') and resolve the
   * audience snapshot. Sending is a separate step (sendBlast).
   */
  static async createBlast(
    input: CreateBlastInput,
    createdBy: string
  ): Promise<ServiceResponse<CalendarBlast>> {
    try {
      // Resolve current audience to record recipient_count
      const preview = await this.previewAudience(
        input.calendar_id,
        input.audience_filter,
        input.channel
      );
      if (!preview.success || !preview.data) {
        return { success: false, error: preview.error || 'Failed to resolve audience' };
      }

      const status: BlastStatus = input.schedule_at ? 'scheduled' : 'draft';

      const { data, error } = await supabase
        .from('calendars_blasts')
        .insert({
          calendar_id: input.calendar_id,
          created_by: createdBy,
          channel: input.channel,
          subject: input.subject ?? null,
          body_template: input.body_template ?? null,
          audience_filter: input.audience_filter,
          recipient_count: preview.data.count,
          status,
          scheduled_at: input.schedule_at ?? null,
        })
        .select()
        .single();

      if (error) return { success: false, error: error.message };

      return { success: true, data: data as CalendarBlast };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * Send a draft or scheduled blast immediately. Triggers the channel-specific
   * delivery worker (email-batch-send for email; SMS/WhatsApp pending the
   * respective module integrations).
   */
  static async sendBlast(blastId: string): Promise<ServiceResponse<CalendarBlast>> {
    try {
      // Mark as sending
      const { data: blast, error: updateErr } = await supabase
        .from('calendars_blasts')
        .update({ status: 'sending', sent_at: new Date().toISOString() })
        .eq('id', blastId)
        .in('status', ['draft', 'scheduled'])
        .select()
        .single();

      if (updateErr || !blast) {
        return { success: false, error: updateErr?.message || 'Blast not found or not sendable' };
      }

      const typed = blast as CalendarBlast;

      // SMS/WhatsApp aren't dispatched from the browser — the Send Now path
      // for those channels routes through the cron worker (which calls
      // dispatchPerRecipient). The browser side just sets status='sending'
      // and the next cron tick picks it up. This keeps the auth model
      // consistent: per-recipient send loops run with the service-role key
      // server-side, never the user's browser session.
      if (typed.channel !== 'email') {
        // Hand the blast off to the cron — set scheduled_at to now() so the
        // dispatcher's `WHERE scheduled_at <= now()` picks it up next tick.
        await supabase
          .from('calendars_blasts')
          .update({ status: 'scheduled', scheduled_at: new Date().toISOString() })
          .eq('id', blastId);
        return { success: true, data: { ...typed, status: 'scheduled' } };
      }

      // Email: per spec §7.3 + §8.4 — create an email_batch_jobs row of
      // type 'calendar_blast' first, link it to the blast, then invoke
      // email-batch-send with {jobId}. The function's calendar_blast
      // branch handles audience resolution + per-recipient send.
      const jobInsert = await supabase
        .from('email_batch_jobs')
        .insert({
          email_type: 'calendar_blast',
          source_type: 'calendar',
          source_id: typed.calendar_id,
          subject_template: typed.subject ?? '',
          content_template: typed.body_template ?? '',
          status: 'pending',
          total_recipients: typed.recipient_count,
          config: {
            blast_id: typed.id,
            audience_filter: typed.audience_filter,
          },
        })
        .select('id')
        .single();
      if (jobInsert.error || !jobInsert.data) {
        await supabase
          .from('calendars_blasts')
          .update({ status: 'failed' })
          .eq('id', blastId);
        return { success: false, error: jobInsert.error?.message || 'failed to create email_batch_jobs row' };
      }
      const jobId = (jobInsert.data as { id: string }).id;

      // Stamp the blast row so the per-blast drawer can find the per-
      // recipient log later (via metadata->>batch_job_id).
      await supabase
        .from('calendars_blasts')
        .update({ email_batch_job_id: jobId })
        .eq('id', blastId);

      const { error: sendErr } = await supabase.functions.invoke('email-batch-send', {
        body: { jobId },
      });
      if (sendErr) {
        await supabase
          .from('calendars_blasts')
          .update({ status: 'failed' })
          .eq('id', blastId);
        return { success: false, error: sendErr.message || 'email-batch-send failed' };
      }

      return { success: true, data: { ...typed, email_batch_job_id: jobId } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Cancel a draft, scheduled, or in-flight blast.
   */
  static async cancelBlast(blastId: string): Promise<ServiceResponse<void>> {
    try {
      const { error } = await supabase
        .from('calendars_blasts')
        .update({ status: 'cancelled' })
        .eq('id', blastId)
        .in('status', ['draft', 'scheduled', 'sending']);

      if (error) return { success: false, error: error.message };
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  }

  /**
   * List templates the calendar composer is allowed to load — per spec
   * §9.5: scope IN ('calendar','global'). Inactive templates are filtered
   * out at the DB layer (covered by the idx_email_templates_scope_active
   * partial index in bulk-emailing migration 005).
   */
  static async listCalendarTemplates(): Promise<ServiceResponse<CalendarTemplate[]>> {
    try {
      const { data, error } = await supabase
        .from('email_templates')
        .select('id, name, subject, html_body, text_body, template_scope')
        .eq('is_active', true)
        .in('template_scope', ['calendar', 'global'])
        .order('name', { ascending: true });
      if (error) return { success: false, error: error.message };
      return { success: true, data: (data ?? []) as CalendarTemplate[] };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  /**
   * Detail fetch for the per-blast drawer — pulls the blast row + the
   * per-recipient delivery log (from bulk-emailing's email_send_log table)
   * filtered by the blast's email_batch_job_id. Returns up to `limit`
   * recipients; admins can paginate later if needed (typical blast is
   * < 1000 recipients).
   *
   * For SMS/WhatsApp blasts, the per-recipient log lives elsewhere
   * (twilio's sms_logs or twilio_sms_logs). v1 returns just the blast
   * row + recipient_count summary; v2 can wire the SMS log when those
   * modules expose a queryable per-recipient table.
   */
  static async getBlastDetail(blastId: string, opts: { limit?: number } = {}): Promise<ServiceResponse<BlastDetail>> {
    const limit = opts.limit ?? 200;
    try {
      const blastRes = await supabase
        .from('calendars_blasts')
        .select('id, calendar_id, channel, subject, body_template, audience_filter, recipient_count, email_batch_job_id, sms_job_id, whatsapp_job_id, status, scheduled_at, sent_at, created_at, created_by')
        .eq('id', blastId)
        .single();
      if (blastRes.error || !blastRes.data) {
        return { success: false, error: blastRes.error?.message ?? 'Blast not found' };
      }
      const blast = blastRes.data as CalendarBlast;

      const recipients: BlastRecipientLog[] = [];
      if (blast.channel === 'email' && blast.email_batch_job_id) {
        // email_send_log carries batch_job_id as a top-level column (set
        // by email-batch-send when each per-recipient row is queued).
        const logRes = await supabase
          .from('email_send_log')
          .select('id, recipient_email, status, sent_at, failure_error, created_at')
          .eq('batch_job_id', blast.email_batch_job_id)
          .order('created_at', { ascending: false })
          .limit(limit);
        if (!logRes.error && Array.isArray(logRes.data)) {
          recipients.push(...(logRes.data as BlastRecipientLog[]));
        }
      }

      return { success: true, data: { blast, recipients } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }
}

// ---------------------------------------------------------------------------
// Additional types for templates + blast detail
// ---------------------------------------------------------------------------

export interface CalendarTemplate {
  id: string;
  name: string;
  subject: string;
  html_body: string | null;
  text_body: string | null;
  template_scope: 'event' | 'calendar' | 'global';
}

export interface BlastRecipientLog {
  id: string;
  recipient_email: string;
  status: string;
  sent_at: string | null;
  failure_error: string | null;
  created_at: string;
}

export interface BlastDetail {
  blast: CalendarBlast;
  recipients: BlastRecipientLog[];
}
