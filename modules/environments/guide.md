# Environments

Push and pull content between Supabase environments -- sync database rows, edge functions, storage, and auth configuration across local, cloud, and self-hosted instances. This module gives administrators the ability to manage multiple Gatewaze environments and move data between them.

## How It Works

The module registers API routes and admin pages for managing environment connections. Each environment represents a separate Supabase instance (local, cloud, or self-hosted). Once environments are configured, you can sync content between them, provision new instances, and create backups.

Admin pages:
- `/admin/environments` -- List and manage environments
- `/admin/environments/:environmentId` -- Environment detail view
- `/admin/environments/:environmentId/provision` -- Provision a new environment
- `/admin/environments/:environmentId/sync` -- Sync content between environments
- `/admin/environments/backup` -- Backup management

The module also exposes server-side API routes for programmatic environment operations.

## Configuration

| Setting | Type | Required | Description |
|---------|------|----------|-------------|
| `encryptionKey` | secret | No | Optional encryption key for storing environment credentials at rest |

## Features

- `environments` -- Core environment management
- `environments.manage` -- Create, edit, provision, and back up environments
- `environments.sync` -- Push and pull data between environments

## Dependencies

None.
