# Content

A single admin navigation entry that gathers everything content-related into one tabbed shell. The hub itself ships no content features — it provides the shared frame and lets other content modules contribute sub-tabs through the platform's slot system, so each tab only appears if its contributing module is installed and enabled.

## How It Works

The hub mounts one nav item (`/admin/content`) and a `ContentShell` page. The shell defines a fixed set of top-level sections that map to stable information-architecture concepts:

| Section | Slot name | What it represents |
|---|---|---|
| Library | `content-hub:library` | What we have |
| Rules | `content-hub:rules` | How we govern it |
| Sources | `content-hub:sources` | Where it comes from |

These sections are deliberately fixed in the shell. The sub-tabs within each section are dynamic: any module can register an `adminSlots` entry against a `content-hub:<section>` slot, supplying `meta` with a `tabId`, `label`, and optional `description`. `ContentShell` reads the resolved slots via the `useModuleSlots` hook, sorts them by `order`, and renders them as sub-tabs. Each tab's component is lazy-loaded.

For example, the content-keywords module contributes "Keywords" and "Keyword Preview" tabs into `content-hub:rules`, and content-triage contributes a "Triage Routes" tab into the same section.

Routing follows `/admin/content/:section/:tab`, with redirects filling in sensible defaults (the Library section and the first available sub-tab). If a section has no contributing modules, the shell renders a placeholder telling the operator to install or enable a module that registers that slot.

> Note: an `Inbox` section once existed here but was superseded by the unified `/admin/inbox` page in the content-platform module, so it has been removed from the shell.

## Configuration

This module has no configurable settings (`configSchema` is empty).

## Features

- `content-hub` — The unified content admin shell and its slot-driven section/sub-tab framework.

## Dependencies

None. The hub has no hard dependencies by design — each tab is contributed via slots and only appears if the contributing module is installed and enabled.
