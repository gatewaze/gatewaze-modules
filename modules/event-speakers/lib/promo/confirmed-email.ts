// @ts-nocheck — supabase-js resolved at module-host install time.

/**
 * Speaker-confirmed email, sent by the promo-kit worker at kit-finalize time
 * so the kit zip rides along as an attachment (the kit doesn't exist yet at
 * the moment an admin clicks Confirm — the old client-side send could never
 * attach it).
 *
 * Template source is the same events_communication_settings row the admin
 * Comms UI edits (speaker_confirmed_email_*). Rendering implements the
 * admin templateVariables grammar subset these templates use:
 * {{scope.field}} dotted lookups with an optional `| default:"..."` filter
 * (unknown filters are ignored rather than erroring). The context mirrors
 * SpeakerEmailService.buildSpeakerContext, plus:
 *   {{speaker.portal_link}} — ABSOLUTE link to the speaker's checklist page
 *   (edit_link stays portal-relative for parity with the admin sender).
 *
 * Delivery goes through the platform's email-send edge function (service
 * role), which forwards attachments to SendGrid as base64.
 */

interface CommsSettings {
  speaker_confirmed_email_enabled: boolean;
  speaker_confirmed_email_from_key: string | null;
  speaker_confirmed_email_reply_to: string | null;
  speaker_confirmed_email_cc: string | null;
  speaker_confirmed_email_subject: string | null;
  speaker_confirmed_email_content: string | null;
  speaker_confirmed_email_template_id: string | null;
}

/** {{scope.field}} + `| default:"…"` rendering (subset of the admin grammar). */
export function renderTemplate(template: string, context: Record<string, Record<string, string | undefined>>): string {
  return template.replace(/\{\{\s*(\w+)\.(\w+)((?:\s*\|[^}]*)?)\s*\}\}/g, (raw, scope, field, filterPart) => {
    let value = context?.[scope]?.[field];
    const defaultMatch = /\|\s*default:\s*"([^"]*)"/.exec(filterPart ?? '');
    if ((value === undefined || value === null || value === '') && defaultMatch) value = defaultMatch[1];
    return value ?? '';
  });
}

function formatEmailDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(iso),
    );
  } catch {
    return undefined;
  }
}

function fromAddressFor(fromKey: string | null): { email: string; name?: string } | null {
  const key = (fromKey || 'events').toUpperCase();
  const raw =
    process.env[`VITE_SENDGRID_FROM_${key}`] ||
    process.env.VITE_SENDGRID_FROM_EVENTS ||
    process.env.VITE_SENDGRID_FROM_DEFAULT ||
    process.env.EMAIL_FROM ||
    '';
  if (!raw) return null;
  // "Name - email@x" / "Name <email@x>" / bare address
  const angled = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (angled) return { email: angled[2].trim(), name: angled[1].trim() || undefined };
  const dashed = raw.match(/^(.*?)\s+-\s+(\S+@\S+)$/);
  if (dashed) return { email: dashed[2].trim(), name: dashed[1].trim() || undefined };
  return { email: raw.trim(), name: process.env.EMAIL_FROM_NAME || undefined };
}

export interface ConfirmedEmailResult {
  sent: boolean;
  reason?: string;
}

/**
 * Send the confirmed email for a kit if due: enabled in comms settings,
 * inline content present, not already sent. Attaches the kit zip when
 * provided. Never throws — kit finalization must not fail on email issues.
 */
