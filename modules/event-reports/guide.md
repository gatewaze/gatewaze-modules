# Event Reports

Analytics dashboards, attendance reports, and post-event summary generation. This module gives organizers visibility into how their events are performing with data-driven insights.

## How It Works

Event Reports adds a **Reports** tab to the event detail view in the admin panel. Organizers can view analytics dashboards that surface attendance data, engagement metrics, and post-event summaries. The module reads from existing event data (registrations, check-ins, etc.) and presents it in visual report form.

## Configuration

This module has no configurable settings.

## Features

| Feature Flag | Description |
|---|---|
| `event-reports` | Core reporting and dashboard functionality |
| `event-reports.analytics` | Detailed analytics views and data exports |

## Dependencies

| Module | Required |
|---|---|
| `events` | Yes |
