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

- `resources` -- Core resource management and portal display
- `resources.collections` -- Create and manage resource collections
- `resources.import` -- Bulk import resources into collections

## Public API

Mounted at `/api/v1/resources`. Two API-key scopes:

- `resources:read` -- public read surface (`GET /`, `GET /items/:id`), backed by the `sr_public_items` view so it can only ever serve published items in published, public collections.
- `resources:write` -- management surface used by the Gatewaze MCP server's `resources_*` tools and other API-key integrations. Sees and mutates drafts:
  - `GET|POST /collections`, `GET|PATCH /collections/:id`
  - `POST /collections/:id/categories`, `POST /collections/:id/templates`
  - `GET|POST /collections/:id/items` (item create accepts an ordered `sections` array)
  - `GET /items/:id/manage`, `PATCH /items/:id`, `PUT /items/:id/sections` (full replace)

Slugs are generated from names/titles when omitted and de-duplicated server-side. Publishing is a `PATCH` with `status: 'published'` -- an item is only publicly visible once its item AND collection are published and the collection has `access: 'public'`. There are deliberately no DELETE endpoints on this surface; deletion stays in the admin UI.

## Dependencies

None.
