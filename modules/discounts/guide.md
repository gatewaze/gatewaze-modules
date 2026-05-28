# Discounts

Create, distribute, and track discount codes for events and products. This module adds a full discount management system to Gatewaze, including admin pages for creating codes, viewing claimants, and embedding discount controls directly into event detail views.

## How It Works

The module provides a dedicated admin section for managing discount codes. Discounts can be created, assigned to specific events, and tracked as attendees claim them. An event-detail tab is injected so you can view and manage discounts directly from the event page. The claimants view shows who has redeemed each code.

Admin pages:
- `/discounts` -- Main discount management listing
- `/discounts/:eventId/detail` -- Discount detail for a specific event
- `/discounts/:eventId/claimants` -- View who has claimed discounts

The module also injects a "Discounts" tab into the event detail view via the admin slot system.

## Configuration

No configuration settings are required.

## Features

- `discounts` -- Core discount functionality
- `discounts.manage` -- Create and edit discount codes
- `discounts.claimants` -- View and manage discount claimants

## Dependencies

- `events` -- Requires the events module for event association
