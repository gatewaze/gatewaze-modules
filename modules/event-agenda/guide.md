# Event Agenda

Schedule and manage event agenda sessions, time slots, and tracks. This module adds agenda management capabilities to your events, allowing you to build out detailed session schedules with speaker assignments.

## How It Works

The module injects an "Agenda" tab into the event detail view. From this tab, administrators can create and organize agenda sessions, assign time slots, and group sessions into tracks. Sessions can be linked to speakers from the event-speakers module.

The agenda data is stored in dedicated database tables created during module installation.

## Configuration

No configuration settings are required.

## Features

- `event-agenda` -- Core agenda display and functionality
- `event-agenda.manage` -- Create and edit agenda sessions, time slots, and tracks

## Dependencies

- `events` -- Requires the events module for event association
- `event-speakers` -- Requires the event speakers module for linking speakers to sessions
