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

    // Fetch the discount offer config
    const { data: discount, error: discountError } = await supabase
      .from('events_discounts')
      .select('id, event_id, luma_event_api_id, luma_percent_off, max_codes, status')
      .eq('id', discount_id)
      .eq('status', 'active')
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

    // Check if user already has a code for this discount (idempotent)
    const { data: existingCodes } = await supabase
      .from('events_discount_codes')
      .select('code')
      .eq('discount_id', discount.id)
      .ilike('issued_to', escapeLike(normalizedEmail))
      .eq('issued', true)
      .order('issued_at', { ascending: true })
      .limit(1)
    const existingCode = existingCodes?.[0]

    if (existingCode) {
      return new Response(JSON.stringify({ success: true, code: existingCode.code, message: 'Code already issued' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Enforce max_codes limit if set
    if (discount.max_codes !== null && discount.max_codes !== undefined) {
      const { count } = await supabase
        .from('events_discount_codes')
        .select('*', { count: 'exact', head: true })
        .eq('discount_id', discount.id)
        .eq('issued', true)

      if ((count ?? 0) >= discount.max_codes) {
        return new Response(JSON.stringify({ success: false, error: 'All codes have been claimed', sold_out: true }), {
          status: 409,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }
    }

    // Generate a unique code
    const code = generateCode()
    const percentOff = discount.luma_percent_off ?? 100

    // Create coupon in Luma
    const lumaResponse = await fetch('https://public-api.luma.com/v1/event/create-coupon', {
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

    if (!lumaResponse.ok) {
      const lumaError = await lumaResponse.text()
      console.error('Luma API error:', lumaResponse.status, lumaError)
      return new Response(JSON.stringify({ success: false, error: 'Failed to create coupon in Luma' }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const issuedAt = new Date().toISOString()

    // Store the issued code. event_id is the event uuid from the discount row
    // (null for a discount with no event). discount_type/discount_value stay
    // null: minted Luma coupons never carried them.
    const { error: insertError } = await supabase
      .from('events_discount_codes')
      .insert({
        event_id: discount.event_id ?? null,
        discount_id: discount.id,
        code,
        issued: true,
        issued_to: normalizedEmail,
        issued_at: issuedAt,
        source: codeSource,
      })

    if (insertError) {
      console.error('Error storing discount code:', insertError)
      // Code was created in Luma but we failed to store it — still return it to the user
      // so they're not left without a code
      console.error('Code created in Luma but not stored in DB for discount', discount.id)
    }

    // Keep the claims record in step, as events_issue_code_to_user does for
    // pool discounts.
    const { data: claimRows, error: claimLookupError } = await supabase
      .from('events_discount_claims')
      .select('id, accepted_at')
      .eq('discount_id', discount.id)
      .ilike('email', escapeLike(normalizedEmail))
      .limit(1)
    if (claimLookupError) {
      console.error('Error looking up discount claim:', claimLookupError)
    } else if (claimRows && claimRows.length > 0) {
      const { error: claimUpdateError } = await supabase
        .from('events_discount_claims')
        .update({
          status: 'code-issued',
          code_issued_at: issuedAt,
          accepted_at: claimRows[0].accepted_at ?? issuedAt,
        })
        .eq('id', claimRows[0].id)
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
