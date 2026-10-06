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

## Invitation worker

The invitation queue (`integrations_slack_invitation_queue`) is drained by a
browser worker that drives Slack's "Invite people" dialog with an admin
account's saved session. It runs inside the platform worker and only starts
when both `SLACK_WORKSPACE_URL` and `SLACK_ADMIN_EMAIL` are set.

| Env var | Required | Description |
|---------|----------|-------------|
| `SLACK_WORKSPACE_URL` | Yes | Workspace URL, e.g. `https://example.slack.com`. Must match the captured session. |
| `SLACK_ADMIN_EMAIL` | Yes | Admin account the session belongs to. |
| `SLACK_SESSION_PATH` | No | Where the session cookie file lives. Defaults to `data/slack-session.json` inside the module. |
| `SLACK_SESSION_SECRET_B64` | No | Base64 of a captured session file. Written to `SLACK_SESSION_PATH` on first run when no file exists there (ephemeral filesystems). Keep it in the sops-encrypted brand values. |
| `SLACK_SKIP_SESSION_VALIDATION` | No | `true` trusts the saved cookies without a pre-flight navigation. |
| `SLACK_TEAM_ID` | No | Pins the `app.slack.com/client/<id>` URL; otherwise the workspace URL redirect is followed. |
| `SLACK_PROXY_URL` | No | Egress proxy fallback. The `residential-egress` module config is preferred when installed. |

Slack sign-in is passwordless, so a session cannot be created unattended:
capture it once from a real browser and ship it with `SLACK_SESSION_SECRET_B64`.

## Features

- `slack` -- Core Slack integration
- `slack.notifications` -- Send automated notifications to Slack channels
- `slack.channels` -- List and manage Slack channels
- `slack.webhooks` -- Receive and process incoming Slack webhooks

## Dependencies

None.
