/**
 * Caller check for the conversion edge functions.
 *
 * Every function in this module is reached only by trusted callers: the
 * send_conversion_on_registration trigger (pg_net) posts to the dispatcher
 * with the service-role key, and the dispatcher calls each platform sender
 * the same way. Nothing in a browser needs them. Because the platform deploys
 * edge functions with verify_jwt off, the functions check the bearer token
 * themselves against the service-role key so an unauthenticated request
 * cannot replay conversions for arbitrary registration ids.
 */

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  if (ab.length !== bb.length) return false
  let diff = 0
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i]
  return diff === 0
}

/** The keys a trusted caller may present. Both env names are honoured because
 * Supabase auto-populates SUPABASE_SERVICE_ROLE_KEY and some projects carry the
 * JWT-form key separately as SERVICE_ROLE_JWT_KEY. */
export function trustedKeys(): string[] {
  return [Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), Deno.env.get('SERVICE_ROLE_JWT_KEY')]
    .filter((k): k is string => typeof k === 'string' && k.length > 0)
}

/** True when the request carries `Authorization: Bearer <service-role key>`. */
export function isTrustedCaller(req: Request): boolean {
  const header = req.headers.get('authorization') || ''
  const match = header.match(/^Bearer\s+(.+)$/i)
  if (!match) return false
  const presented = match[1].trim()
  return trustedKeys().some((k) => constantTimeEqual(k, presented))
}

/** Standard 401 for the functions in this module. */
export function unauthorizedResponse(corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
    status: 401,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
