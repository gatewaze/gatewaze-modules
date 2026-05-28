# Customer.io

Customer.io CRM integration for syncing contacts, tracking events, and processing webhooks. This module connects your Gatewaze instance to Customer.io, enabling automated contact synchronization, event tracking, and inbound webhook processing for real-time data flow between the two platforms.

## How It Works

The module deploys a set of edge functions that handle bidirectional communication with Customer.io. Contacts from your Gatewaze database are synced to Customer.io as people, events are tracked and forwarded for use in Customer.io campaigns and segments, and inbound webhooks allow Customer.io to push data back into Gatewaze. The sync can be triggered per-person or in bulk, and event processing runs through a dedicated edge function.

Edge functions deployed:
- `integrations-customerio-sync` -- Bulk contact sync
- `integrations-customerio-webhook` -- Inbound webhook receiver
- `integrations-customerio-sync-person` -- Single-person sync
- `integrations-customerio-process-events` -- Event processing pipeline
- `integrations-track-event` -- Outbound event tracking

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `CUSTOMERIO_SITE_ID` | string | Yes | Customer.io site ID |
| `CUSTOMERIO_API_KEY` | secret | Yes | Customer.io API key for tracking and syncing |

## Features

- `customerio` -- Core integration functionality
- `customerio.sync` -- Contact synchronization between Gatewaze and Customer.io
- `customerio.webhooks` -- Inbound webhook processing from Customer.io
- `customerio.tracking` -- Outbound event tracking to Customer.io

## Dependencies

None.
