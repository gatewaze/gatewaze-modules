# Luma.com Integration

Sync events and registrations from Luma (lu.ma) into Gatewaze. This integration processes webhooks for real-time updates, supports CSV imports for bulk data, and can issue discount codes through the Luma platform.

## How It Works

The module provides four edge functions:

- **Webhook** (`integrations-luma-webhook`) — Receives real-time event and registration updates from Luma via webhooks.
- **Process Registration** (`integrations-luma-process-registration`) — Handles individual registration events, mapping Luma fields to Gatewaze records.
- **Process CSV** (`integrations-luma-process-csv`) — Imports registrations in bulk from Luma CSV exports.
- **Issue Discount** (`integrations-luma-issue-discount`) — Creates and issues discount codes through the Luma API.

The admin UI integrates directly into event registration views via slots, adding a Luma Import action and upload status indicators to both event registration and calendar member screens.

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `LUMA_API_KEY` | secret | Yes | Luma API key for accessing event and registration data |
| `LUMA_WEBHOOK_SECRET` | secret | No | Luma webhook signing secret for verification |

## Features

- `luma.sync` — Sync events and registrations from Luma, including CSV import
- `luma.webhooks` — Real-time webhook processing for Luma events
- `luma.discounts` — Issue and manage discount codes via the Luma API

## Dependencies

- **events** — Requires the events module, since Luma data maps to Gatewaze events and registrations.
