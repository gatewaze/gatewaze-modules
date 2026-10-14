# Email Reputation

This module shows the open rate of every newsletter and broadcast send at each mailbox provider, and raises an alert when one provider falls far below the others.

## Why

A provider can accept mail and then file it as spam. Delivery numbers stay normal, so nothing looks wrong. The open rate at that provider is the sign. In August 2026 Gmail opens of the AAIF User Community newsletter fell from about 40% to about 2% when it moved to a new sending domain, while other providers stayed near 30%.

## What it does

- Every 30 minutes a worker counts delivered, opened and clicked messages for each send by mailbox provider. It works out the provider from each recipient domain's MX records, so company addresses on Google Workspace count as Google.
- A day after a send, it compares each provider's open rate with the other providers. If a provider with at least 500 delivered messages opens less than a third as often as the others, it records an alert. It can also post the alert to Slack.
- The admin page shows a chart of open rate per send for each provider, a table of the numbers, and the open alerts.

It never changes who receives a send.

## Settings

- Slack webhook for alerts. Optional. Must be a `https://hooks.slack.com/services/...` address.
- Alert threshold, minimum delivered messages and minimum open rate at other providers. The defaults are 0.33, 500 and 0.10.
- Days of past sends to measure on first install. The default is 120.

See `spec-email-reputation-module.md` in the roadmap repo for the later phases.
