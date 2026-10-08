# Approval notifications

Gate notifications can reuse the staging worker's existing Pushover account.
Set `SE_PUSHOVER_PROJECT_IDS` to a comma-separated allowlist of project UUIDs,
and `SE_ADMIN_ORIGIN` to the trusted HTTPS admin origin. Unlisted projects
never send Pushover notifications. Configure `SE_PUSHOVER_APP_TOKEN` and
`SE_PUSHOVER_USER_KEY`, or reuse existing `PUSHOVER_APP_TOKEN` and
`PUSHOVER_USER_KEY`. Keep credentials in deployment secrets, not Git.

Alerts cover specs, architecture approvals, manual PR submission and PRs
requiring human merge review. The supplementary **Review and approve** URL
opens the authenticated run page. Opening it never approves anything.
Notifications include the event, project and issue number; private specs,
reporter identities and health details stay off the phone notification.
Slack and Pushover delivery are independent, bounded and non-fatal.

The Studio currently runs a scoped, deduplicated compatibility service once
a minute for issues recorded in its HELF feedback checkpoint. It uses this
notification helper with the already configured worker credentials and does
not alter project gates. Once this event-driven helper is deployed in the
worker, retire the compatibility service to avoid duplicate notifications.
