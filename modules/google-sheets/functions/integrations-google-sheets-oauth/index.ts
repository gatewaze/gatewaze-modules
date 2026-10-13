/**
 * Google Sheets OAuth Edge Function
 * Handles OAuth authorization flow for Google Sheets integration
 *
 * Endpoints:
 * - POST /authorize: for an event admin, returns the Google consent URL
 *   carrying a signed, short-lived state ({ authorize_url })
 * - GET /callback: Google's redirect; verifies the state, stores the tokens
 * - POST /disconnect: for an event admin, removes the tokens for an event
 *
 * /callback is the only route without a bearer token, because Google sends a
 * browser to it. The signed state is its authorisation: only /authorize, after
 * checking the caller can admin the event, can mint one. See oauth-state.ts.
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  checkState,
  isNotificationType,
  safeReturnTarget,
  signState,
  STATE_TTL_MS,
} from "./oauth-state.ts";
import {
  allowedAdminOrigins,
  corsFor,
  jsonResponse,
  requireEventAdmin,
  siteUrl,
} from "../_shared/google-sheets-auth.ts";

// Google OAuth configuration. Read per request; a missing value fails closed
// where it is used.
function googleClientId(): string {
  return Deno.env.get("GOOGLE_SHEETS_CLIENT_ID") ?? "";
}
function googleClientSecret(): string {
  return Deno.env.get("GOOGLE_SHEETS_CLIENT_SECRET") ?? "";
}

/** The deployed function slug: the directory name, which is what the router serves. */
const FUNCTION_SLUG = "integrations-google-sheets-oauth";

// Scopes needed for Google Sheets
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsFor(req) });
  }

  const url = new URL(req.url);
  const path = url.pathname.split("/").pop();

  try {
    // Route based on path
    switch (path) {
      case "authorize":
        return await handleAuthorize(req);
      case "callback":
        return await handleCallback(url);
      case "disconnect":
        return await handleDisconnect(req);
      default:
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { ...corsFor(req), "Content-Type": "application/json" },
        });
    }
  } catch (error) {
    // Logged in full, returned generic: internal messages stay server-side.
    console.error("Google Sheets OAuth error:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsFor(req), "Content-Type": "application/json" },
    });
  }
});

/**
 * Build the redirect URI using custom domain from environment
 * PUBLIC_SUPABASE_URL should be set to the custom domain (e.g., https://db.example.com)
 * Falls back to SUPABASE_URL if not set. This exact URL must be registered as
 * an authorised redirect URI on the Google OAuth client.
 */
function buildRedirectUri(): string {
  const baseUrl = Deno.env.get("PUBLIC_SUPABASE_URL") || Deno.env.get("SUPABASE_URL") || "";
  return `${baseUrl}/functions/v1/${FUNCTION_SLUG}/callback`;
}

/** A service-role client, or null when the environment is incomplete. */
function serviceClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    console.error("Google Sheets OAuth: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
    return null;
  }
  return createClient(supabaseUrl, serviceKey);
}

/** A database error's code and message only: details can echo the row, tokens included. */
function dbErrorSummary(err: { code?: string; message?: string } | null): string {
  return `${err?.code ?? "unknown"}: ${err?.message ?? ""}`;
}

/**
 * Handle OAuth authorization request.
 * POST { eventId, notificationType, returnUrl } with the admin's bearer token.
 * Returns { authorize_url } for the browser to navigate to. It is a POST and
 * not a redirect because a top-level navigation cannot carry the bearer token
 * that proves who is connecting the account.
 */
