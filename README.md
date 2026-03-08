# Gatewaze Modules

Closed-source, commercially licensed modules for [Gatewaze](https://github.com/gatewaze/gatewaze).

## Available Modules

| Module | Description |
|--------|-------------|
| `@gatewaze-modules/stripe-payments` | Accept payments for events via Stripe |
| `@gatewaze-modules/customerio` | Customer.io integration for marketing automation |
| `@gatewaze-modules/slack-integration` | Slack notifications and bot integration |
| `@gatewaze-modules/ai-search` | AI-powered semantic search across events and content |
| `@gatewaze-modules/compliance` | GDPR, SOC 2, and audit logging tools |
| `@gatewaze-modules/newsletters` | Newsletter creation and distribution |

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
