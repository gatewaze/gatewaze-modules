# Event Budget

Budget management with categories, allocations, line items, suppliers, and revenue tracking for events. This module provides a comprehensive financial planning and tracking system embedded directly into your event management workflow.

## How It Works

The module injects a "Budget" tab into the event detail view where administrators can build and track budgets for each event. Budgets are organized by categories (which can be managed globally via a dedicated admin page), with support for allocations, individual line items, supplier tracking, and revenue recording. Reporting features allow you to review spending against planned budgets.

Admin pages:
- `/admin/budget-categories` -- Manage global budget categories

The budget tab on each event detail page provides the primary interface for working with event-specific budgets.

## Configuration

No configuration settings are required.

## Features

- `event-budget` -- Core budget functionality and event tab
- `event-budget.categories` -- Budget category management
- `event-budget.allocations` -- Budget allocation tracking
- `event-budget.line-items` -- Individual line item management
- `event-budget.suppliers` -- Supplier tracking and association
- `event-budget.revenue` -- Revenue recording and tracking
- `event-budget.reporting` -- Budget reports and analysis

## Dependencies

- `events` -- Requires the events module for event association
