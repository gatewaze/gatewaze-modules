# Event Interest

Capture expressions of interest from people before event registration opens. This module lets you gauge demand and collect early sign-ups for upcoming events, giving organizers a pipeline of interested attendees before tickets go live.

## How It Works

The module injects an "Interest" tab into the event detail view where administrators can view and manage interest submissions. An edge function (`events-interest`) provides a public-facing endpoint for collecting interest submissions. People can express interest in an event, and administrators can review the list, manage entries, and use the data to plan capacity or trigger notifications when registration opens.

## Configuration

No configuration settings are required.

## Features

- `event-interest` -- Core interest capture and display
- `event-interest.manage` -- Manage and review interest submissions

## Dependencies

- `events` -- Requires the events module for event association
