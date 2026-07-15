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

/**
 * Detect "the recipient has left / changed jobs" auto-notices, so a now-dead
 * address can be unsubscribed from the list it was sent as part of — distinct
 * from a temporary out-of-office (which we only categorise). Content-based
 * (these rarely set auto headers); patterns are kept tight so a genuine human
 * reply that merely says "no longer" isn't mistaken for a departure.
 */
function classifyDeparted(subject: string, text: string): { departed: boolean; reason: string | null } {
  const hay = `${subject || ''}\n${(text || '').slice(0, 2000)}`.toLowerCase();
  const patterns: Array<[RegExp, string]> = [
    [/no longer (with|employed|working (?:at|for|here)|works? (?:at|for|here)|a member of|part of)\b/, 'no-longer-with'],
    [/(?:has|have) left (?:the )?(?:company|organi[sz]ation|firm|business|team)\b/, 'left-company'],
    [/is no longer (?:with|employed|at this (?:company|organi))/, 'no-longer-with'],
    [/(?:mailbox|email(?: address)?) is no longer (?:monitored|active|in use|valid)/, 'address-retired'],
    [/chang(?:ed|ing) (?:jobs|employers?|companies)/, 'changed-jobs'],
    [/moved on from (?:the )?(?:company|[a-z])/, 'moved-on'],
    [/no longer (?:a|an) [a-z]+ (?:employee|member)/, 'no-longer-employee'],
  ];
  for (const [re, reason] of patterns) if (re.test(hay)) return { departed: true, reason };
  return { departed: false, reason: null };
}

// Remove an address from a list (job-change / departed sender). Idempotent.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function unsubscribeFromList(supabase: any, listId: string | null | undefined, email: string): Promise<void> {
  if (!listId || !email) return;
  const { error } = await supabase
    .from('list_subscriptions')
    .update({ subscribed: false, unsubscribed_at: new Date().toISOString() })
    .eq('list_id', listId)
    .ilike('email', email);
  if (error) console.error('[inbound] departed unsubscribe failed:', error.message);
}

// Normalise a subject for matching a reply back to its originating send: strip
// leading reply/forward/auto-reply prefixes (Re:, Fwd:, Automatic reply:, and
// common localisations), lowercase, collapse whitespace.
const SUBJECT_PREFIX_RE =
  /^\s*(re|fwd?|fw|aw|sv|vs|antwort|automatic reply|automatische antwort|respuesta autom[aá]tica|r[eé]ponse automatique|out of office|auto(?:matic)?[- ]?reply)\s*:\s*/i;
