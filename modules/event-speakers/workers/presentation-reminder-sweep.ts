// @ts-nocheck — supabase-js resolved at module-host install time.

/**
 * event-speakers:presentation-reminder-sweep — nudges confirmed speakers who
 * still haven't given us their presentation.
 *
 * Runs daily. For each upcoming event whose comms settings enable the
 * reminder, for each configured offset (default 14 and 8 days before the
 * event), it emails the confirmed speakers whose talk has neither a
 * presentation_url nor a presentation_storage_path.
 *
 * Design notes:
 *   - Idempotency is a UNIQUE (talk_id, offset_days) row in
 *     speaker_presentation_reminders, inserted BEFORE the send. Two overlapping
 *     ticks can't double-send: the loser hits the constraint and skips. A send
 *     failure deletes the row so the next tick retries.
 *   - The offset window is "on or past the offset day, but not yet past the
 *     next (smaller) offset". A tick missed because the worker was down still
 *     sends the next day rather than silently skipping the reminder.
 *   - Speakers who upload between reminders simply stop matching the query —
 *     there's no separate cancellation path to get out of step.
 *   - Copy lives in events_communication_settings (inline, or an
 *     email_templates row via speaker_presentation_reminder_template_id), the
 *     same shape as the approved/confirmed emails.
 */

import { serviceClient } from '../lib/promo/service-client.js';
import { renderTemplate } from '../lib/promo/confirmed-email.js';

const EVENT_CAP = 25;
const RECIPIENT_CAP = 200;

function log(msg: string): void {
  console.log(`[event-speakers:presentation-reminder] ${msg}`);
}

function formatEmailDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(iso));
  } catch {
    return '';
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
  const angled = raw.match(/^(.*?)\s*<([^>]+)>$/);
  if (angled) return { email: angled[2].trim(), name: angled[1].trim() || undefined };
  const dashed = raw.match(/^(.*?)\s+-\s+(\S+@\S+)$/);
  if (dashed) return { email: dashed[2].trim(), name: dashed[1].trim() || undefined };
  return { email: raw.trim(), name: process.env.EMAIL_FROM_NAME || undefined };
}

/** Whole days from now until `iso`, rounded down. */
function daysUntil(iso: string): number {
  return Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
}

/**
 * The offset that is due right now, or null. Due means: we've reached the
 * offset day, and we haven't yet reached the next smaller offset (which would
 * be that reminder's turn instead). Being late still sends — a worker outage
 * shouldn't silently swallow a reminder.
 */
function dueOffset(daysLeft: number, offsets: number[]): number | null {
  const sorted = [...offsets].filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => b - a);
  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];
    if (daysLeft <= current && (next === undefined || daysLeft > next)) return current;
  }
  return null;
}

