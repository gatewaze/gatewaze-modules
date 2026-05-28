# Redirect Adapter: Short.io

Short.io integration for creating and managing short links. This adapter extends the Redirects module to use Short.io as a backend, providing bulk link creation, click analytics, and domain management.

## How It Works

When installed alongside the Redirects module, this adapter connects to the Short.io API to create and manage short links under your custom domain. Short.io supports bulk link creation, making it well-suited for high-volume use cases like newsletter link wrapping.

## Configuration

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `SHORTIO_API_KEY` | secret | Yes | -- | Short.io API key |
| `SHORTIO_DOMAIN` | string | Yes | -- | Short.io custom domain (e.g., `go.example.com`) |

## Features

- `redirects-shortio` -- Short.io-powered short link creation and management

## Dependencies

- **redirects** -- Requires the Redirects base module
