/**
 * Google Sheets Notification Edge Function
 *
 * Appends data to Google Sheets when:
 * - A user registers for an event
 * - A speaker submits a call for speakers proposal
 *
 * Uses OAuth tokens stored per-event (not service account)
 *
 * Who may call it (verify_jwt is off, so this function checks for itself):
 * - A server-side push of a real registration or speaker submission must
 *   present this project's service-role key as its bearer token.
 * - A test send (isTest) or a historic send (isHistoric) from the admin must
 *   present a signed-in user's token, and that user must be able to admin
 *   the event. The service-role key cannot make these.
 * Anything else is refused: no or invalid token 401, wrong caller 403.
 *
 * Cells are written with USER_ENTERED so timestamps and amounts stay dates
 * and numbers in the sheet. Registrant names, talk titles and the like are
 * untrusted, so any cell that a spreadsheet would read as a formula is
 * prefixed with a single quote first (see defuseCell).
 */

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  bearerToken,
  corsFor,
  isServiceRoleRequest,
  jsonResponse,
  requireEventAdmin,
} from "../_shared/google-sheets-auth.ts";

// Google Sheets API endpoint
const SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

const NOTIFICATION_TYPES = ["registration", "speaker_submission"] as const;

// The service-role client, untyped: there are no generated database types
// here, and ReturnType<typeof createClient> resolves its schema to never.
// deno-lint-ignore no-explicit-any
type DB = any;

interface NotifyPayload {
  eventId: string;
  notificationType: "registration" | "speaker_submission";
  data?: {
    // Registration data
    firstName?: string;
    lastName?: string;
    email?: string;
    registeredAt?: string;
    registrationId?: string;
    ticketType?: string;
    amountPaid?: number;
    currency?: string;
    // Speaker submission data - can be IDs (from trigger) or full data (from UI)
    talkId?: string;
    speakerId?: string;
    speakerName?: string;
    talkTitle?: string;
    talkSynopsis?: string;
    speakerBio?: string;
    jobTitle?: string;
    company?: string;
    linkedinUrl?: string;
    avatarUrl?: string;
    status?: string;
    submittedAt?: string;
  };
  isTest?: boolean;
  isHistoric?: boolean;
}

