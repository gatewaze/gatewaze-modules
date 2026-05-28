# Scheduler

Job queue and scraper scheduler management dashboard. This hidden module provides an admin interface for monitoring and managing scheduled jobs and background tasks.

## How It Works

The Scheduler module adds an admin dashboard page where you can view and manage scheduled jobs in the system. It is typically used alongside other modules (such as Scrapers) that create background tasks on a recurring schedule. The admin UI is accessible via the Scheduler nav item under the admin group.

## Configuration

This module has no additional configuration settings.

## Features

- `scheduler` -- Core scheduler functionality
- `scheduler.manage` -- View and manage scheduled jobs from the admin dashboard

## Dependencies

None.
