import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isEmailConfigured, sendEmail } from '../_shared/email.ts';

/**
 * SendGrid Inbound Parse Webhook Handler
 *
 * Receives inbound emails via SendGrid's Inbound Parse and:
 * 1. Matches the recipient address to a newsletter collection's from_email
 * 2. Stores the reply in newsletter_replies
 * 3. Optionally forwards the reply to the configured forward_replies_to address
 *
 * SendGrid sends inbound parse data as multipart/form-data.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type',
};

/**
 * Classify an inbound message as auto-reply / OOO / bounce so the admin
 * replies tab can hide them by default without dropping the data.
 *
 * Detection cascade — first match wins, returned reason explains why:
 *   1. Auto-Submitted: <not 'no'>            (RFC 3834, canonical OOO signal)
 *   2. X-Auto-Response-Suppress: present     (Exchange)
 *   3. Precedence: bulk | auto_reply | junk  (older convention)
 *   4. X-Autoreply / X-Autorespond           (Lotus / qmail / cPanel)
 *   5. Return-Path: <>                       (DSN / bounce envelope)
 *   6. Subject starts with OOO/vacation/auto-reply phrasing
 *   7. From: mailer-daemon@ / postmaster@    (bounce from misconfigured systems)
 *
 * `headers` is the raw multi-line header blob SendGrid Inbound Parse forwards
 * verbatim. We don't try to fully parse it — substring/regex on header lines
 * is sufficient for these short discriminators and much cheaper than a full
 * MIME parse for every reply.
 */
