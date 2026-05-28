# Gradual Integration

Sync event registrations and attendance data with the Gradual platform. This integration module connects Gatewaze events to Gradual via webhooks and batch sync, allowing you to keep both systems in lockstep without manual data entry.

## How It Works

The module provides three edge functions that handle different aspects of the Gradual integration:

- **Sync** (`integrations-gradual-sync`) — Performs batch synchronization of registration and attendance data between Gatewaze and Gradual.
- **Webhook** (`integrations-gradual-webhook`) — Receives incoming webhooks from Gradual to process real-time updates.
- **Import History** (`integrations-gradual-import-history`) — Imports historical data from Gradual into Gatewaze.

When enabled, the module creates the necessary database tables via its migration and begins listening for sync and webhook events.

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `GRADUAL_CLIENT_ID` | string | Yes | Gradual API client ID |
| `GRADUAL_BEARER_TOKEN` | secret | Yes | Gradual API bearer token for authentication |

## Features

- `gradual.sync` — Batch synchronization of registrations and attendance between Gatewaze and Gradual
- `gradual.webhooks` — Real-time webhook processing for instant updates from Gradual

## Dependencies

- **events** — Requires the events module to be installed, since registrations and attendance are tied to events.
