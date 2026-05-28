# Newsletter Output: Substack

Generates simplified semantic HTML from Gatewaze newsletter editions, formatted for pasting into the Substack rich text editor. The output strips header, footer, and promotional blocks so the content integrates cleanly with Substack's own layout and branding.

## How It Works

When this module is enabled, newsletter editions gain an additional output option for Substack. The module takes the block-based content from a newsletter edition and renders it as clean, semantic HTML that is compatible with Substack's rich text editor. Header, footer, and promotional blocks are intentionally excluded since Substack provides its own versions of those elements.

The resulting HTML can be copied and pasted directly into Substack's editor without losing formatting or structure.

## Configuration

No configuration settings are required.

## Features

- `newsletters.output.substack` — Substack-compatible HTML output for newsletter editions

## Dependencies

- **newsletters** — Requires the newsletters module to be installed, since it operates on newsletter edition content.
