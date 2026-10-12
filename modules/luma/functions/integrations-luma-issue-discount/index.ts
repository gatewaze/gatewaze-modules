import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Escape LIKE wildcards so an address containing _ or % matches only itself.
// ('*' is rejected before any lookup: PostgREST treats it as a wildcard.)
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // omit ambiguous chars (O, 0, I, 1)
  let suffix = ''
  for (let i = 0; i < 8; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return `TT-${suffix}`
}

async function handler(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ success: false, error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    // The caller must be signed in. Functions are deployed with verify_jwt
    // false, so verify the user's access token here. The code is only ever
    // issued to the token's own email, never to an email from the body.
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
    if (!token) {
      return new Response(JSON.stringify({ success: false, error: 'Sign in to claim a code' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user || !user.email || !user.email_confirmed_at) {
      return new Response(JSON.stringify({ success: false, error: 'Sign in to claim a code' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const body = await req.json().catch(() => ({}))
    const { email, discount_id, source } = body ?? {}

    const normalizedEmail = user.email.toLowerCase().trim()
    // '*' is a wildcard in PostgREST like/ilike values and cannot be escaped
    if (normalizedEmail.includes('*')) {
      return new Response(JSON.stringify({ success: false, error: 'Sign in to claim a code' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (email !== undefined && email !== null && email !== '') {
      if (typeof email !== 'string' || email.toLowerCase().trim() !== normalizedEmail) {
        return new Response(JSON.stringify({ success: false, error: 'Email does not match the signed-in account' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }
    if (!discount_id || typeof discount_id !== 'string' || !UUID_RE.test(discount_id)) {
      return new Response(JSON.stringify({ success: false, error: 'discount_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const codeSource = typeof source === 'string' && source.trim() !== ''
      ? source.trim().slice(0, 100)
      : null

    // Fetch the discount's Luma config. Whether it is open, the one-code-per-
    // person rule and max_codes are enforced atomically by
    // events_reserve_luma_code below.
    const { data: discount, error: discountError } = await supabase
      .from('events_discounts')
      .select('id, luma_event_api_id, luma_percent_off')
      .eq('id', discount_id)
      .maybeSingle()

    if (discountError || !discount) {
      return new Response(JSON.stringify({ success: false, error: 'Discount offer not found or inactive' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // The per-discount key lives off the public discount row. Fall back to the
    // platform-wide key when the discount has none.
    const { data: secret } = await supabase
      .from('events_discount_secrets')
      .select('luma_api_key')
      .eq('discount_id', discount.id)
      .maybeSingle()
    const lumaApiKey = secret?.luma_api_key || Deno.env.get('LUMA_API_KEY') || ''

    if (!discount.luma_event_api_id || !lumaApiKey) {
      return new Response(JSON.stringify({ success: false, error: 'This discount is not configured for dynamic code generation' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Hold a slot before minting. Parallel calls (one person or many) are
    // serialised per discount in the database, so a person never gets two
    // coupons and max_codes is never overshot.
    const { data: reservation, error: reserveError } = await supabase
      .rpc('events_reserve_luma_code', { p_discount_id: discount.id, p_email: normalizedEmail })
    const reserved = Array.isArray(reservation) ? reservation[0] : reservation

    if (reserveError || !reserved) {
      console.error('Error reserving discount code:', reserveError)
      return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    switch (reserved.status) {
      case 'existing':
        return new Response(JSON.stringify({ success: true, code: reserved.code, message: 'Code already issued' }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      case 'pending':
        return new Response(JSON.stringify({ success: false, error: 'Your code is being created, try again in a moment' }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      case 'sold_out':
        return new Response(JSON.stringify({ success: false, sold_out: true, error: 'Sold out' }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      case 'closed':
        return new Response(JSON.stringify({ success: false, error: 'This discount is closed' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      case 'reserved':
        break
      default:
        console.error('Unexpected reservation status:', reserved.status)
        return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
    }

    const reservedId: string = reserved.code_id

    // Release the held slot when minting does not complete.
    const releaseReservation = async () => {
      const { error: releaseError } = await supabase
        .from('events_discount_codes')
        .delete()
        .eq('id', reservedId)
      if (releaseError) console.error('Error releasing code reservation:', releaseError)
    }

    // Generate a unique code
    const code = generateCode()
    const percentOff = discount.luma_percent_off ?? 100

    // Create coupon in Luma
    let lumaResponse: Response
    try {
      lumaResponse = await fetch('https://public-api.luma.com/v1/event/create-coupon', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-luma-api-key': lumaApiKey,
        },
        body: JSON.stringify({
          event_api_id: discount.luma_event_api_id,
          code,
          discount: {
            discount_type: 'percent',
            percent_off: percentOff,
          },
          remaining_count: 1,
        }),
      })
    } catch (fetchError) {
      console.error('Luma API request failed:', fetchError)
      await releaseReservation()
      return new Response(JSON.stringify({ success: false, error: 'Failed to create coupon in Luma' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!lumaResponse.ok) {
      const lumaError = await lumaResponse.text()
      console.error('Luma API error:', lumaResponse.status, lumaError)
      await releaseReservation()
      return new Response(JSON.stringify({ success: false, error: 'Failed to create coupon in Luma' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const issuedAt = new Date().toISOString()

    // Replace the placeholder with the real code. The reservation already
    // carries event_id (the event uuid), discount_id and issued_to;
    // discount_type/discount_value stay null for minted Luma coupons.
    const codeUpdate: Record<string, unknown> = {
      code,
      issued: true,
      issued_at: issuedAt,
      is_active: true,
    }
    if (codeSource) codeUpdate.source = codeSource
    const { error: updateError } = await supabase
      .from('events_discount_codes')
      .update(codeUpdate)
      .eq('id', reservedId)

    if (updateError) {
      // The coupon exists in Luma, so still return it to the user rather than
      // leave them without a code.
      console.error('Code created in Luma but not stored in DB for discount', discount.id, updateError)
    }

    // Keep the claims record in step, as events_issue_code_to_user does. Never
    // step a claim backwards from deposit-initiated or deposit-paid.
    const { data: claimRows, error: claimLookupError } = await supabase
      .from('events_discount_claims')
      .select('id, status, accepted_at, code_issued_at')
      .eq('discount_id', discount.id)
      .ilike('email', escapeLike(normalizedEmail))
      .limit(1)
    if (claimLookupError) {
      console.error('Error looking up discount claim:', claimLookupError)
    } else if (claimRows && claimRows.length > 0) {
      const claim = claimRows[0]
      const { error: claimUpdateError } = await supabase
        .from('events_discount_claims')
        .update({
          status: ['viewed', 'accepted', 'sold-out'].includes(claim.status) ? 'code-issued' : claim.status,
          code_issued_at: claim.code_issued_at ?? issuedAt,
          accepted_at: claim.accepted_at ?? issuedAt,
        })
        .eq('id', claim.id)
      if (claimUpdateError) console.error('Error updating discount claim:', claimUpdateError)
    } else {
      const { error: claimInsertError } = await supabase
        .from('events_discount_claims')
        .insert({
          discount_id: discount.id,
          email: normalizedEmail,
          status: 'code-issued',
          accepted_at: issuedAt,
          code_issued_at: issuedAt,
        })
      if (claimInsertError) console.error('Error recording discount claim:', claimInsertError)
    }

    return new Response(JSON.stringify({ success: true, code, message: 'Code issued' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(JSON.stringify({ success: false, error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
}

export default handler;
Deno.serve(handler);
