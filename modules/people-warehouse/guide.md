# People Warehouse

Bi-directional sync of people data with Customer.io -- automatically push new contacts, sync attributes, and import segment membership. This integration module bridges your Gatewaze people database with Customer.io, keeping both systems in sync for marketing automation and customer engagement workflows.

## How It Works

People Warehouse connects to Customer.io using both the Track API (for sending data) and the App API (for reading segments and customers). When a new person is created or updated in Gatewaze, the module can automatically push those changes to Customer.io. It also supports importing Customer.io segments back into Gatewaze and tracking events across both platforms. The module deploys several edge functions to handle syncing individual people, bulk sync operations, event processing, and incoming webhooks from Customer.io.

## Configuration

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `CUSTOMERIO_SITE_ID` | string | Yes | -- | Customer.io Track API site identifier |
| `CUSTOMERIO_API_KEY` | secret | Yes | -- | Customer.io Track API key for sending data |
| `CUSTOMERIO_APP_API_KEY` | secret | Yes | -- | Customer.io App API key for reading segments and customers |
| `SYNC_ON_CREATE` | boolean | No | `true` | Automatically sync new people to Customer.io when created |
| `SYNC_ON_UPDATE` | boolean | No | `true` | Automatically sync attribute changes to Customer.io |
| `IMPORT_SEGMENTS` | boolean | No | `true` | Import Customer.io segments and sync membership |

## Features

- `people-warehouse` -- Core people warehouse functionality
- `people-warehouse.sync` -- Bi-directional contact syncing between Gatewaze and Customer.io
- `people-warehouse.segments` -- Import and sync Customer.io segment membership
- `people-warehouse.tracking` -- Cross-platform event tracking

## Dependencies

- **customerio** -- Requires the Customer.io base integration module
