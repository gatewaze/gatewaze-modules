# Event Media

Photo and video galleries, media uploads, and album management for events. This module lets organizers and attendees upload images and videos, organize them into albums, and process media for display on event pages.

## How It Works

Event Media adds a **Media** tab to the event detail view in the admin panel. From there, organizers can upload photos and videos, create albums, and manage all media assets associated with an event. The module includes server-side edge functions for chunked uploads, image processing, YouTube integration (upload and retrieval), and bulk ZIP processing. Media is stored via Supabase storage and metadata is tracked in dedicated database tables.

## Configuration

This module has no configurable settings.

## Features

| Feature Flag | Description |
|---|---|
| `event-media` | Core media gallery functionality |
| `event-media.upload` | Upload photos and videos to events |
| `event-media.albums` | Organize media into named albums |

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
