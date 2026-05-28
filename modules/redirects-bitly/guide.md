# Redirect Adapter: Bitly

Bitly integration for creating and managing short links with click analytics. This adapter extends the Redirects module to use Bitly as a backend for generating and tracking short URLs.

## How It Works

When installed alongside the Redirects module, this adapter connects to the Bitly API to create short links. You can optionally configure a custom Bitly domain and target a specific Bitly group. All links created through this adapter benefit from Bitly's click analytics in addition to Gatewaze's built-in tracking.

## Configuration

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `BITLY_ACCESS_TOKEN` | secret | Yes | -- | Bitly access token |
| `BITLY_GROUP_GUID` | string | No | -- | Bitly group GUID (uses default group if not set) |
| `BITLY_DOMAIN` | string | No | `bit.ly` | Custom Bitly domain |

## Features

- `redirects-bitly` -- Bitly-powered short link creation and management

## Dependencies

- **redirects** -- Requires the Redirects base module