interface NotificationConfig {
  id: string;
  event_id: string;
  notification_type: string;
  enabled: boolean;
  spreadsheet_id: string | null;
  sheet_name: string | null;
  google_access_token: string | null;
  google_refresh_token: string | null;
  google_token_expires_at: string | null;
}

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") {
      return new Response("ok", { headers: corsFor(req) });
    }
    if (req.method !== "POST") {
      return jsonResponse(req, { error: "Method not allowed" }, 405);
    }

    // Cheap refusal before the body is read.
    if (!bearerToken(req)) {
      return jsonResponse(req, { error: "Unauthorized" }, 401);
    }

    let payload: NotifyPayload;
    try {
      payload = await req.json();
    } catch {
      return jsonResponse(req, { error: "Invalid JSON body" }, 400);
    }
    const { eventId, notificationType, data } = payload ?? ({} as NotifyPayload);
    const isTest = payload?.isTest === true;
    const isHistoric = payload?.isHistoric === true;

    if (
      typeof eventId !== "string" || eventId === "" || eventId.length > 64 ||
      !(NOTIFICATION_TYPES as readonly string[]).includes(notificationType)
    ) {
      return jsonResponse(req, { error: "Missing or invalid eventId or notificationType" }, 400);
    }

    // Who is calling. The service role pushes real rows; an event admin runs
    // test and historic sends. Neither may do the other's job.
    const fromServer = await isServiceRoleRequest(req);
    if (fromServer) {
      if (isTest || isHistoric) {
        return jsonResponse(req, { error: "Test and historic sends need an event admin" }, 403);
      }
    } else {
      const auth = await requireEventAdmin(req, eventId);
      if ("response" in auth) return auth.response;
      if (!isTest && !isHistoric) {
        return jsonResponse(req, { error: "Only the server can push live rows" }, 403);
      }
    }

    // Create Supabase client
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
    );

    // Get notification configuration for this event
    const { data: notificationConfig, error: configError } = await supabaseClient
      .from("event_google_sheets_notifications")
      .select("*")
      .eq("event_id", eventId)
      .eq("notification_type", notificationType)
      .maybeSingle();

    if (configError) {
      console.error("Error fetching notification config:", configError);
      return jsonResponse(req,
        { error: "Failed to fetch notification configuration" },
        500
      );
    }

    if (!notificationConfig) {
      console.log(
        `No Google Sheets notification configured for event ${eventId}, type ${notificationType}`
      );
      return jsonResponse(req,
        { message: "No notification configured", skipped: true },
        200
      );
    }

    if (!notificationConfig.enabled && !isTest && !isHistoric) {
      console.log(
        `Google Sheets notification disabled for event ${eventId}, type ${notificationType}`
      );
      return jsonResponse(req, { message: "Notification disabled", skipped: true }, 200);
    }

    if (!notificationConfig.spreadsheet_id) {
      console.error(`No spreadsheet ID configured for event ${eventId}`);
      return jsonResponse(req, { error: "No spreadsheet configured" }, 400);
    }

    // Check if OAuth is configured
    if (!notificationConfig.google_refresh_token) {
      console.error(`No OAuth credentials for event ${eventId}`);
      return jsonResponse(req,
        { error: "Google account not connected. Please reconnect in settings." },
        400
      );
    }

    // Get valid access token (refresh if needed)
    const accessToken = await getValidAccessToken(
      supabaseClient,
      notificationConfig
    );
    if (!accessToken) {
      return jsonResponse(req,
        {
          error:
            "Failed to get Google API access token. Please reconnect your Google account.",
        },
        500
      );
    }

    // Handle historic mode - fetch and send all historic data
    if (isHistoric) {
      const historicResult = await sendHistoricData(
        supabaseClient,
        accessToken,
        notificationConfig,
        eventId,
        notificationType
      );
      return jsonResponse(req, historicResult, historicResult.success ? 200 : 500);
    }

    // For speaker submissions, fetch details if only IDs provided. Only for
    // the server's pushes: a test send's IDs come from the browser and could
    // name another event's talk.
    let enrichedData = data;
    if (fromServer && notificationType === "speaker_submission" && data?.talkId && !data?.talkTitle) {
      enrichedData = await fetchTalkAndSpeakerDetails(supabaseClient, data.talkId, data.speakerId);
    }

    // Build the row data
    const rowData = buildRowData(notificationType, enrichedData);

    // Append to Google Sheet
    const sheetName = notificationConfig.sheet_name || "Sheet1";
    const appendResult = await appendToSheet(
      accessToken,
      notificationConfig.spreadsheet_id,
      sheetName,
      rowData
    );

    if (!appendResult.success) {
      // Log failure
      await logNotification(supabaseClient, {
        eventId,
        notificationType,
        spreadsheetId: notificationConfig.spreadsheet_id,
        sheetName,
        status: "failed",
        errorMessage: appendResult.error,
        triggerId: enrichedData?.talkId || enrichedData?.registrationId || enrichedData?.speakerId || "test",
        triggerType: notificationType,
        rowData,
      });
      return jsonResponse(req, { error: appendResult.error }, 400);
    }

    // Log success
    await logNotification(supabaseClient, {
      eventId,
      notificationType,
      spreadsheetId: notificationConfig.spreadsheet_id,
      sheetName,
      status: "sent",
      triggerId: enrichedData?.talkId || enrichedData?.registrationId || enrichedData?.speakerId || "test",
      triggerType: notificationType,
      rowData,
      rowNumber: appendResult.updatedRows,
    });

    console.log(
      `Successfully appended ${notificationType} to Google Sheet for event ${eventId}`
    );

    return jsonResponse(req,
      {
        success: true,
        message: "Data appended to Google Sheet",
        updatedRange: appendResult.updatedRange,
      },
      200
    );
  } catch (error) {
    console.error("Unexpected error:", error instanceof Error ? error.message : String(error));
    return jsonResponse(req, { error: "Internal server error" }, 500);
  }
});

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Makes a cell safe for USER_ENTERED: a value a spreadsheet would read as a
 * formula (leading =, +, -, @, tab or carriage return) gets a leading single
 * quote, which Sheets treats as "this is text" and does not display. A plain
 * number such as -5 is left alone so it stays a number.
 */
