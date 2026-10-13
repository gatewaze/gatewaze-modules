# Google Sheets Integration

Sync registration and speaker data to Google Sheets with OAuth and real-time notifications. This integration module bridges your event data with Google Sheets so teams can work with familiar spreadsheet tools.

## How It Works

The Google Sheets integration connects to the Google Sheets API using OAuth 2.0. Once authorized, it can sync event registration and speaker data into designated spreadsheets. The module includes edge functions for handling the OAuth flow and sending real-time notifications when data changes. Credentials and connection state are stored in dedicated database tables.

## Configuration

| Setting | Type | Required | Description |
|---|---|---|---|
| `GOOGLE_SHEETS_CLIENT_ID` | string | Yes | Google OAuth client ID for Sheets API |
| `GOOGLE_SHEETS_CLIENT_SECRET` | secret | Yes | Google OAuth client secret for Sheets API |
| `GOOGLE_SHEETS_REDIRECT_URI` | string | No | OAuth redirect URI (defaults to app callback) |

To obtain the client ID and secret, create a project in the [Google Cloud Console](https://console.cloud.google.com/), enable the Google Sheets API, and configure an OAuth 2.0 credential.

On that OAuth client, register this authorised redirect URI exactly: `<PUBLIC_SUPABASE_URL, or SUPABASE_URL when that is unset>/functions/v1/integrations-google-sheets-oauth/callback`, for example `https://db.example.com/functions/v1/integrations-google-sheets-oauth/callback`.

`GOOGLE_SHEETS_CLIENT_SECRET` also signs the OAuth `state` value, so the flow fails closed when it is missing. A connection must be finished within 10 minutes of clicking Connect, and rotating the secret cancels any connection in progress. After Google sends the browser back, it returns only to a path on `SITE_URL`, or to a URL on the `SITE_URL` or `ADMIN_BASE_URL` origin; anything else lands on `/`.

## Features

| Feature Flag | Description |
|---|---|
| `google-sheets.sync` | Two-way data sync between Gatewaze and Google Sheets |
| `google-sheets.oauth` | OAuth 2.0 authorization flow for Google account access |
| `google-sheets.notifications` | Real-time notifications when synced data changes |

### Edge Functions

- **integrations-google-sheets-notify** -- Sends notifications when synced data is updated. A server-side caller pushing a real registration or speaker submission must send `Authorization: Bearer <key>`, where the key is exactly the `SUPABASE_SERVICE_ROLE_KEY` value the function itself sees. On Supabase Cloud that is the legacy service-role JWT, not an `sb_secret_` key; any other value is refused. Test and historic sends come from the admin and need a signed-in admin who can manage the event. Cells a spreadsheet would read as a formula are written as text.
- **integrations-google-sheets-oauth** -- Handles the Google OAuth 2.0 authorization flow. Starting a connection or disconnecting needs a signed-in admin who can manage the event.

## Dependencies

| Module | Required |
|---|---|
| `events` | Yes |
