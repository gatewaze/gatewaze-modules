# Lists Module & Newsletter Types — Technical Specification

**Status:** Final (adversarial review: 1 round, GPT-4o + Claude Opus 4.6)

## 1. Overview

1. **Lists Module** (`lists`) — New module for managing subscription lists with subscribe/unsubscribe flows and webhook notifications
2. **Newsletter Types** — Extending newsletters to support multiple newsletter types, each tied to a template collection and subscription list

## 2. Database Schema

### 2.1 Lists Module Tables

**`lists`** — subscription list definitions
- `id` uuid PK, `slug` text UNIQUE, `name` text, `description` text
- `is_active` boolean, `is_public` boolean (portal visibility), `default_subscribed` boolean
- `webhook_url` text, `webhook_secret` text, `webhook_events` text[]
- `metadata` jsonb, timestamps

**`list_subscriptions`** — per-person subscriptions
- `id` uuid PK, `list_id` uuid FK lists, `person_id` uuid FK people (nullable)
- `email` text, `subscribed` boolean, `subscribed_at`, `unsubscribed_at`
- `source` text (manual/portal/api/webhook/import), `metadata` jsonb
- UNIQUE(list_id, email)

**`list_webhook_logs`** — webhook delivery tracking
- `id` uuid PK, `list_id` uuid FK, `event_type` text, `email` text
- `status` text, `response_code` int, `response_body` text, `error_message` text

### 2.2 Newsletter Type Extension

Add to `newsletters_template_collections`:
- `list_id` uuid FK lists — links newsletter type to subscription list
- `from_name` text, `from_email` text, `reply_to` text — sender identity

## 3. API Endpoints

- `GET/POST/PATCH/DELETE /api/lists` — CRUD (admin)
- `POST /api/lists/:id/subscribe` — subscribe email
- `POST /api/lists/:id/unsubscribe` — unsubscribe email
- `POST /api/lists/unsubscribe-all` — unsubscribe from all
- `GET /api/lists/subscriptions/:email` — get subscriptions
- `POST /api/lists/:id/import` — bulk import (admin)

Webhooks: POST to configured URL with HMAC-SHA256 signature, retry 3x with backoff.

## 4. Admin UI

- Lists management page in Settings with CRUD, webhook config, subscriber view
- Newsletter EditorTab grouped by newsletter type with subscriber counts
- People detail page updated to use lists module

## 5. Files

### New: `premium-gatewaze-modules/modules/lists/`
- `index.ts`, `api.ts`, migrations, admin pages, utils, types

### Modified: `newsletters/`
- Migration 006: add list_id, from_name, from_email to collections
- EditorTab: group editions by newsletter type