export function defuseCell(value: string): string {
  // A plain number, negative included, is safe and should stay a number.
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function defuseRows(rows: string[][]): string[][] {
  return rows.map((row) => row.map((cell) => defuseCell(String(cell ?? ""))));
}

/**
 * Get a valid access token, refreshing if necessary
 */
async function getValidAccessToken(
  supabase: DB,
  config: NotificationConfig
): Promise<string | null> {
  // Check if current token is still valid
  if (config.google_access_token && config.google_token_expires_at) {
    const expiresAt = new Date(config.google_token_expires_at);
    const now = new Date();
    // Add 5 minute buffer before expiry
    if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
      return config.google_access_token;
    }
  }

  // Need to refresh the token
  if (!config.google_refresh_token) {
    console.error("No refresh token available");
    return null;
  }

  const clientId = Deno.env.get("GOOGLE_SHEETS_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("GOOGLE_SHEETS_CLIENT_SECRET") ?? "";
  if (!clientId || !clientSecret) {
    console.error("Google OAuth client credentials not configured");
    return null;
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: config.google_refresh_token,
        grant_type: "refresh_token",
      }),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error("Token refresh failed:", errorData);
      return null;
    }

    const tokens = await tokenResponse.json();
    const access_token = tokens?.access_token;
    const expires_in =
      typeof tokens?.expires_in === "number" && Number.isFinite(tokens.expires_in) ? tokens.expires_in : 3600;

    if (typeof access_token !== "string" || access_token === "") {
      console.error("No access token in refresh response");
      return null;
    }

    // Calculate new expiry time
    const expiresAt = new Date(Date.now() + expires_in * 1000).toISOString();

    // Update tokens in database
    const { error: updateError } = await supabase
      .from("event_google_sheets_notifications")
      .update({
        google_access_token: access_token,
        google_token_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", config.id);

    if (updateError) {
      // Code and message only: details can echo the row, tokens included.
      console.error("Failed to update tokens:", `${updateError.code ?? "unknown"}: ${updateError.message ?? ""}`);
      // Still return the token even if we couldn't save it
    }

    return access_token;
  } catch (error) {
    console.error("Error refreshing token:", error);
    return null;
  }
}

/**
 * Fetch talk and speaker details when only IDs are provided (from trigger)
 */
async function fetchTalkAndSpeakerDetails(
  supabase: DB,
  talkId: string,
  speakerId?: string
): Promise<NotifyPayload["data"]> {
  // Fetch talk details
  const { data: talk, error: talkError } = await supabase
    .from("event_talks")
    .select("id, title, synopsis, status, submitted_at, created_at")
    .eq("id", talkId)
    .single();

  if (talkError || !talk) {
    console.error("Error fetching talk:", talkError);
    return { talkId };
  }

  // Fetch speaker details if speakerId provided
  let speakerData: {
    speakerName?: string;
    email?: string;
    jobTitle?: string;
    company?: string;
    linkedinUrl?: string;
    avatarUrl?: string;
    speakerBio?: string;
  } = {};

  if (speakerId) {
    const { data: speaker, error: speakerError } = await supabase
      .from("event_speakers")
      .select(`
        id,
        speaker_bio,
        speaker_title,
        people_profiles!inner (
          people!inner (
            email,
            attributes,
            linkedin_url
          )
        )
      `)
      .eq("id", speakerId)
      .single();

    if (!speakerError && speaker) {
      const person = (speaker as any).people_profiles?.people;
      const attrs = person?.attributes || {};
      const firstName = attrs.first_name || "";
      const lastName = attrs.last_name || "";
      speakerData = {
        speakerName: [firstName, lastName].filter(Boolean).join(" ") || person?.email || "Unknown Speaker",
        email: person?.email || "",
        jobTitle: attrs.job_title || "",
        company: attrs.company || "",
        linkedinUrl: person?.linkedin_url || "",
        speakerBio: speaker.speaker_bio || "",
      };
    }
  }

  return {
    talkId,
    speakerId,
    talkTitle: talk.title || "",
    talkSynopsis: talk.synopsis || "",
    status: talk.status || "pending",
    submittedAt: talk.submitted_at || talk.created_at || new Date().toISOString(),
    ...speakerData,
  };
}