function normSubject(s: string | null | undefined): string {
  let t = s || '';
  for (let i = 0; i < 5 && SUBJECT_PREFIX_RE.test(t); i++) t = t.replace(SUBJECT_PREFIX_RE, '');
  return t.toLowerCase().replace(/\s+/g, ' ').trim();
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

        // NB: must be JSON — the Luma processor parses multipart/form-data or
        // falls back to req.json(); a urlencoded body lands in the JSON path
        // and throws, so every forwarded email used to fail here.
        const lumaResponse = await fetch(
          `${supabaseUrl}/functions/v1/integrations-luma-process-registration`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${serviceKey}`,
            },
            body: JSON.stringify({
              from: fromRaw,
              to: toRaw,
              subject,
              text,
              html,
              envelope,
              headers,
              replyTo,
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
    // A departure/job-change notice: categorised (auto) AND triggers unsubscribe.
    const departedVerdict = classifyDeparted(subject, text);
    const isAuto = autoReplyVerdict.isAuto || departedVerdict.departed;
    // reason drives the Replies-tab category filter: 'departed:*' → Job changes,
    // 'dsn'/'bounce-sender' → Bounces, other auto reasons → Out of office.
    const autoReason = departedVerdict.departed ? `departed:${departedVerdict.reason}` : autoReplyVerdict.reason;
    console.log(
      `Inbound email from ${fromEmail} to ${toEmails.join(', ')}: ${subject}` +
        (isAuto ? ` [auto:${autoReason}]` : '') + (departedVerdict.departed ? ' [departed]' : ''),
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

    // =========================================================================
    // Route: Broadcast replies
    // Resolve the originating send via In-Reply-To → email_send_log. If the
    // matched log row is a BROADCAST send, store it as a broadcast reply and
    // return — so a reply isn't ALSO stored as a newsletter reply when a
    // broadcast shares its From/Reply-To address with a newsletter collection.
    // =========================================================================
    // Resolve which broadcast send this is a reply to: In-Reply-To (precise)
    // first, then a recipient+address fallback for replies whose In-Reply-To is
    // missing/malformed — so broadcasts capture replies as reliably as
    // newsletters (which also match by the recipient address).
    let bLog: { id: string; broadcast_send_id: string | null } | null = null;
    if (inReplyTo) {
      const baseId = inReplyTo.split('.')[0].replace(/[<>]/g, '');
      const { data } = await supabase
        .from('email_send_log')
        .select('id, broadcast_send_id')
        .eq('provider_message_id', baseId)
        .eq('recipient_email', fromEmail)
        .not('broadcast_send_id', 'is', null)
        .limit(1)
        .maybeSingle();
      bLog = data;
    }
    if (!bLog?.broadcast_send_id) {
      // No precise In-Reply-To match. Fall back to the replier's own campaign
      // sends whose From/Reply-To matches one of the reply's recipient
      // addresses — considering BOTH broadcast AND newsletter sends, because
      // they routinely share a From/Reply-To (e.g. a newsletter with
      // reply_to=demetrios@aaif.live and a broadcast sent from the same
      // address). Disambiguate by SUBJECT first (the strongest signal): the
      // send whose subject equals the reply's subject (sans "Re:/Fwd:"). If the
      // replier changed the subject so nothing matches, revert to the MOST
      // RECENT address-matching send. Either way, only claim it here when the
      // chosen send is a broadcast; a newsletter match falls through to the
      // newsletter branch below instead of being misfiled here.
      type SendRow = {
        id: string;
        broadcast_send_id: string | null;
        newsletter_send_id: string | null;
        from_address?: string | null;
        reply_to?: string | null;
        subject?: string | null;
      };
      const { data: recent } = await supabase
        .from('email_send_log')
        .select('id, broadcast_send_id, newsletter_send_id, from_address, reply_to, subject, sent_at')
        .eq('recipient_email', fromEmail)
        .or('broadcast_send_id.not.is.null,newsletter_send_id.not.is.null')
        .order('sent_at', { ascending: false, nullsFirst: false })
        .limit(30);
      const rows = (recent ?? []) as SendRow[];
      const addrMatch = (r: SendRow) => {
        const fa = (r.from_address || '').toLowerCase();
        const rt = (r.reply_to || '').toLowerCase();
        return toEmails.some((t) => fa.includes(t) || rt.includes(t));
      };
      // rows are already newest-first, so the first hit is the most recent.
      const replySubject = normSubject(subject);
      const bySubject = replySubject
        ? rows.find((r) => addrMatch(r) && normSubject(r.subject) === replySubject)
        : undefined;
      const chosen = bySubject ?? rows.find(addrMatch);
      if (chosen?.broadcast_send_id) {
        bLog = { id: chosen.id, broadcast_send_id: chosen.broadcast_send_id };
      }
    }

    {
      if (bLog?.broadcast_send_id) {
        const { data: bSend } = await supabase
          .from('broadcast_sends')
          .select('broadcast_id, category_list_id')
          .eq('id', bLog.broadcast_send_id)
          .maybeSingle();
        const broadcastId = bSend?.broadcast_id as string | undefined;

        if (broadcastId) {
          const { data: parent } = await supabase
            .from('broadcasts')
            .select('name, from_address, forward_replies_to')
            .eq('id', broadcastId)
            .maybeSingle();

          const { data: inserted, error: bInsErr } = await supabase
            .from('broadcast_replies')
            .insert({
              broadcast_id: broadcastId,
              broadcast_send_id: bLog.broadcast_send_id,
              from_email: fromEmail,
              from_name: fromName,
              subject,
              body_text: text || null,
              body_html: html || null,
              in_reply_to: inReplyTo,
              send_log_id: bLog.id,
              is_auto_reply: isAuto,
              auto_reply_reason: autoReason,
              forwarded_to: parent?.forward_replies_to || null,
            })
            .select('id')
            .single();
          if (bInsErr) console.error('Error storing broadcast reply:', bInsErr);

          // Job-change / departed sender → unsubscribe the now-dead address from
          // the list this broadcast was sent as part of.
          if (departedVerdict.departed) {
            await unsubscribeFromList(supabase, bSend?.category_list_id, fromEmail);
          }

          // Forward human replies to the configured mailbox (never auto-replies
          // or departure notices).
          let bForwarded = 0;
          if (parent?.forward_replies_to && isEmailConfigured() && !isAuto) {
            try {
              // Deliverability: forward as a clear "someone replied to your
              // broadcast" notification — NOT a spoofed reply. From = the
              // broadcast's authenticated sender (aaif.live is domain-authed) with
              // the BROADCAST name as the display, so there's no person/address
              // mismatch (the previous "Replier (via Broadcast)" over a different
              // person's address reads as phishing and lands in spam). The actual
              // replier goes in Reply-To + a header line; subject is prefixed.
              const fromMatch2 = (parent.from_address || '').match(/([^<>\s]+@[^<>\s]+)/);
              const fwdFrom = fromMatch2?.[1] || toEmails[0];
              const replier = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
              const bcastName = parent.name || 'your broadcast';
              const notice = `<p style="color:#555;font-size:13px;margin:0 0 12px">↩ Reply from <strong>${replier}</strong> to “${bcastName}”. Reply to this email to respond to them directly.</p><hr style="border:0;border-top:1px solid #e5e5e5;margin:0 0 14px">`;
              const bodyHtml = html || `<pre style="white-space:pre-wrap;font-family:sans-serif">${text}</pre>`;
              await sendEmail({
                to: parent.forward_replies_to,
                subject: `[Reply] ${subject || bcastName}`,
                html: notice + bodyHtml,
                text: `Reply from ${replier} to "${bcastName}":\n\n${text || ''}`,
                fromEmail: fwdFrom,
                fromName: `${bcastName} (replies)`,
                replyTo: fromEmail,
              });
              if (inserted) {
                await supabase.from('broadcast_replies')
                  .update({ forwarded_at: new Date().toISOString() })
                  .eq('id', inserted.id);
              }
              bForwarded = 1;
            } catch (fwdErr) {
              console.error('Error forwarding broadcast reply:', fwdErr);
            }
          }

          console.log(`Processed inbound broadcast reply: stored 1, forwarded ${bForwarded}`);
          return new Response(
            JSON.stringify({ success: true, handler: 'broadcast', stored: 1, forwarded: bForwarded }),
            { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
          );
        }
      }
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
      .select('id, name, from_email, reply_to, forward_replies_to, list_id')
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
          is_auto_reply: isAuto,
          auto_reply_reason: autoReason,
        });

      if (insertError) {
        console.error(`Error storing reply for ${collection.name}:`, insertError);
        continue;
      }

      // Job-change / departed sender → unsubscribe the now-dead address from
      // this newsletter's list.
      if (departedVerdict.departed) {
        await unsubscribeFromList(supabase, (collection as { list_id?: string | null }).list_id, fromEmail);
      }
      stored++;

      // Forward the reply if configured — never forward auto-replies (OOOs
      // and bounces would just clutter the human inbox the forward points at).
      if (collection.forward_replies_to && isEmailConfigured() && !isAuto) {
        try {
          // Deliverability: forward as a clear "someone replied" notification —
          // From = the newsletter's authenticated sender with the NEWSLETTER name
          // as the display (no person/address mismatch, which spam-filters flag
          // as spoofing); the actual replier goes in Reply-To + a header line;
          // subject is prefixed. (cf. the broadcast forward.)
          const replier = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
          const listName = collection.name || 'the newsletter';
          const notice = `<p style="color:#555;font-size:13px;margin:0 0 12px">↩ Reply from <strong>${replier}</strong> to “${listName}”. Reply to this email to respond to them directly.</p><hr style="border:0;border-top:1px solid #e5e5e5;margin:0 0 14px">`;
          const bodyHtml = html || `<pre style="white-space:pre-wrap;font-family:sans-serif">${text}</pre>`;

          await sendEmail({
            to: collection.forward_replies_to,
            subject: `[Reply] ${subject || listName}`,
            html: notice + bodyHtml,
            text: `Reply from ${replier} to "${listName}":\n\n${text || ''}`,
            fromEmail: collection.from_email,
            fromName: `${listName} (replies)`,
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
