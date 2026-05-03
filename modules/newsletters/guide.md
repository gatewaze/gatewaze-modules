# Newsletters

Create, edit, and distribute newsletters with edition management, template collections, and subscriber tracking. The newsletters module provides a full editorial workflow from content creation through sending.

## How It Works

The module adds a complete newsletter system to Gatewaze with a rich admin interface. The core workflow revolves around editions — individual newsletter issues that are composed using a block-based editor. Editors can build editions from reusable templates organized into collections, with support for both block-level and brick-level template components.

Key admin pages include:

- **Newsletter index** (`/newsletters`) — Overview of all newsletters and editions.
- **Edition editor** (`/newsletters/editor/:id`) — Block-based editor for composing individual editions.
- **Templates** (`/newsletters/templates`) — Manage template collections, individual block templates, and brick templates. Supports uploading new templates.
- **Sends** (`/newsletters/sends`) — Track newsletter sends and view delivery details.

The module uses eight migrations that build up the schema progressively, covering core tables, template collections, send tracking, block associations, content categories, AI summary blocks, newsletter types, and sort ordering.

## Configuration

No configuration settings are required. The module works out of the box once installed.

## Features

- `newsletters` — Core newsletter and edition management
- `newsletters.editor` — Block-based newsletter editor
- `newsletters.editions` — Edition lifecycle management (draft, review, published)
- `newsletters.subscribers` — Subscriber tracking and management
- `newsletters.templates` — Reusable template collections with block and brick components
- `newsletters.sending` — Send management, delivery tracking, and send history

## Dependencies

None. This is a standalone feature module. For platform-specific output, install one of the output modules (Beehiiv or Substack).
