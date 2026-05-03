# Lists

Manage subscription lists with subscribe/unsubscribe flows, webhook notifications, and external system sync. Lists provides a flexible way to organize people into named groups, track their subscription status, and integrate with external tools.

## How It Works

The module adds a full subscription list system to Gatewaze. Admins can create and manage lists through a dedicated admin page at `/admin/lists`. Each list supports subscribe and unsubscribe flows, and the module exposes API routes for programmatic access. A person detail slot shows subscription information directly on individual person records, making it easy to see which lists someone belongs to.

The module includes migrations for core list tables, a migration path from legacy email subscriptions, and support for external API keys for third-party integrations.

## Configuration

No configuration settings are required. The module works out of the box once installed.

## Features

- `lists` — Core list functionality and viewing
- `lists.manage` — Create, edit, and delete subscription lists
- `lists.webhooks` — Webhook notifications when subscriptions change
- `lists.import` — Bulk import subscribers into lists

## Dependencies

None. This is a standalone feature module.
