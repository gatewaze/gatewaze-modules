/**
 * Request checks shared by the google-sheets edge functions
 * (integrations-google-sheets-oauth and integrations-google-sheets-notify).
 *
 * Both are deployed with verify_jwt off, so the gateway lets every request
 * through and each route must decide for itself who the caller is.
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

/** The admin origin. The OAuth callback's relative return paths resolve here. */
export function siteUrl(): string {
  return Deno.env.get("SITE_URL") || "http://localhost:3000";
}

/** Admin origins accepted besides SITE_URL's. */
export function allowedAdminOrigins(): string[] {
  const admin = Deno.env.get("ADMIN_BASE_URL");
  return admin ? [admin] : [];
}

const baseCorsHeaders: Record<string, string> = {
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Vary": "Origin",
};

/**
 * CORS headers that allow only the admin origins (SITE_URL, ADMIN_BASE_URL).
 *
 * This narrows CORS only where the function's own headers reach the browser,
 * which is Supabase Cloud. On self-hosted installs Kong and the edge-runtime
 * main router answer preflights with "*" before the function runs. Either
 * way the routes stay safe without CORS: they need a bearer token, which a
 * browser never attaches on its own. In host-session mode the admin calls
 * through its own origin and CORS does not apply.
 */
export function corsFor(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowed = [siteUrl(), ...allowedAdminOrigins()].map((u) => {
    try {
      return new URL(u).origin;
    } catch {
      return null;
    }
  });
  return origin && allowed.includes(origin)
    ? { ...baseCorsHeaders, "Access-Control-Allow-Origin": origin }
    : baseCorsHeaders;
}

export function jsonResponse(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsFor(req), "Content-Type": "application/json" },
  });
}

/** The bearer token from the Authorization header, or "". */
export function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

const encoder = new TextEncoder();

/**
 * Compares two secrets in constant time. Both are hashed first, so neither
 * where they differ nor how long they are shows in the timing.
 */
export async function secretsEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(ha);
  const y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * True when the bearer token is this project's service-role key: a trusted
 * server-side caller. False when either is missing.
 */
export async function isServiceRoleRequest(req: Request): Promise<boolean> {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = bearerToken(req);
  if (!serviceKey || !token) return false;
  return await secretsEqual(token, serviceKey);
}

/**
 * Checks the bearer token and that its user can admin the event, using the
 * same rule as editing the event itself (public.can_admin_event_by_eid, which
 * the events module defines). Returns the user id, or a response to send.
 */
export async function requireEventAdmin(
  req: Request,
  eventId: string,
): Promise<{ userId: string } | { response: Response }> {
  const jwt = bearerToken(req);
  if (!jwt) return { response: jsonResponse(req, { error: "Unauthorized" }, 401) };

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    console.error("google-sheets: SUPABASE_URL or SUPABASE_ANON_KEY is not set");
    return { response: jsonResponse(req, { error: "Server not configured" }, 503) };
  }

  // A client acting as the caller, so auth.uid() inside the RPC is theirs.
  const asCaller = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userError } = await asCaller.auth.getUser(jwt);
  const user = userData?.user;
  if (userError || !user) return { response: jsonResponse(req, { error: "Unauthorized" }, 401) };

  const { data: allowed, error: rpcError } = await asCaller.rpc("can_admin_event_by_eid", {
    p_event_id: eventId,
  });
  if (rpcError) {
    console.error("google-sheets: event permission check failed:", rpcError.message);
    return { response: jsonResponse(req, { error: "Forbidden" }, 403) };
  }
  // null (unknown event) and false both refuse.
  if (allowed !== true) return { response: jsonResponse(req, { error: "Forbidden" }, 403) };

  return { userId: user.id };
}
