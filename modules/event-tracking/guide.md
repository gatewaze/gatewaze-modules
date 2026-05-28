# Event Tracking

UTM tracking, referral links, conversion analytics, and attribution for events. This module helps organizers understand where their registrations are coming from and measure the effectiveness of marketing campaigns.

## How It Works

Event Tracking adds a **Tracking** tab to the event detail view in the admin panel. Organizers can create UTM-tagged links and referral URLs, then monitor conversions and attribution data to see which channels and campaigns are driving registrations. Tracking data is stored in dedicated database tables and surfaced through the admin interface.

## Configuration

This module has no configurable settings.

## Features

| Feature Flag | Description |
|---|---|
| `event-tracking` | Core tracking and attribution functionality |
| `event-tracking.utm` | UTM parameter tracking for marketing campaigns |
| `event-tracking.referrals` | Referral link generation and conversion tracking |

## Dependencies

| Module | Required |
|---|---|
| `events` | Yes |
