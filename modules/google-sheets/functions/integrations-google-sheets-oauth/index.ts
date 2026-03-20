/**
 * Google Sheets OAuth Edge Function
 * Handles OAuth authorization flow for Google Sheets integration
 *
 * Endpoints:
 * - GET /authorize: Redirect to Google OAuth consent screen
 * - GET /callback: Handle OAuth callback and store tokens
 * - POST /disconnect: Remove OAuth tokens for an event
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

// Google OAuth configuration
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_SHEETS_CLIENT_ID")!;
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_SHEETS_CLIENT_SECRET")!;

// Scopes needed for Google Sheets
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const path = url.pathname.split("/").pop();

  try {
    // Route based on path
    switch (path) {
      case "authorize":
        return handleAuthorize(req, url);
      case "callback":
        return handleCallback(req, url);
      case "disconnect":
        return handleDisconnect(req);
      default:
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (error) {
    console.error("Google Sheets OAuth error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});

/**
 * Build the redirect URI using custom domain from environment
 * PUBLIC_SUPABASE_URL should be set to the custom domain (e.g., https://db.mlops.community)
 * Falls back to SUPABASE_URL if not set
 */
function buildRedirectUri(): string {
  const baseUrl = Deno.env.get("PUBLIC_SUPABASE_URL") || Deno.env.get("SUPABASE_URL")!;
  return `${baseUrl}/functions/v1/google-sheets-oauth/callback`;
}

/**
 * Handle OAuth authorization request
 * Redirects to Google OAuth consent screen
 */
function handleAuthorize(req: Request, url: URL): Response {
  const eventId = url.searchParams.get("event_id");
  const notificationType = url.searchParams.get("notification_type");
  const returnUrl = url.searchParams.get("return_url");

  if (!eventId || !notificationType) {
    return new Response(
      JSON.stringify({ error: "Missing event_id or notification_type" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Build redirect URI dynamically from the request
  const redirectUri = buildRedirectUri();

  // Create state parameter with event info (will be returned in callback)
  // Include the redirect URI so callback can use the same one
  const state = btoa(
    JSON.stringify({
      eventId,
      notificationType,
      returnUrl: returnUrl || "/",
      redirectUri,
    })
  );

  // Build Google OAuth URL
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent"); // Force consent to get refresh token
  authUrl.searchParams.set("state", state);

  return Response.redirect(authUrl.toString(), 302);
}

/**
 * Handle OAuth callback from Google
 * Exchanges code for tokens and stores them
 */
async function handleCallback(req: Request, url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    console.error("OAuth error from Google:", error);
    return createErrorRedirect("Google denied access: " + error);
  }

  if (!code || !stateParam) {
    return createErrorRedirect("Missing authorization code or state");
  }

  // Decode state
  let state: { eventId: string; notificationType: string; returnUrl: string; redirectUri: string };
  try {
    state = JSON.parse(atob(stateParam));
  } catch {
    return createErrorRedirect("Invalid state parameter");
  }

  // Use the redirect URI from state (same one used in authorize)
  // Fall back to building it from current URL if not in state (backwards compatibility)
  const redirectUri = state.redirectUri || buildRedirectUri();

  // Exchange code for tokens
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    console.error("Token exchange failed:", errorData);
    return createErrorRedirect("Failed to exchange authorization code");
  }

  const tokens = await tokenResponse.json();
  const { access_token, refresh_token, expires_in } = tokens;

  if (!access_token) {
    return createErrorRedirect("No access token received");
  }

  // Get user email from Google
  const userInfoResponse = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: { Authorization: `Bearer ${access_token}` },
    }
  );

  let userEmail = null;
  if (userInfoResponse.ok) {
    const userInfo = await userInfoResponse.json();
    userEmail = userInfo.email;
  }

  // Calculate token expiry
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  // Store tokens in database
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const { error: upsertError } = await supabase
    .from("event_google_sheets_notifications")
    .upsert(
      {
        event_id: state.eventId,
        notification_type: state.notificationType,
        google_access_token: access_token,
        google_refresh_token: refresh_token,
        google_token_expires_at: expiresAt,
        google_user_email: userEmail,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "event_id,notification_type" }
    );

  if (upsertError) {
    console.error("Failed to store tokens:", upsertError);
    return createErrorRedirect("Failed to save authorization");
  }

  // Redirect back to the app with success
  const returnUrl = new URL(state.returnUrl, Deno.env.get("SITE_URL") || "http://localhost:3000");
  returnUrl.searchParams.set("google_sheets_connected", "true");
  returnUrl.searchParams.set("notification_type", state.notificationType);

  return Response.redirect(returnUrl.toString(), 302);
}

/**
 * Handle disconnect request
 * Removes OAuth tokens for an event/notification type
 */
async function handleDisconnect(req: Request): Promise<Response> {
  // Verify authorization
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  // Get request body
  const { eventId, notificationType } = await req.json();

  if (!eventId || !notificationType) {
    return new Response(
      JSON.stringify({ error: "Missing eventId or notificationType" }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }

  // Clear OAuth tokens
  const { error } = await supabase
    .from("event_google_sheets_notifications")
    .update({
      google_access_token: null,
      google_refresh_token: null,
      google_token_expires_at: null,
      google_user_email: null,
      enabled: false,
      updated_at: new Date().toISOString(),
    })
    .eq("event_id", eventId)
    .eq("notification_type", notificationType);

  if (error) {
    console.error("Failed to disconnect:", error);
    return new Response(JSON.stringify({ error: "Failed to disconnect" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Create an error redirect response
 */
function createErrorRedirect(errorMessage: string): Response {
  const returnUrl = new URL(Deno.env.get("SITE_URL") || "http://localhost:3000");
  returnUrl.searchParams.set("google_sheets_error", errorMessage);
  return Response.redirect(returnUrl.toString(), 302);
}