export default async function handlePresentationReminderSweep(): Promise<unknown> {
  const supabase = serviceClient();
  const nowIso = new Date().toISOString();

  const { data: events, error: eventsErr } = await supabase
    .from('events')
    .select('id, event_id, event_title, event_city, event_start, event_end')
    .gte('event_start', nowIso)
    .order('event_start', { ascending: true })
    .limit(EVENT_CAP);
  if (eventsErr) {
    log(`event lookup failed: ${eventsErr.message}`);
    return { error: eventsErr.message };
  }

  let sent = 0;
  let skipped = 0;

  for (const event of events ?? []) {
    const { data: settings } = await supabase
      .from('events_communication_settings')
      .select(
        'speaker_presentation_reminder_enabled, speaker_presentation_reminder_subject, speaker_presentation_reminder_content, speaker_presentation_reminder_template_id, speaker_presentation_reminder_from_key, speaker_presentation_reminder_reply_to, speaker_presentation_reminder_cc, speaker_presentation_reminder_offsets',
      )
      .eq('event_id', event.id)
      .maybeSingle();
    if (!settings?.speaker_presentation_reminder_enabled) continue;

    const offset = dueOffset(daysUntil(event.event_start), settings.speaker_presentation_reminder_offsets ?? [14, 8]);
    if (offset === null) continue;

    // Inline copy wins; fall back to the shared template row.
    let subjectTpl = settings.speaker_presentation_reminder_subject;
    let contentTpl = settings.speaker_presentation_reminder_content;
    if ((!subjectTpl || !contentTpl) && settings.speaker_presentation_reminder_template_id) {
      const { data: tpl } = await supabase
        .from('email_templates')
        .select('subject, content_html')
        .eq('id', settings.speaker_presentation_reminder_template_id)
        .maybeSingle();
      subjectTpl = subjectTpl || tpl?.subject || null;
      contentTpl = contentTpl || tpl?.content_html || null;
    }
    if (!subjectTpl || !contentTpl) {
      log(`event ${event.event_id}: reminder enabled but no copy configured — skipping`);
      continue;
    }

    const from = fromAddressFor(settings.speaker_presentation_reminder_from_key);
    if (!from) {
      log(`event ${event.event_id}: no from address resolvable — skipping`);
      continue;
    }

    // Confirmed talks still missing BOTH presentation fields. A file upload
    // sets only presentation_storage_path, a pasted link only
    // presentation_url — either one means we have what we need.
    const { data: talks } = await supabase
      .from('events_talks')
      .select('id, title, edit_token, presentation_url, presentation_storage_path')
      .eq('event_uuid', event.id)
      .eq('status', 'confirmed')
      .is('presentation_url', null)
      .is('presentation_storage_path', null)
      .limit(RECIPIENT_CAP);

    for (const talk of talks ?? []) {
      // Primary speaker → profile (name + email).
      const { data: bridge } = await supabase
        .from('events_talk_speakers')
        .select('speaker:events_speaker_profiles(name, email)')
        .eq('talk_id', talk.id)
        .eq('is_primary', true)
        .maybeSingle();
      const speaker = bridge?.speaker;
      if (!speaker?.email) {
        skipped++;
        continue;
      }

      // Claim the (talk, offset) slot first — the unique constraint is what
      // makes concurrent ticks safe.
      const { error: claimErr } = await supabase.from('speaker_presentation_reminders').insert({
        talk_id: talk.id,
        event_uuid: event.id,
        offset_days: offset,
        recipient_email: speaker.email,
      });
      if (claimErr) {
        skipped++; // already sent for this offset (or a genuine insert failure)
        continue;
      }

      const nameParts = (speaker.name ?? '').trim().split(/\s+/);
      const portalBase = (process.env.PORTAL_URL ?? '').trim().replace(/\/+$/, '');
      const editPath = talk.edit_token
        ? `/events/${event.event_id}/talks/success/${talk.edit_token}`
        : '';
      const context = {
        customer: { first_name: nameParts[0] ?? '', full_name: speaker.name ?? '', email: speaker.email },
        speaker: {
          first_name: nameParts[0] ?? '',
          full_name: speaker.name ?? '',
          email: speaker.email,
          talk_title: talk.title,
          edit_link: editPath,
          portal_link: portalBase && editPath ? `${portalBase}${editPath}` : editPath,
        },
        event: {
          name: event.event_title,
          id: event.event_id,
          city: event.event_city ?? '',
          start_date: formatEmailDate(event.event_start),
          end_date: formatEmailDate(event.event_end),
          days_until: String(Math.max(0, daysUntil(event.event_start))),
        },
      };

      const supabaseUrl = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
      let ok = false;
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/email-send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            to: [speaker.email],
            cc: settings.speaker_presentation_reminder_cc || undefined,
            from: from.email,
            fromName: from.name,
            replyTo: settings.speaker_presentation_reminder_reply_to || undefined,
            subject: renderTemplate(subjectTpl, context),
            html: renderTemplate(contentTpl, context),
          }),
        });
        ok = res.ok;
        if (!ok) log(`send failed ${res.status} for ${speaker.email}`);
      } catch (err) {
        log(`send error for ${speaker.email}: ${err instanceof Error ? err.message : err}`);
      }

      if (ok) {
        sent++;
      } else {
        // Release the claim so the next tick retries rather than the speaker
        // silently never being reminded.
        await supabase
          .from('speaker_presentation_reminders')
          .delete()
          .eq('talk_id', talk.id)
          .eq('offset_days', offset);
        skipped++;
      }
    }
  }

  if (sent || skipped) log(`sent ${sent}, skipped ${skipped}`);
  return { sent, skipped };
}
