import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.4'

/**
 * Newsletter signup (public, portal-facing).
 *
 * The portal calls this the same way it calls other backend mutations — via the Supabase functions
 * URL (`${supabaseUrl}/functions/v1/newsletter-signup`) with the anon key — because the portal
 * client only has the Supabase URL, not the separate API host.
 *
 * On submit it:
 *   1. Creates (or finds) the person + their auth record via the `people-signup` edge function.
 *   2. Subscribes the email to the newsletter's MANUALLY-linked list
 *      (`newsletters_template_collections.list_id`). If no list is linked, the person is still
 *      created but no subscription is made (never auto-creates a list).
 *
 * Interim — to be replaced by the onboarding module.
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { email: rawEmail, collection } = await req.json().catch(() => ({}))
    const email = String(rawEmail || '').toLowerCase().trim()
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return json({ error: 'A valid email is required' }, 400)
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

    // 1. Create or find the person + auth record (mirrors the forms-module submit path).
    let personId: string | null = null
    try {
      const signupRes = await fetch(`${SUPABASE_URL}/functions/v1/people-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
        body: JSON.stringify({ email, source: 'newsletter-signup' }),
      })
      const signupData = await signupRes.json().catch(() => ({}))
      personId = signupData?.person_id ?? null
    } catch (_e) {
      // fall through — we'll still try to subscribe by email
    }
    if (!personId) {
      const { data } = await supabase.from('people').select('id').eq('email', email).maybeSingle()
      personId = data?.id ?? null
    }

    // 2. Subscribe to the newsletter's manually-linked list, if one is linked.
    if (collection) {
      const { data: col } = await supabase
        .from('newsletters_template_collections')
        .select('list_id')
        .eq('slug', String(collection))
        .maybeSingle()
      const listId = col?.list_id ?? null
      if (listId) {
        await supabase.from('list_subscriptions').upsert(
          {
            list_id: listId,
            person_id: personId,
            email,
            subscribed: true,
            subscribed_at: new Date().toISOString(),
            unsubscribed_at: null,
            source: 'newsletter-signup',
          },
          { onConflict: 'list_id,email' },
        )
      }
    }

    return json({ success: true }, 200)
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Signup failed' }, 500)
  }
}

Deno.serve(handler)