/**
 * Build row data based on notification type
 */
function buildRowData(
  notificationType: "registration" | "speaker_submission",
  data?: NotifyPayload["data"]
): string[] {
  const now = new Date().toISOString();

  if (notificationType === "registration") {
    // Registration columns: A-H
    // Timestamp | First Name | Last Name | Email | Ticket Type | Amount Paid | Currency | Registration ID
    return [
      data?.registeredAt || now,
      data?.firstName || "",
      data?.lastName || "",
      data?.email || "",
      data?.ticketType || "",
      data?.amountPaid?.toString() || "",
      data?.currency || "",
      data?.registrationId || "",
    ];
  } else {
    // Speaker submission columns: A-L
    // Timestamp | Speaker Name | Email | Job Title | Company | LinkedIn | Avatar | Talk Title | Talk Synopsis | Speaker Bio | Status | Talk ID
    return [
      data?.submittedAt || now,
      data?.speakerName || "",
      data?.email || "",
      data?.jobTitle || "",
      data?.company || "",
      data?.linkedinUrl || "",
      data?.avatarUrl || "",
      data?.talkTitle || "",
      data?.talkSynopsis || "",
      data?.speakerBio || "",
      data?.status || "pending",
      data?.talkId || data?.speakerId || "", // Use talkId as primary identifier, fallback to speakerId for backward compatibility
    ];
  }
}

/**
 * Append a row to Google Sheet
 */
