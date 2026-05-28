import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const SENDGRID_API_URL = 'https://api.sendgrid.com/v3/mail/send'

function resolveFromEmail(fromAddress: string | null, fallback: string): string {
  return fromAddress || fallback || 'hello@example.com'
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const sendgridKey = Deno.env.get('SENDGRID_API_KEY')
    if (!sendgridKey) throw new Error('SENDGRID_API_KEY not configured')

    const defaultFrom = Deno.env.get('MATCH_EMAIL_FROM_ADDRESS') ?? 'hello@example.com'

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { event_id, match_ids, test_mode } = await req.json()
    if (!event_id) {
      return new Response(JSON.stringify({ error: 'event_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Fetch event info
    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('event_title, event_start, event_link')
      .eq('event_id', event_id)
      .single()

    if (eventError || !event) throw eventError ?? new Error('Event not found')

    // Fetch email config — try module-specific table first
    const { data: emailSettings } = await supabase
      .from('events_match_email_settings')
      .select('from_address, from_key, reply_to, template_id, subject, content')
      .eq('event_id', event_id)
      .single()

    let customSubject: string | null = emailSettings?.subject ?? null
    let customHtml: string | null = emailSettings?.content ?? null

    // Fall back to template if no direct override
    if ((!customSubject || !customHtml) && emailSettings?.template_id) {
      const { data: template } = await supabase
        .from('email_templates')
        .select('subject, html_body')
        .eq('id', emailSettings.template_id)
        .single()

      if (template) {
        customSubject = customSubject ?? template.subject
        customHtml = customHtml ?? template.html_body
      }
    }

    // Fetch matches
    let matchQuery = supabase
      .from('events_attendee_matches')
      .select('id, registration_a_id, registration_b_id, match_reason, preceding_word_a, preceding_word_b')
      .eq('event_id', event_id)

    if (test_mode) {
      if (match_ids && match_ids.length > 0) {
        matchQuery = matchQuery.in('id', match_ids).limit(1)
      } else {
        matchQuery = matchQuery.limit(1)
      }
    } else {
      matchQuery = matchQuery.is('intro_email_sent_at', null)
      if (match_ids && match_ids.length > 0) {
        matchQuery = matchQuery.in('id', match_ids)
      }
    }

    const { data: matches, error: matchError } = await matchQuery
    if (matchError) throw matchError

    if (!matches || matches.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: test_mode ? 'No matches found to use as test sample' : 'No matches pending email send',
        emails_sent: 0,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Look up registrant details
    const allRegIds = matches.flatMap((m: any) => [m.registration_a_id, m.registration_b_id])

    const { data: registrations, error: regError } = await supabase
      .from('events_registrations_matching_view')
      .select('id, full_name, email, job_title, company')
      .in('id', allRegIds)

    if (regError) throw regError

    const regMap = new Map<string, any>()
    for (const r of registrations ?? []) {
      regMap.set(r.id, r)
    }

    const fromEmail = resolveFromEmail(emailSettings?.from_address ?? null, defaultFrom)
    const replyTo = emailSettings?.reply_to ?? null

    const eventWeekday = event.event_start
      ? new Date(event.event_start).toLocaleDateString('en-US', { weekday: 'long' })
      : 'the event day'

    let emailsSent = 0
    const errors: string[] = []

    for (const match of matches) {
      const personA = regMap.get(match.registration_a_id)
      const personB = regMap.get(match.registration_b_id)

      if (!personA || !personB) {
        errors.push(`Match ${match.id}: missing registrant data`)
        continue
      }

      const aFirstName = personA.full_name?.split(' ')[0] ?? personA.email
      const bFirstName = personB.full_name?.split(' ')[0] ?? personB.email
      const aJobTitle = personA.job_title ?? ''
      const aCompany = personA.company ?? ''
      const bJobTitle = personB.job_title ?? ''
      const bCompany = personB.company ?? ''
      const precedingWordA = match.preceding_word_a ?? 'a'
      const precedingWordB = match.preceding_word_b ?? 'a'

      const aDesc = [aJobTitle, aCompany ? `at ${aCompany}` : ''].filter(Boolean).join(' ')
      const bDesc = [bJobTitle, bCompany ? `at ${bCompany}` : ''].filter(Boolean).join(' ')

      const eventLinkHref = event.event_link ?? ''
      const eventLinkHtml = eventLinkHref
        ? `<a href="${eventLinkHref}" style="color: #6d28d9;">${event.event_title}</a>`
        : event.event_title

      const templateVars: Record<string, string> = {
        event_title: event.event_title,
        event_weekday: eventWeekday,
        event_link: eventLinkHref,
        person_a_first_name: aFirstName,
        person_a_job_title: aJobTitle,
        person_a_company: aCompany,
        preceding_word_a: precedingWordA,
        person_b_first_name: bFirstName,
        person_b_job_title: bJobTitle,
        person_b_company: bCompany,
        preceding_word_b: precedingWordB,
        match_reason: match.match_reason ?? '',
      }

      const subject = customSubject
        ? customSubject.replace(/\{\{(\w+)\}\}/g, (_, k) => templateVars[k] ?? '')
        : `${aFirstName}, meet ${bFirstName} — your intro for ${event.event_title}`

      const html = customHtml
        ? customHtml.replace(/\{\{(\w+)\}\}/g, (_, k) => templateVars[k] ?? '')
        : `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.6;">
  <p>Hey ${aFirstName} and ${bFirstName},</p>
  <p>I want to introduce you both so you know at least one person on ${eventWeekday} at the ${eventLinkHtml}. I know going to an event can be intimidating sometimes so hopefully this helps.</p>
  <p>${aFirstName} is ${precedingWordA} ${aDesc} and ${bFirstName} is ${precedingWordB} ${bDesc}.</p>
  <p>I'll let you all take it from here. Keep me posted how it goes.</p>
</body>
</html>`

      const text = `Hey ${aFirstName} and ${bFirstName},

I want to introduce you both so you know at least one person on ${eventWeekday} at the ${event.event_title}${eventLinkHref ? ` (${eventLinkHref})` : ''}. I know going to an event can be intimidating sometimes so hopefully this helps.

${aFirstName} is ${precedingWordA} ${aDesc} and ${bFirstName} is ${precedingWordB} ${bDesc}.

I'll let you all take it from here. Keep me posted how it goes.`

      const toA = test_mode ? { email: test_mode.email_a } : { email: personA.email, name: personA.full_name ?? undefined }
      const toB = test_mode ? { email: test_mode.email_b } : { email: personB.email, name: personB.full_name ?? undefined }

      const sendGridPayload = {
        personalizations: [{ to: [toA, toB] }],
        from: { email: fromEmail },
        subject,
        content: [
          { type: 'text/plain', value: text },
          { type: 'text/html', value: html },
        ],
        ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      }

      const sgResponse = await fetch(SENDGRID_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sendgridKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sendGridPayload),
      })

      if (!sgResponse.ok) {
        const errText = await sgResponse.text()
        errors.push(`Match ${match.id}: SendGrid error ${sgResponse.status} — ${errText}`)
        continue
      }

      if (!test_mode) {
        await supabase
          .from('events_attendee_matches')
          .update({ intro_email_sent_at: new Date().toISOString() })
          .eq('id', match.id)
      }

      emailsSent++
    }

    return new Response(JSON.stringify({
      success: true,
      emails_sent: emailsSent,
      errors: errors.length > 0 ? errors : undefined,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (error: any) {
    console.error('Error sending match emails:', error)
    return new Response(JSON.stringify({ error: error.message ?? 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