async function handleAuthorize(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method not allowed. POST with a bearer token." }, 405);
  }

  // Fail closed: without the client secret there is nothing to sign with,
  // and the code exchange in the callback could not succeed anyway.
  const clientId = googleClientId();
  const clientSecret = googleClientSecret();
  if (!clientId || !clientSecret) {
    console.error("Google Sheets OAuth: GOOGLE_SHEETS_CLIENT_ID or GOOGLE_SHEETS_CLIENT_SECRET is not set");
    return jsonResponse(req, { error: "Google Sheets OAuth is not configured" }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: "Invalid JSON body" }, 400);
  }
  const eventId = typeof body?.eventId === "string" ? body.eventId : "";
  const notificationType = body?.notificationType;
  if (!eventId || eventId.length > 64 || !isNotificationType(notificationType)) {
    return jsonResponse(req, { error: "Missing or invalid eventId or notificationType" }, 400);
  }

  const auth = await requireEventAdmin(req, eventId);
  if ("response" in auth) return auth.response;

  const state = await signState(
    {
      e: eventId,
      t: notificationType,
      r: safeReturnTarget(body.returnUrl, siteUrl(), allowedAdminOrigins()),
      u: auth.userId,
    },
    clientSecret,
  );

  // Build Google OAuth URL
  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", buildRedirectUri());
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", GOOGLE_SCOPES);
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "consent"); // Force consent to get refresh token
  authUrl.searchParams.set("state", state);

  return jsonResponse(req, {
    authorize_url: authUrl.toString(),
    expires_in_seconds: STATE_TTL_MS / 1000,
  });
}

/**
 * Handle OAuth callback from Google
 * Exchanges code for tokens and stores them
 *
 * A top-level navigation, so every outcome is a redirect back to the admin,
 * including an unexpected throw.
 */
async function handleCallback(url: URL): Promise<Response> {
  try {
    return await completeCallback(url);
  } catch (err) {
    console.error("Google Sheets OAuth callback failed:", err instanceof Error ? err.message : String(err));
    return createErrorRedirect("Could not complete the Google connection. Please try again.");
  }
}

async function completeCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  if (error) {
    // The raw value is attacker-controllable: logged on one line, truncated,
    // and never reflected into the redirect.
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    console.error("OAuth error from Google:", error.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").slice(0, 200));
    return createErrorRedirect("Google denied access");
  }

  if (!code || !stateParam) {
    return createErrorRedirect("Missing authorization code or state");
  }

  // Only a state this function signed in the last STATE_TTL_MS is accepted.
  // That rules out forged states and the unsigned ones issued before signing
  // existed; a flow started before the upgrade has to be started again.
  //
  // Residual risks, accepted for now (the fix is binding the state to the
  // browser that started the flow, which is deferred):
  //  - The state is not single-use and not tied to a browser. Someone who
  //    obtains a fresh state issued to an event admin, within its 10 minutes,
  //    could pair it with their own Google authorization code and attach their
  //    Google account to that admin's event.
  //  - The reverse: any event admin can mint a valid state for their own event
  //    and send the resulting Google consent link to someone else. If that
  //    person consents, their Google refresh token, with the spreadsheets
  //    scope, is stored on the admin's event, and the admin can then point the
  //    sync at that person's spreadsheets.
  // Nobody can mint a state for an event they do not admin. Each connection
  // logs the initiating admin, the event and the Google account, below.
  const checked = await checkState(stateParam, googleClientSecret());
  if (!("state" in checked)) {
    console.warn(`[google-sheets-oauth] refused callback state: ${checked.rejected}`);
    return createErrorRedirect("This connection link is invalid or has expired. Please connect again.");
  }
  const state = checked.state;

  const supabase = serviceClient();
  if (!supabase) return createErrorRedirect("Google Sheets OAuth is not configured");

  // Always the server's own callback URL, never one taken from the request.
  const redirectUri = buildRedirectUri();

  // Exchange code for tokens
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!tokenResponse.ok) {
    const errorData = await tokenResponse.text();
    console.error("Token exchange failed:", tokenResponse.status, errorData.slice(0, 500));
    return createErrorRedirect("Failed to exchange authorization code");
  }

  // Checked at runtime: the response is external input.
  const tokens = await tokenResponse.json();
  const access_token = tokens?.access_token;
  const refresh_token = tokens?.refresh_token;
  if (typeof access_token !== "string" || access_token === "") {
    console.error("Token exchange returned no usable access_token");
    return createErrorRedirect("No access token received");
  }
  if (refresh_token !== undefined && refresh_token !== null && typeof refresh_token !== "string") {
    console.error("Token exchange returned a refresh_token that is not a string");
    return createErrorRedirect("Failed to exchange authorization code");
  }
  // Google always sends expires_in; default it so a missing value cannot
  // produce an invalid date and throw.
  const expires_in =
    typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
      ? tokens.expires_in
      : 3600;

  // Get user email from Google
  const userInfoResponse = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: { Authorization: `Bearer ${access_token}` },
    }
  );

  let userEmail: string | null = null;
  if (userInfoResponse.ok) {
    const userInfo = await userInfoResponse.json();
    if (typeof userInfo?.email === "string") {
      userEmail = userInfo.email;
    } else if (userInfo?.email !== undefined && userInfo?.email !== null) {
      console.error("Google userinfo returned an email that is not a string");
    }
  } else {
    console.error("Google userinfo request failed:", userInfoResponse.status);
  }

  // Without a new refresh token the stored one is kept, but only when it
  // belongs to the same Google account: otherwise the row would pair this
  // account's access token and email with someone else's refresh token.
  if (typeof refresh_token !== "string") {
    const { data: stored, error: readError } = await supabase
      .from("event_google_sheets_notifications")
      .select("google_user_email, google_connected")
      .eq("event_id", state.e)
      .eq("notification_type", state.t)
      .maybeSingle();
    const sameAccount =
      !readError &&
      stored?.google_connected === true &&
      userEmail !== null &&
      stored.google_user_email === userEmail;
    if (!sameAccount) {
      console.error(
        `[google-sheets-oauth] no refresh token from Google and no stored one for the same account; ` +
          `not saving event=${state.e} type=${state.t}`,
      );
      return createErrorRedirect("Google didn't return a refresh token; disconnect and connect again");
    }
  }

  // Calculate token expiry
  const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

  // Store tokens in database
  const { error: upsertError } = await supabase
    .from("event_google_sheets_notifications")
    .upsert(
      {
        event_id: state.e,
        notification_type: state.t,
        google_access_token: access_token,
        // Absent means "keep the stored one" (checked above to be the same
        // account): undefined is left out of the upsert.
        google_refresh_token: typeof refresh_token === "string" ? refresh_token : undefined,
        google_token_expires_at: expiresAt,
        google_user_email: userEmail,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "event_id,notification_type" }
    );

  if (upsertError) {
    console.error("Failed to store tokens:", dbErrorSummary(upsertError));
    return createErrorRedirect("Failed to save authorization");
  }

  // Audit trail: who started this connection, for which event, as which
  // Google account. Never the tokens.
  console.log(
    `[google-sheets-oauth] connected event=${state.e} type=${state.t} ` +
      `initiated_by=${state.u} google_account=${userEmail ?? "unknown"}`,
  );

  // Redirect back to the app with success. The target was checked when the
  // state was signed; it is checked again here so the redirect never rests
  // on the signature alone.
  const returnUrl = new URL(
    safeReturnTarget(state.r, siteUrl(), allowedAdminOrigins()),
    siteUrl(),
  );
  returnUrl.searchParams.set("google_sheets_connected", "true");
  returnUrl.searchParams.set("notification_type", state.t);

  return Response.redirect(returnUrl.toString(), 302);
}

