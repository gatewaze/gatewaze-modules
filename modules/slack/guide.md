# Slack Integration

Send notifications, manage channels, and automate workflows via Slack. This integration module connects your Gatewaze instance to a Slack workspace, enabling automated messaging, channel management, and webhook-driven workflows.

## How It Works

The Slack Integration module uses a Slack Bot to send notifications, list channels, and handle OAuth callbacks. It deploys edge functions for channel listing, notification delivery, and OAuth flow. The admin interface provides a page for managing Slack invitations. Incoming webhook requests are verified using the Slack signing secret to ensure authenticity.

## Configuration

| Setting | Type | Required | Default | Description |
|---------|------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | secret | Yes | -- | Slack Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | secret | Yes | -- | Slack app signing secret for webhook verification |
| `SLACK_DEFAULT_CHANNEL` | string | No | -- | Default Slack channel for notifications |

## Features

- `slack` -- Core Slack integration
- `slack.notifications` -- Send automated notifications to Slack channels
- `slack.channels` -- List and manage Slack channels
- `slack.webhooks` -- Receive and process incoming Slack webhooks

## Dependencies

None.
