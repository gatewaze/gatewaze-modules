# Cvent

Cvent event platform integration for syncing registrations and admission items. This module connects your Gatewaze instance to Cvent, allowing you to pull registration data and admission items from Cvent events into your local database.

## How It Works

The module deploys an edge function (`integrations-cvent-sync`) that handles synchronization between Cvent and Gatewaze. When triggered, it pulls registration and admission item data from the Cvent API and maps it into your Gatewaze event records. This keeps your Gatewaze instance up to date with registrations managed in Cvent.

## Configuration

No configuration settings are required. Authentication with Cvent is handled at the integration level.

## Features

- `cvent` -- Core Cvent integration functionality
- `cvent.sync` -- Registration and admission item synchronization

## Dependencies

None.
