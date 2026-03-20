# Gatewaze Modules

Closed-source, commercially licensed modules for [Gatewaze](https://github.com/gatewaze/gatewaze).

For premium modules, see [premium-gatewaze-modules](https://github.com/gatewaze/premium-gatewaze-modules).

## Available Modules

| Module | Description |
|--------|-------------|
| `@gatewaze-modules/badge-scanning` | Badge printing, QR code scanning, and contact exchange for events |
| `@gatewaze-modules/blog` | Blog posts, categories, and content management |
| `@gatewaze-modules/bulk-emailing` | Ad-hoc bulk email sending to segments and contact lists |
| `@gatewaze-modules/calendars` | Calendar management for event scheduling and discovery |
| `@gatewaze-modules/compliance` | GDPR, SOC 2, and audit logging tools |
| `@gatewaze-modules/environments` | Push and pull content between Supabase environments |
| `@gatewaze-modules/event-agenda` | Event agenda sessions, time slots, and track management |
| `@gatewaze-modules/event-interest` | Event interest tracking |
| `@gatewaze-modules/event-invites` | Event invitation system with unique RSVP links and tracking |
| `@gatewaze-modules/event-media` | Photo and video galleries, media uploads, and album management |
| `@gatewaze-modules/event-speakers` | Speaker profiles, bios, and session assignments |
| `@gatewaze-modules/event-sponsors` | Sponsor profiles, tiers, booth assignments, and team management |
| `@gatewaze-modules/event-topics` | Event topic taxonomy with hierarchical categories |
| `@gatewaze-modules/google-sheets` | Google Sheets integration for data sync and notifications |
| `@gatewaze-modules/luma-integration` | Luma event platform integration for registrations and webhooks |
| `@gatewaze-modules/scheduler` | Event scheduling |
| `@gatewaze-modules/scrapers` | Web scraping jobs for event and content discovery |
| `@gatewaze-modules/slack-integration` | Slack notifications and bot integration |
| `@gatewaze-modules/stripe-payments` | Accept payments for events via Stripe |

## Usage

1. Obtain a license at [gatewaze.com](https://gatewaze.com) or contact sales@gatewaze.com.
2. Install the module into your Gatewaze instance.
3. Add the module to `gatewaze.config.ts`:

```typescript
modules: ['@gatewaze-modules/stripe-payments'],
```

4. Restart your instance.

## Documentation

See the main [Gatewaze repository](https://github.com/gatewaze/gatewaze) for full documentation, deployment guides, and architecture details.

## License

Proprietary. See [LICENSE](./LICENSE) for details.
