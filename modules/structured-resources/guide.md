# Structured Resources

Create and manage hierarchical resource guides with configurable section templates and access control. This premium module lets you build organized collections of resources that are accessible to your community through both the admin panel and the member portal.

## How It Works

The Structured Resources module provides a system for organizing content into collections and items. Admins can create collections, manage their contents, and bulk-import resources. Each collection can be configured with its own access level (public or authenticated). The module includes both admin routes for management and portal routes for end-user browsing. Portal visitors navigate through collections and individual resource items using SEO-friendly slug-based URLs. A teaser mode can optionally show titles and descriptions to unauthenticated visitors with a sign-in prompt.

## Configuration

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `default_access` | select (`public`, `authenticated`) | No | `authenticated` | Default access level for new collections. Individual collections can override this. |
| `show_teaser` | boolean | No | `true` | When a collection requires auth, show titles and descriptions with a sign-in prompt |

## Features

- `structured-resources` -- Core resource management and portal display
- `structured-resources.collections` -- Create and manage resource collections
- `structured-resources.import` -- Bulk import resources into collections

## Dependencies

None.
