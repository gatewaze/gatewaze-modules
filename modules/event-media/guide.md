# Event Media

Photo and video galleries, media uploads, and album management for events. This module lets organizers and attendees upload images and videos, organize them into albums, and process media for display on event pages.

## How It Works

Event Media adds a **Media** tab to the event detail view in the admin panel. The tab is a full media organizer over the event's `host_media` rows:

- Stats (photos, videos, albums, total size, pending approval), search, and filters by type, status (pending, approved, guest uploads), album and sponsor (`?sponsorId=` in the URL).
- Sorting by date or name, or a custom order you set by dragging, either event-wide or per album. Dragging inside a filtered view keeps hidden items in their places.
- Click to select (Shift-click for a range, Cmd/Ctrl-A for all), then add to albums, remove from the current album, tag sponsors, approve guest uploads, or delete in bulk.
- Album management (create, rename, describe, reorder, delete) and a viewer with previous/next, caption and alt text editing, approve, feature, copy link and download.
- Uploads of photos, videos or a ZIP. ZIPs are unpacked in the browser and top-level folders can become albums.
- Live updates as guests upload through a QR link.

Sponsor tags live in `events_media_sponsor_tags` (many sponsors per item), readable and writable only by admins of the event. The module includes server-side edge functions for chunked uploads, image processing, YouTube integration (upload and retrieval), and bulk ZIP processing. Media is stored via Supabase storage and metadata is tracked in dedicated database tables.

## Configuration

This module has no configurable settings.

## Features

| Feature Flag | Description |
|---|---|
| `event-media` | Core media gallery functionality |
| `event-media.upload` | Upload photos and videos to events |
| `event-media.albums` | Organize media into named albums |
| `event-media.sponsor-tags` | Tag sponsors that appear in photos and filter by sponsor |

### Edge Functions

- **media-combine-chunks** -- Reassembles chunked file uploads into a single file
- **media-get-youtube-upload-url** -- Retrieves a signed upload URL for YouTube
- **media-process-image** -- Server-side image processing (resize, optimize)
- **media-process-youtube-uploads** -- Handles YouTube upload workflows
- **media-process-zip** -- Extracts and processes bulk ZIP media uploads
- **media-upload-youtube** -- Uploads video content to YouTube

## Dependencies

| Module | Required |
|---|---|
| `events` | Yes |
| `event-sponsors` | Yes |
