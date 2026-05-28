# Offers

Create and distribute offers with acceptance tracking and conversion analytics. The offers module lets you define promotional offers tied to events, track who views and accepts them, and analyze conversion performance.

## How It Works

The module provides a full offer management workflow through the admin interface:

- **Offers index** (`/offers`) — View and manage all active and past offers.
- **Accepted view** (`/offers/:eventId/accepted`) — See who has accepted a specific offer, with detailed acceptance records.
- **Detail view** (`/offers/:eventId/detail`) — View full offer details and performance metrics for a given event.

An edge function (`integrations-track-offer`) handles offer tracking on the recipient side, recording views and acceptances as they happen. This data feeds into the conversion analytics visible in the admin.

## Configuration

No configuration settings are required.

## Features

- `offers` — Core offer creation and viewing
- `offers.manage` — Create, edit, and distribute offers
- `offers.tracking` — Track offer views, acceptances, and conversion analytics

## Dependencies

None. This is a standalone feature module.