/**
 * Handle disconnect request
 * Removes OAuth tokens for an event/notification type
 */
async function handleDisconnect(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method not allowed" }, 405);
  }

  // Get request body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(req, { error: "Invalid JSON body" }, 400);
  }
  const eventId = typeof body?.eventId === "string" ? body.eventId : "";
  const notificationType = body?.notificationType;

  if (!eventId || eventId.length > 64 || !isNotificationType(notificationType)) {
    return jsonResponse(req, { error: "Missing or invalid eventId or notificationType" }, 400);
  }

  // Verify the caller can admin this event. This used to check only that an
  // Authorization header was present, with any value.
  const auth = await requireEventAdmin(req, eventId);
  if ("response" in auth) return auth.response;

  const supabase = serviceClient();
  if (!supabase) return jsonResponse(req, { error: "Server not configured" }, 503);

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
    console.error("Failed to disconnect:", dbErrorSummary(error));
    return new Response(JSON.stringify({ error: "Failed to disconnect" }), {
      status: 500,
      headers: { ...corsFor(req), "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ success: true }), {
    headers: { ...corsFor(req), "Content-Type": "application/json" },
  });
}

/**
 * Create an error redirect response
 */
function createErrorRedirect(errorMessage: string): Response {
  const returnUrl = new URL(siteUrl());
  returnUrl.searchParams.set("google_sheets_error", errorMessage);
  return Response.redirect(returnUrl.toString(), 302);
}
