# Ad Conversions

Ad platform conversion tracking for Meta (Facebook/Instagram) and Reddit campaigns. This integration module dispatches server-side conversion events to ad platform APIs when users complete registrations, competition entries, or discount code redemptions, enabling accurate ad attribution without relying solely on client-side pixels.

## How It Works

The module uses three Supabase Edge Functions organized in a dispatcher pattern:

1. **integrations-send-conversion** (dispatcher) -- The main entry point that receives a conversion trigger (registration ID, competition entry ID, or discount code ID), finds the relevant tracking session, determines which ad platforms are active, and dispatches to platform-specific functions in parallel.

2. **integrations-send-meta-conversion** -- Sends conversion events to Meta's Conversions API (CAPI). Builds user data payloads with hashed emails, Facebook click IDs (fbclid), browser cookies (_fbc, _fbp), IP address, and user agent. Supports both Lead and Purchase event types, with automatic Purchase detection when a payment amount is present.

3. **integrations-send-reddit-conversion** -- Sends conversion events to Reddit's Conversions API. Maps event names to Reddit tracking types (Lead, SignUp, Purchase, Custom), includes Reddit click IDs (rdt_cid) and UUID cookies, and supports test mode.

Tracking session matching uses a 3-tier approach:
- **Tier 1**: Direct session ID lookup (from form metadata or URL parameter)
- **Tier 2**: Email hash + event ID match
- **Tier 3**: Timing-based heuristic (recent session for the same event within 30 minutes, excluding redirected sessions)

Platform configuration is resolved in priority order: event-level config, account-level config, brand defaults, then environment variables. Conversions are only sent to platforms where the user has the platform's specific click ID, preventing false attributions. All conversion attempts are logged via RPC for audit purposes, and tracking sessions are updated with conversion status upon success.

## Configuration

This module has no admin-configurable settings in the config schema. Platform credentials are managed through the `ad_platform_configs` database table or environment variables:

| Setting | Description |
|---------|-------------|
| `META_PIXEL_ID` | Meta/Facebook Pixel ID (env var fallback) |
| `META_ACCESS_TOKEN` | Meta Conversions API access token (env var fallback) |
| `META_TEST_EVENT_CODE` | Optional Meta test event code for debugging |
| `REDDIT_PIXEL_ID` | Reddit Pixel ID (env var fallback) |
| `REDDIT_ACCESS_TOKEN` | Reddit Conversions API access token (env var fallback) |
| `REDDIT_TEST_MODE` | Enable Reddit test mode (`true`/`false`) |

## Features

- **ad-conversions** -- Core conversion dispatching and tracking session matching
- **ad-conversions.meta** -- Meta (Facebook/Instagram) Conversions API integration with SHA-256 hashed user data, deduplication via stable event IDs, and support for Lead and Purchase events
- **ad-conversions.reddit** -- Reddit Conversions API integration with click ID tracking, UUID cookies, and event type mapping
- Server-side conversion tracking (no client-side pixel dependency)
- 3-tier tracking session matching (direct ID, email hash, timing heuristic)
- Consent-aware platform filtering
- Idempotent conversion events with stable dedup IDs
- Conversion audit logging
- Support for registrations, competition entries, and discount code conversions

## Dependencies

- **events** -- Provides event and registration data
- **event-tracking** -- Provides tracking session infrastructure (`integrations_ad_tracking_sessions` table)
