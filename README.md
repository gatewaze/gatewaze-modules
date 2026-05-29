<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/gatewaze-logo-white.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/gatewaze-logo-black.svg">
    <img alt="Gatewaze" src="docs/assets/gatewaze-logo-black.svg" width="300">
  </picture>
</p>

<p align="center">
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License"></a>
</p>

**Open-source modules for [Gatewaze](https://github.com/gatewaze/gatewaze).**

This repository contains the official open-source module collection for the Gatewaze platform. Modules are self-contained packages that extend Gatewaze with additional capabilities: database migrations, admin UI pages, API routes, portal components, and background jobs.

---

## Highlights

- **Each module is a mini-application**: a module can ship its own admin UI, API routes, background jobs, database migrations, and public-facing portal pages out of the box. The platform auto-discovers modules from the workspace, and each can be enabled or disabled independently.
- **Build a module for anything**: start from the `_template`, add your tables, admin pages, and portal, and it goes live. The 76 pre-built modules below cover common community needs; your own modules cover the rest.
- **Run AI in production, in-house**: the `ai` module is a self-hosted AI runtime with one provider router (OpenAI, Anthropic, Gemini), an embeddable chat widget, per-user and per-use-case credentials, model allow-lists, and a per-call cost ledger. Pair it with `cost-governance` for hard budget caps.
- **Bring your own agent**: author a [Goose](https://github.com/aaif-goose/goose) recipe locally and run it unchanged in production. Gatewaze runs the Goose CLI server-side, with no rewrite and no local-to-cloud translation.
- **MCP server library**: bundled MCP servers expose your platform to agents, including platform data (events, speakers, sponsors, health), a whitelisted API proxy, and a headless browser (local Chromium or Browserbase).
- **Automation and integrations**: governed web fetch (`gatewaze-fetch`) and scrapers backed by a fetch service with eight swappable residential-proxy providers, plus integrations for Cloudflare Pages, Netlify, Luma, Slack, Twilio SMS/WhatsApp, SendGrid, Customer.io, Google Sheets, BigQuery, Stripe, Beehiiv, Substack, Browserbase, Umami, and more.

---

## Available Modules

The collection ships **76 modules** spanning events, content, people, sites, marketing, communications, integrations, and platform infrastructure. Every module is self-contained: install only what you need; the platform discovers them automatically from the workspace.

### Events

| Module | Description |
|--------|-------------|
| **events** | Core event management: registrations, attendance tracking, and check-in. Foundational module others build on. |
| **calendars** | Curated collections of events with discovery, CSV import, scheduling APIs, and per-calendar permissions |
| **event-agenda** | Sessions, time slots, and tracks with speaker assignments |
| **event-speakers** | Speaker profiles, talk submissions, and cross-event speaker management |
| **event-sponsors** | Sponsor profiles, tiers, booth assignments, and sponsor team management |
| **event-media** | Photo and video galleries, uploads, and album management |
| **event-budget** | Budgets, allocations, line items, suppliers, and revenue tracking |
| **event-reports** | Analytics dashboards, attendance reports, and post-event summaries |
| **event-topics** | Hierarchical topic taxonomy for organizing and tagging events |
| **event-tracking** | UTM tracking, referral links, and conversion attribution |
| **event-interest** | Capture expressions of interest before registration opens |
| **event-invites** | Grouped RSVP invites with short links, QR codes, and multi-channel delivery |
| **attendee-matching** | AI-powered 1:1 networking introductions between registrants |
| **badge-scanning** | Badge printing, QR code scanning, and on-site contact exchange |
| **kiosk** | On-site kiosk for searching and updating registrant info |
| **virtual-events** | Live virtual events with YouTube streaming and real-time chat |
| **luma** | Sync events and registrations from Luma (lu.ma) |
| **cvent** | Sync registrations and admission items from Cvent |

### Content

| Module | Description |
|--------|-------------|
| **content-platform** | Cross-content publishing, categorization, source tracking, and the unified Content Inbox |
| **content-hub** | Unified tabbed admin shell that gathers content modules into one place |
| **content-triage** | Human-review gate and queue for scraped and submitted content |
| **content-keywords** | Platform-wide keyword visibility rules applied retroactively to all content |
| **blog** | Blog posts, categories, SEO/social metadata, and a public reader portal |
| **newsletters** | Edition management, template collections, and subscriber tracking |
| **newsletters-output-beehiiv** | Export edition HTML for pasting into Beehiiv |
| **newsletters-output-substack** | Export edition HTML for pasting into Substack |
| **structured-resources** | Hierarchical resource guides with templated sections and access control |
| **lists** | Subscription lists with subscribe/unsubscribe flows and external sync |
| **host-media** | Shared polymorphic media management consumed by content-bearing modules |

### People & Community

| Module | Description |
|--------|-------------|
| **accounts** | Organizations and companies with role-based user assignments |
| **segments** | Audience segments for targeted communications and analytics |
| **engagement** | Engagement tracking, badges, and leaderboards |
| **cohorts** | Cohort-based learning programs with sessions, enrollments, and instructors |
| **conversations** | Direct messages, channels, and real-time chat |
| **people-enrichment** | Enrich people records via Clearbit / EnrichLayer |
| **people-warehouse** | Bi-directional people sync with Customer.io |

### Sites & Web

| Module | Description |
|--------|-------------|
| **sites** | Multi-site web builder with drafts, A/B experiments, and multiple publishing targets |
| **site-runtime** | React helper that surfaces analytics + A/B into rendered operator themes |
| **templates** | Block/wrapper authoring system: parser, content forms, A/B engine, version pinning |
| **custom-domains** | White-label custom domains with automatic DNS verification and HTTPS |
| **redirects** | URL redirects and short links with click tracking |
| **redirects-bitly** | Bitly backend adapter for the Redirects module |
| **redirects-shortio** | Short.io backend adapter for the Redirects module |
| **sites-publisher-cloudflare-pages** | Publish built sites to Cloudflare Pages |
| **sites-publisher-netlify** | Publish built sites to Netlify |
| **bunny-cdn** | Optimized image delivery via Bunny.net CDN pull zones |

### Marketing

| Module | Description |
|--------|-------------|
| **forms** | Custom forms with portal pages, API submission, and embeds |
| **surveys** | Surveys with response collection and analysis |
| **competitions** | Competitions with entry submissions, judging, and winner selection |
| **discounts** | Discount code creation, distribution, and tracking |
| **offers** | Offers with acceptance tracking and conversion analytics |
| **ad-conversions** | Server-side conversion tracking for Meta and Reddit campaigns |

### Communications

| Module | Description |
|--------|-------------|
| **bulk-emailing** | Transactional and bulk email with lifecycle tracking and bot-filtered analytics |
| **email-provider-sendgrid** | SendGrid delivery provider for the Bulk Emailing module |
| **email-bot-detector-signals** | Heuristic detection of non-human email opens and clicks |
| **slack** | Slack notifications, channel management, and workflows |
| **twilio-sms** | SMS via Twilio |
| **whatsapp** | WhatsApp messaging via the Twilio Business API |

### Integrations

| Module | Description |
|--------|-------------|
| **customerio** | Customer.io CRM contact sync, event tracking, and webhooks |
| **google-sheets** | Sync registration and speaker data to Google Sheets |
| **gradual** | Sync registrations and attendance with the Gradual platform |
| **bigquery** | Secure proxy for BigQuery queries, schemas, and materialized views |
| **prefect** | Self-hosted Prefect server + Python worker for pipeline flows |

### Platform & Infrastructure

| Module | Description |
|--------|-------------|
| **ai** | Unified AI infrastructure: provider router, credential resolution, cost ledger, and chat widget |
| **compliance** | GDPR/CCPA/SOC 2 tooling: consent, privacy requests, breach tracking, and audit logging |
| **cost-governance** | Cost ledger and per-brand budgets for paid external APIs |
| **environments** | Sync database rows, edge functions, storage, and auth config across Supabase environments |
| **scrapers** | Configurable web scraping jobs for event and content discovery |
| **scheduler** | Job queue and scraper scheduler management dashboard |
| **gatewaze-fetch** | External web fetch/extraction over REST/MCP with quotas and audit logging |
| **webhooks** | Mutation-driven outbound webhooks with signed delivery and CDN purge |

### Analytics, Commerce, Productivity & Editor

| Module | Description |
|--------|-------------|
| **analytics** | First-party, self-hosted analytics backed by Umami |
| **monitoring** | Prometheus + Grafana observability for the platform cluster |
| **stripe-payments** | Accept event payments via Stripe |
| **tasks** | Asana-style task management with cross-module linking and recurrence |
| **editor-ai-copilot** | AI copilot pane for the Puck-based canvas editor |

> Each module ships a `guide.md` (rendered on the in-app modules dashboard) with full setup and behaviour details.

## Installation

This repository is designed to sit alongside the main Gatewaze repository:

```
parent-directory/
  gatewaze/                # Core platform
  gatewaze-modules/        # This repo: open-source modules
```

The core platform's `pnpm-workspace.yaml` already references `../gatewaze-modules/modules/*`, so modules are automatically available after cloning.

```bash
git clone https://github.com/gatewaze/gatewaze-modules.git
cd gatewaze-modules
pnpm install
```

## Creating a Module

Use the `_template` directory as a starting point:

```bash
cp -r modules/_template modules/my-feature
```

Then update the module to fit your needs:

1. **`package.json`**: Set the module name, description, and any dependencies.
2. **`index.ts`**: Define the module's ID, features, routes, nav items, migrations, and lifecycle hooks.
3. **`migrations/`**: Add SQL migration files for your module's database schema.
4. **`admin/`**: Add React components for the admin interface.

### Module Structure

```
modules/my-feature/
  package.json          # Module package metadata
  tsconfig.json         # TypeScript configuration
  index.ts              # Module definition (routes, nav, migrations, config)
  admin/                # Admin UI components (React)
    pages/
      MyPage.tsx
  migrations/           # SQL migrations (applied in order)
    001_create_tables.sql
```

### Module Definition

Every module exports a `GatewazeModule` object from `index.ts`:

```typescript
import type { GatewazeModule } from '@gatewaze/shared';

const myModule: GatewazeModule = {
  id: 'my-feature',
  type: 'feature',
  visibility: 'public',
  name: 'My Feature',
  description: 'A short description of what this module does',
  version: '1.0.0',

  features: ['my-feature'],

  dependencies: [],

  migrations: [
    'migrations/001_create_tables.sql',
  ],

  adminRoutes: [
    {
      path: 'my-feature',
      component: () => import('./admin/pages/MyPage'),
      requiredFeature: 'my-feature',
      guard: 'admin',
    },
  ],

  adminNavItems: [
    {
      path: '/admin/my-feature',
      label: 'My Feature',
      icon: 'Puzzle',
      requiredFeature: 'my-feature',
      parentGroup: 'dashboards',
      order: 100,
    },
  ],

  configSchema: {},

  onInstall: async () => {
    console.log('[my-feature] Module installed');
  },

  onEnable: async () => {
    console.log('[my-feature] Module enabled');
  },

  onDisable: async () => {
    console.log('[my-feature] Module disabled');
  },
};

export default myModule;
```

### What Modules Can Provide

- **Database migrations**: SQL files that create tables, indexes, RLS policies, and functions.
- **Admin routes**: React pages added to the admin dashboard.
- **Admin navigation**: Sidebar items linking to your admin pages.
- **Portal navigation**: Links added to the public-facing portal.
- **API routes**: Express routes registered with the API server.
- **Edge functions**: Supabase Edge Functions (Deno).
- **Configuration**: Schema-defined settings that admins can configure.
- **Lifecycle hooks**: Code that runs on install, enable, or disable.

For full documentation on the module system, see the [Module System Guide](https://github.com/gatewaze/gatewaze/blob/main/docs/modules.md) in the core repository.

## Development

```bash
# Type check all modules
pnpm typecheck

# Build all modules
pnpm build
```

## Project Structure

```
gatewaze-modules/
  modules/
    _template/        # Starting point for new modules
    events/           # Core events management
    sites/            # Multi-site web builder
    newsletters/      # Newsletter authoring + distribution
    ...               # 76 modules in total (see "Available Modules")
    <module>/
      package.json    # Module package metadata (@gatewaze-modules/<name>)
      index.ts        # Module definition (routes, nav, migrations, config)
      guide.md        # In-app module guide (shown on the modules dashboard)
      migrations/     # SQL migrations (applied in order)
      admin/          # Admin UI components (React)
  package.json        # Root package configuration
  pnpm-workspace.yaml # Monorepo workspace definition
  tsconfig.base.json  # Shared TypeScript configuration
  docs/
    assets/           # Logo files
```

## Contributing

We welcome contributions! Please read the [Contributing Guide](./CONTRIBUTING.md) before getting started.

Key points:

- You must sign the [Contributor License Agreement](./CLA.md) before your first PR is merged.
- Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.
- All code must be written in TypeScript and pass linting and type checking.

## License

Gatewaze Modules is licensed under the [Apache License 2.0](./LICENSE).

```
Copyright 2026 Gatewaze Contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

See [NOTICE](./NOTICE) for third-party attributions and [TRADEMARK.md](./TRADEMARK.md) for trademark usage policy.
