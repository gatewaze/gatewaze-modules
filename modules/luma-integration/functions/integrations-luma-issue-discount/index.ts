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

function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // omit ambiguous chars (O, 0, I, 1)
  let suffix = ''
  for (let i = 0; i < 8; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)]
  }
  return `TT-${suffix}`
}

export default async function(req: Request) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  try {
    const body = await req.json()
    const { email, discount_id } = body

    // Validate input
    if (!email || typeof email !== 'string') {
      return new Response(JSON.stringify({ error: 'email is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    if (!discount_id || typeof discount_id !== 'string') {
      return new Response(JSON.stringify({ error: 'discount_id is required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const normalizedEmail = email.toLowerCase().trim()

    // Fetch the discount offer config
    const { data: discount, error: discountError } = await supabase
      .from('events_discounts')
      .select('id, event_id, luma_event_api_id, luma_api_key, luma_percent_off, max_codes, status')
      .eq('id', discount_id)
      .eq('status', 'active')
      .maybeSingle()

    if (discountError || !discount) {
      return new Response(JSON.stringify({ error: 'Discount offer not found or inactive' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (!discount.luma_event_api_id || !discount.luma_api_key) {
      return new Response(JSON.stringify({ error: 'This discount is not configured for dynamic code generation' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Check if user already has a code for this discount (idempotent)
    const { data: existingCode } = await supabase
      .from('events_discount_codes')
      .select('code')
      .eq('discount_id', discount.id)
      .eq('issued_to', normalizedEmail)
      .eq('issued', true)
      .maybeSingle()

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
        return new Response(JSON.stringify({ error: 'All codes have been claimed', sold_out: true }), {
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
        'x-luma-api-key': discount.luma_api_key,
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
      return new Response(JSON.stringify({ error: 'Failed to create coupon in Luma', details: lumaError }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Store the issued code in discount_codes
    const { error: insertError } = await supabase
      .from('events_discount_codes')
      .insert({
        event_id: discount.event_id,
        discount_id: discount.id,
        code,
        issued: true,
        issued_to: normalizedEmail,
        issued_at: new Date().toISOString(),
      })

    if (insertError) {
      console.error('Error storing discount code:', insertError)
      // Code was created in Luma but we failed to store it — still return it to the user
      // so they're not left without a code
      console.error('Code created in Luma but not stored in DB:', code, normalizedEmail)
    }

    return new Response(JSON.stringify({ success: true, code, message: 'Code issued' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
}