export async function sendConfirmedEmailIfDue(
  supabase,
  kit: { id: string; confirmed_email_sent_at?: string | null },
  context: {
    talk: { title: string; synopsis: string | null; edit_token: string | null };
    event: {
      id: string;
      event_id: string;
      event_title: string;
      event_city: string | null;
      event_start: string;
      event_end?: string | null;
    };
    speaker: { fullName: string; jobTitle: string | null; company: string | null };
  },
  speakerEmail: string | null,
  zip: { buffer: Buffer; filename: string } | null,
  log: (m: string) => void,
): Promise<ConfirmedEmailResult> {
  try {
    if (kit.confirmed_email_sent_at) return { sent: false, reason: 'already_sent' };
    if (!speakerEmail) return { sent: false, reason: 'no_speaker_email' };

    const { data: settings } = await supabase
      .from('events_communication_settings')
      .select(
        'speaker_confirmed_email_enabled, speaker_confirmed_email_from_key, speaker_confirmed_email_reply_to, speaker_confirmed_email_cc, speaker_confirmed_email_subject, speaker_confirmed_email_content, speaker_confirmed_email_template_id',
      )
      .eq('event_id', context.event.id)
      .maybeSingle<CommsSettings>();

    if (!settings?.speaker_confirmed_email_enabled) return { sent: false, reason: 'disabled' };
    // Template-by-id rendering lives in the admin; the worker supports the
    // inline (Start-from-scratch) form the Comms tab saves.
    const subjectTpl = settings.speaker_confirmed_email_subject;
    const contentTpl = settings.speaker_confirmed_email_content;
    if (!subjectTpl || !contentTpl) {
      return { sent: false, reason: settings.speaker_confirmed_email_template_id ? 'template_id_unsupported_in_worker' : 'no_inline_content' };
    }

    const portalBase = (process.env.PORTAL_URL ?? '').trim().replace(/\/+$/, '');
    const editPath = context.talk.edit_token
      ? `/events/${context.event.event_id}/talks/success/${context.talk.edit_token}`
      : '';
    const nameParts = context.speaker.fullName.trim().split(/\s+/);
    const templateContext = {
      customer: {
        first_name: nameParts[0] ?? '',
        last_name: nameParts.slice(1).join(' '),
        full_name: context.speaker.fullName,
        email: speakerEmail,
      },
      speaker: {
        first_name: nameParts[0] ?? '',
        last_name: nameParts.slice(1).join(' '),
        full_name: context.speaker.fullName,
        email: speakerEmail,
        talk_title: context.talk.title,
        talk_synopsis: context.talk.synopsis ?? '',
        company: context.speaker.company ?? '',
        job_title: context.speaker.jobTitle ?? '',
        edit_link: editPath,
        portal_link: portalBase && editPath ? `${portalBase}${editPath}` : editPath,
      },
      event: {
        name: context.event.event_title,
        id: context.event.event_id,
        city: context.event.event_city ?? '',
        start_date: formatEmailDate(context.event.event_start) ?? '',
        end_date: formatEmailDate(context.event.event_end) ?? '',
      },
    };

    const from = fromAddressFor(settings.speaker_confirmed_email_from_key);
    if (!from) return { sent: false, reason: 'no_from_address' };

    const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    const res = await fetch(`${supabaseUrl}/functions/v1/email-send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        to: [speakerEmail],
        cc: settings.speaker_confirmed_email_cc || undefined,
        from: from.email,
        fromName: from.name,
        replyTo: settings.speaker_confirmed_email_reply_to || undefined,
        subject: renderTemplate(subjectTpl, templateContext),
        html: renderTemplate(contentTpl, templateContext),
        attachments: zip
          ? [
              {
                content: zip.buffer.toString('base64'),
                filename: zip.filename,
                type: 'application/zip',
                disposition: 'attachment',
              },
            ]
          : undefined,
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      log(`confirmed email send failed: ${res.status} ${body}`);
      return { sent: false, reason: `send_failed_${res.status}` };
    }

    await supabase
      .from('speaker_promo_kits')
      .update({ confirmed_email_sent_at: new Date().toISOString() })
      .eq('id', kit.id);
    log(`confirmed email sent to ${speakerEmail}${zip ? ' with promo-kit zip attached' : ''}`);
    return { sent: true };
  } catch (err) {
    log(`confirmed email error: ${err instanceof Error ? err.message : err}`);
    return { sent: false, reason: 'exception' };
  }
}
