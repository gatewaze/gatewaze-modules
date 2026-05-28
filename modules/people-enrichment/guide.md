# People Enrichment

Automatically enrich people records with professional and company data using third-party providers like Clearbit and EnrichLayer. The module supports both automatic enrichment on record creation and manual on-demand enrichment.

## How It Works

The module runs an edge function (`people-enrichment`) that queries configured enrichment providers to fill in professional details, company information, and social profiles for people in your database. It supports two modes:

- **Initial mode** — Performs lightweight enrichment, primarily resolving LinkedIn URLs.
- **Full mode** — Queries all configured providers for comprehensive professional and company data.

When `AUTO_ENRICH_ON_CREATE` is enabled (the default), new people records are automatically enriched as soon as they are created. Enrichment can also be triggered manually for existing records.

The module works with multiple providers and will use whichever API keys are configured. You can use Clearbit, EnrichLayer, or both.

## Configuration

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `CLEARBIT_API_KEY` | secret | No | — | Clearbit API key for person and company enrichment |
| `ENRICHLAYER_API_KEY` | secret | No | — | EnrichLayer API key for LinkedIn-based enrichment |
| `AUTO_ENRICH_ON_CREATE` | boolean | No | `true` | Automatically enrich new people when they are created |
| `ENRICHMENT_MODE` | string | No | `full` | Enrichment mode: `initial` (LinkedIn URL only) or `full` (all providers) |

## Features

- `people-enrichment` — Core enrichment functionality
- `people-enrichment.auto` — Automatic enrichment of new people records on creation
- `people-enrichment.manual` — On-demand enrichment of existing people records

## Dependencies

None. This is a standalone integration module. At least one enrichment provider API key (Clearbit or EnrichLayer) should be configured for the module to be useful.
