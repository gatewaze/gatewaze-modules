# Stripe Payments

Accept payments for events via Stripe. This integration module adds payment processing to your Gatewaze instance, with admin dashboards for managing customers, products, invoices, and transactions.

## How It Works

The Stripe Payments module integrates with the Stripe API to handle payment collection for events. It deploys edge functions to process Stripe webhooks, sync data between Stripe and Gatewaze, and create payment sessions for events. The admin interface provides dedicated pages for viewing customers, managing products, reviewing invoices, and tracking transactions. Stripe webhook events are verified using the webhook signing secret to ensure secure communication.

## Configuration

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `STRIPE_SECRET_KEY` | secret | Yes | -- | Stripe secret API key |
| `STRIPE_WEBHOOK_SECRET` | secret | Yes | -- | Stripe webhook signing secret |
| `STRIPE_PUBLISHABLE_KEY` | string | Yes | -- | Stripe publishable key for frontend checkout |

## Features

- `payments` -- Payment processing for events via Stripe

## Dependencies

None.
