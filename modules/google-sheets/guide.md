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

## Features

| Feature Flag | Description |
|---|---|
| `google-sheets.sync` | Two-way data sync between Gatewaze and Google Sheets |
| `google-sheets.oauth` | OAuth 2.0 authorization flow for Google account access |
| `google-sheets.notifications` | Real-time notifications when synced data changes |

### Edge Functions

- **integrations-google-sheets-notify** -- Sends notifications when synced data is updated
- **integrations-google-sheets-oauth** -- Handles the Google OAuth 2.0 authorization flow

## Dependencies

| Module | Required |
|---|---|
| `events` | Yes |