async function appendToSheet(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
  values: string[]
): Promise<{
  success: boolean;
  error?: string;
  updatedRange?: string;
  updatedRows?: number;
}> {
  try {
    const range = `${sheetName}!A:Z`;
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        values: defuseRows([values]),
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Google Sheets API error:", result);
      return {
        success: false,
        error: result.error?.message || "Failed to append to sheet",
      };
    }

    return {
      success: true,
      updatedRange: result.updates?.updatedRange,
      updatedRows: result.updates?.updatedRows,
    };
  } catch (error) {
    console.error("Error appending to sheet:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Log notification result
 */
async function logNotification(
  supabase: DB,
  params: {
    eventId: string;
    notificationType: string;
    spreadsheetId: string;
    sheetName: string;
    status: "sent" | "failed" | "updated";
    errorMessage?: string;
    triggerId: string;
    triggerType: string;
    rowData: string[];
    rowNumber?: number;
  }
) {
  try {
    await supabase.from("google_sheets_notification_logs").insert({
      event_id: params.eventId,
      notification_type: params.notificationType,
      spreadsheet_id: params.spreadsheetId,
      sheet_name: params.sheetName,
      status: params.status,
      error_message: params.errorMessage,
      trigger_entity_type: params.triggerType,
      trigger_entity_id: params.triggerId,
      row_data: params.rowData,
      row_number: params.rowNumber,
    });
  } catch (err) {
    console.error("Failed to log notification:", err);
  }
}

// =============================================================================
// Historic Data Send
// =============================================================================

async function sendHistoricData(
  supabase: DB,
  accessToken: string,
  config: { spreadsheet_id: string; sheet_name: string },
  eventId: string,
  notificationType: "registration" | "speaker_submission"
): Promise<{
  success: boolean;
  sent: number;
  failed: number;
  total: number;
  errors?: string[];
}> {
  const errors: string[] = [];
  let sent = 0;
  let failed = 0;

  const sheetName = config.sheet_name || "Sheet1";

  if (notificationType === "registration") {
    // Fetch all registrations for this event
    const { data: registrations, error } = await supabase
      .from("event_registrations_with_members")
      .select(
        "id, first_name, last_name, email, registered_at, ticket_type, amount_paid, currency"
      )
      .eq("event_id", eventId)
      .eq("status", "confirmed")
      .order("registered_at", { ascending: true });

    if (error) {
      console.error("Error fetching registrations:", error);
      return {
        success: false,
        sent: 0,
        failed: 0,
        total: 0,
        errors: [error.message],
      };
    }

    const total = registrations?.length || 0;
    console.log(`Found ${total} registrations to send for event ${eventId}`);

    if (total === 0) {
      return { success: true, sent: 0, failed: 0, total: 0 };
    }

    // Build all rows
    const rows: string[][] = [];
    for (const reg of registrations || []) {
      rows.push([
        reg.registered_at || new Date().toISOString(),
        reg.first_name || "",
        reg.last_name || "",
        reg.email || "",
        reg.ticket_type || "",
        reg.amount_paid?.toString() || "",
        reg.currency || "",
        reg.id || "",
      ]);
    }

    // Batch append all rows at once
    const batchResult = await batchAppendToSheet(
      accessToken,
      config.spreadsheet_id,
      sheetName,
      rows
    );

    if (batchResult.success) {
      sent = total;
    } else {
      failed = total;
      errors.push(batchResult.error || "Batch append failed");
    }

    return {
      success: failed === 0,
      sent,
      failed,
      total,
      errors: errors.length > 0 ? errors : undefined,
    };
  } else {
    // Speaker/Talk submissions - now using talks as the primary entity
    const { data: eventRecord, error: eventError } = await supabase
      .from("events")
      .select("id")
      .eq("event_id", eventId)
      .single();

    if (eventError || !eventRecord) {
      console.error("Error fetching event UUID:", eventError);
      return {
        success: false,
        sent: 0,
        failed: 0,
        total: 0,
        errors: ["Event not found"],
      };
    }

    // Fetch talks with speaker details
    const { data: talks, error } = await supabase
      .from("event_talks_with_speakers")
      .select("*")
      .eq("event_uuid", eventRecord.id)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("Error fetching talks:", error);
      return {
        success: false,
        sent: 0,
        failed: 0,
        total: 0,
        errors: [error.message],
      };
    }

    const total = talks?.length || 0;
    console.log(
      `Found ${total} talk submissions to send for event ${eventId}`
    );

    if (total === 0) {
      return { success: true, sent: 0, failed: 0, total: 0 };
    }

    // Build all rows - one row per talk
    const rows: string[][] = [];
    for (const talk of talks || []) {
      // Get the primary speaker from the speakers array
      const speakers = talk.speakers || [];
      const primarySpeaker = speakers.find((s: any) => s.is_primary) || speakers[0] || {};

      rows.push([
        talk.submitted_at || talk.created_at || new Date().toISOString(),
        primarySpeaker.full_name || "Unknown Speaker",
        primarySpeaker.email || "",
        primarySpeaker.job_title || "",
        primarySpeaker.company || "",
        "", // linkedin_url - not in current view
        primarySpeaker.avatar_url || "",
        talk.title || "",
        talk.synopsis || "",
        primarySpeaker.speaker_bio || "",
        talk.status || "pending",
        talk.id || "", // Talk ID as the row identifier
      ]);
    }

    // Batch append all rows at once
    const batchResult = await batchAppendToSheet(
      accessToken,
      config.spreadsheet_id,
      sheetName,
      rows
    );

    if (batchResult.success) {
      sent = total;
    } else {
      failed = total;
      errors.push(batchResult.error || "Batch append failed");
    }

    return {
      success: failed === 0,
      sent,
      failed,
      total,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

/**
 * Batch append multiple rows to Google Sheet
 */
async function batchAppendToSheet(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
  rows: string[][]
): Promise<{ success: boolean; error?: string }> {
  try {
    const range = `${sheetName}!A:Z`;
    const url = `${SHEETS_API_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        values: defuseRows(rows),
      }),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error("Google Sheets API error:", result);
      return {
        success: false,
        error: result.error?.message || "Failed to append to sheet",
      };
    }

    return { success: true };
  } catch (error) {
    console.error("Error batch appending to sheet:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
