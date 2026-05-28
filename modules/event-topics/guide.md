# Event Topics

Topic taxonomy with hierarchical categories for organizing and tagging events. This module lets you build a structured classification system so attendees can discover events by subject matter.

## How It Works

Event Topics adds a dedicated **Topics** page to the admin panel (under the admin navigation group) where organizers can create and manage a hierarchical topic taxonomy. Topics can be organized into categories and subcategories, then assigned to events for filtering and discovery. The module provides its own admin route and navigation item rather than a tab on the event detail view, since topics are managed globally across all events.

## Configuration

This module has no configurable settings.

## Features

| Feature Flag | Description |
|---|---|
| `event-topics` | Core topic listing and assignment functionality |
| `event-topics.categories` | Hierarchical category tree for organizing topics |
| `event-topics.manage` | Create, edit, and delete topics and categories |

## Dependencies

| Module | Required |
|---|---|
| `events` | Yes |