function classifyAutoReply(
  headers: string,
  subject: string,
  fromEmail: string,
): { isAuto: boolean; reason: string | null } {
  // 1. Auto-Submitted — RFC 3834. Only 'no' means human; anything else is auto.
  const m1 = headers.match(/^Auto-Submitted:\s*([^\r\n;]+)/im);
  if (m1) {
    const val = m1[1].trim().toLowerCase();
    if (val && val !== 'no') return { isAuto: true, reason: `auto-submitted:${val}` };
  }

  // 2. Exchange's "don't auto-respond to me" header — its presence means the
  // sender IS the auto-responder telling us not to loop.
  if (/^X-Auto-Response-Suppress:/im.test(headers)) {
    return { isAuto: true, reason: 'x-auto-response-suppress' };
  }

  // 3. Precedence: bulk/auto_reply/junk
  const m3 = headers.match(/^Precedence:\s*([^\r\n]+)/im);
  if (m3) {
    const val = m3[1].trim().toLowerCase();
    if (val === 'bulk' || val === 'auto_reply' || val === 'junk' || val === 'list') {
      return { isAuto: true, reason: `precedence:${val}` };
    }
  }

  // 4. Older Lotus / qmail / cPanel markers
  if (/^X-Autoreply:\s*yes/im.test(headers)) return { isAuto: true, reason: 'x-autoreply' };
  if (/^X-Autorespond:/im.test(headers))     return { isAuto: true, reason: 'x-autorespond' };

  // 5. Empty Return-Path is the DSN/bounce envelope sender convention.
  if (/^Return-Path:\s*<>\s*$/im.test(headers)) {
    return { isAuto: true, reason: 'dsn' };
  }

  // 6. Subject-level fallback for mail clients that don't set headers.
  // Matches the start of subject (after optional Re:/Fwd: prefixes the
  // sender's client may add — rare on OOOs but cheap to allow).
  const subjPattern = /^\s*(?:re|fwd?)?\s*:?\s*(out\s*of\s*(?:the\s*)?office|automatic\s*reply|auto[-\s]?reply|autoreply|autoresponse|vacation\s*reply|on\s*leave|on\s*vacation|away\s*from|i'?m\s*(?:currently\s*)?away|i\s*am\s*(?:currently\s*)?away)\b/i;
  if (subjPattern.test(subject || '')) {
    return { isAuto: true, reason: 'subject-pattern' };
  }

  // 7. Common bounce envelope addresses. fromEmail is already lowercased.
  if (/^(mailer-daemon|postmaster|mail-daemon)@/.test(fromEmail)) {
    return { isAuto: true, reason: 'bounce-sender' };
  }

  return { isAuto: false, reason: null };
}

async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    // SendGrid sends inbound parse as multipart/form-data
    const formData = await req.formData();

    const toRaw = formData.get('to') as string || '';
    const fromRaw = formData.get('from') as string || '';
    const subject = formData.get('subject') as string || '';
    const text = formData.get('text') as string || '';
    const html = formData.get('html') as string || '';
    const envelope = formData.get('envelope') as string || '{}';
    const headers = formData.get('headers') as string || '';
    const replyTo = formData.get('reply-to') as string || formData.get('Reply-To') as string || '';

    // =========================================================================
    // Route: Luma registration/cancellation emails
    // Detected by: sender contains "lu.ma" or "luma.com", or body contains
    // Luma event URLs (evt-XXX), or subject matches registration patterns.
    // =========================================================================
    const isLumaEmail = fromRaw.includes('lu.ma') || fromRaw.includes('luma.com')
      || /evt-[A-Za-z0-9]+/.test(text)
      || /has registered for|cancelled their registration|declined their invitation/i.test(text);

    if (isLumaEmail) {
      console.log(`Luma email detected from ${fromRaw}: ${subject}`);
      try {
        // Forward to the Luma registration processing function
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

        const lumaResponse = await fetch(
          `${supabaseUrl}/functions/v1/integrations-luma-process-registration`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Authorization': `Bearer ${serviceKey}`,
            },
            body: new URLSearchParams({
              from: fromRaw,
              to: toRaw,
              subject,
              text,
              html,
              envelope,
              headers,
              'reply-to': replyTo,
            }),
          }
        );

        const lumaResult = await lumaResponse.text();
        console.log(`Luma processing result (${lumaResponse.status}):`, lumaResult);

        return new Response(
          JSON.stringify({ success: true, handler: 'luma', status: lumaResponse.status }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      } catch (lumaErr) {
        console.error('Luma processing error:', lumaErr);
        // Don't fail — continue to newsletter processing as fallback
      }
    }

    // Parse sender
    const fromMatch = fromRaw.match(/(?:(.+?)\s*<)?([^<>\s]+@[^<>\s]+)>?/);
    const fromEmail = fromMatch?.[2]?.toLowerCase() || fromRaw.toLowerCase();
    const fromName = fromMatch?.[1]?.trim().replace(/^"|"$/g, '') || null;

    // Parse recipient(s) — extract email addresses from the to field
    const toEmails: string[] = [];
    const toMatches = toRaw.matchAll(/([^<>\s,]+@[^<>\s,]+)/g);
    for (const m of toMatches) {
      toEmails.push(m[1].toLowerCase());
    }

    // Also check envelope for the actual recipient
    try {
      const env = JSON.parse(envelope);
      if (env.to && Array.isArray(env.to)) {
        for (const addr of env.to) {
          const a = addr.toLowerCase();
          if (!toEmails.includes(a)) toEmails.push(a);
        }
      }
    } catch { /* ignore envelope parse errors */ }

    const autoReplyVerdict = classifyAutoReply(headers, subject, fromEmail);
    console.log(
      `Inbound email from ${fromEmail} to ${toEmails.join(', ')}: ${subject}` +
        (autoReplyVerdict.isAuto ? ` [auto:${autoReplyVerdict.reason}]` : ''),
    );

    if (toEmails.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: 'No recipient found' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // Extract In-Reply-To header to match to original newsletter send
    let inReplyTo: string | null = null;
    const inReplyToMatch = headers.match(/In-Reply-To:\s*<?([^>\s]+)>?/i);
    if (inReplyToMatch) {
      inReplyTo = inReplyToMatch[1];
    }

    // Find the newsletter collection(s) that match the recipient address.
    // Replies can land at either:
    //   - `from_email` (most common — no separate Reply-To set), or
    //   - `reply_to` (explicit Reply-To header on outbound; replies route
    //     to a different mailbox than the From, e.g. mailing from a
    //     branded sub-domain but collecting replies at a unified inbox).
    // Match on EITHER so a Reply-To-only mailbox still surfaces replies.
    // OR is a comma-separated PostgREST filter; values must be lowercased
    // to match the toEmails normalisation above.
    const inList = toEmails.map((e) => `"${e}"`).join(',');
    const { data: collections } = await supabase
      .from('newsletters_template_collections')
      .select('id, name, from_email, reply_to, forward_replies_to')
      .or(`from_email.in.(${inList}),reply_to.in.(${inList})`);

    if (!collections || collections.length === 0) {
      console.warn('No newsletter collection found for addresses:', toEmails);
      return new Response(
        JSON.stringify({ success: true, message: 'No matching newsletter, ignored' }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let stored = 0;
    let forwarded = 0;

    for (const collection of collections) {
      // Try to find the original send log entry from In-Reply-To header
      let sendLogId: string | null = null;
      let editionId: string | null = null;

      if (inReplyTo) {
        // Extract the base message ID (before the first dot)
        const baseId = inReplyTo.split('.')[0].replace(/[<>]/g, '');
        const { data: logEntry } = await supabase
          .from('email_send_log')
          .select('id, newsletter_send_id')
          .eq('provider_message_id', baseId)
          .eq('recipient_email', fromEmail)
          .limit(1)
          .maybeSingle();

        if (logEntry) {
          sendLogId = logEntry.id;
          // Look up the edition from the send
          if (logEntry.newsletter_send_id) {
            const { data: send } = await supabase
              .from('newsletter_sends')
              .select('edition_id')
              .eq('id', logEntry.newsletter_send_id)
              .maybeSingle();
            editionId = send?.edition_id || null;
          }
        }
      }

      // Store the reply
      const { error: insertError } = await supabase
        .from('newsletter_replies')
        .insert({
          collection_id: collection.id,
          from_email: fromEmail,
          from_name: fromName,
          subject,
          body_text: text || null,
          body_html: html || null,
          in_reply_to: inReplyTo,
          send_log_id: sendLogId,
          edition_id: editionId,
          forwarded_to: collection.forward_replies_to || null,
          is_auto_reply: autoReplyVerdict.isAuto,
          auto_reply_reason: autoReplyVerdict.reason,
        });

      if (insertError) {
        console.error(`Error storing reply for ${collection.name}:`, insertError);
        continue;
      }
      stored++;

      // Forward the reply if configured — never forward auto-replies (OOOs
      // and bounces would just clutter the human inbox the forward points at).
      if (collection.forward_replies_to && isEmailConfigured() && !autoReplyVerdict.isAuto) {
        try {
          // Send from the newsletter address with the replier's name,
          // and set reply-to to the original sender so replies go back to them
          const senderDisplay = fromName || fromEmail.split('@')[0];

          await sendEmail({
            to: collection.forward_replies_to,
            subject,
            html: html || `<pre style="white-space: pre-wrap; font-family: sans-serif;">${text}</pre>`,
            text: text || '',
            fromEmail: collection.from_email,
            fromName: `${senderDisplay} (via ${collection.name})`,
            replyTo: fromEmail,
          });

          // Update the reply record with forwarded status
          await supabase
            .from('newsletter_replies')
            .update({ forwarded_at: new Date().toISOString() })
            .eq('collection_id', collection.id)
            .eq('from_email', fromEmail)
            .eq('subject', subject)
            .order('created_at', { ascending: false })
            .limit(1);

          forwarded++;
          console.log(`Forwarded reply to ${collection.forward_replies_to}`);
        } catch (fwdErr) {
          console.error('Error forwarding reply:', fwdErr);
        }
      }
    }

    console.log(`Processed inbound email: ${stored} stored, ${forwarded} forwarded`);

    return new Response(
      JSON.stringify({ success: true, stored, forwarded }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );

  } catch (error) {
    console.error('Inbound parse error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Internal error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
}

export default handler;
Deno.serve(handler);
