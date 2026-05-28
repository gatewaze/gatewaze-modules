# Segments

Create and manage audience segments for targeted communications and analytics. This module lets you define groups of people based on shared attributes or behaviors, then use those segments across other modules for filtering, targeting, and reporting.

## How It Works

The Segments module provides a full CRUD interface for audience segments. You can create segments, view their membership, and edit segment criteria from the admin panel. Segments are stored in dedicated database tables and can be referenced by other modules (such as newsletters or people warehouse) to target specific audiences. The admin routes are accessible without the admin guard, making them available to a broader set of users.

## Configuration

This module has no additional configuration settings.

## Features

- `segments` -- Core segmentation functionality
- `segments.create` -- Create new audience segments
- `segments.manage` -- View, edit, and delete segments

## Dependencies

None.
