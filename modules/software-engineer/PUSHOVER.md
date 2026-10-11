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

## Single-use approval review

The Studio compatibility notifier can mint scoped links with `mintApprovalLink` for the configured active admin/approver. Each grant binds a run, approval stage, exact review artifact or PR heads, actor, HTTPS origin and 24-hour expiry. Tokens are random 256-bit capabilities stored as hashed Redis keys. Only trusted server-side code can mint them; no public mint endpoint exists.

`/api/modules/software-engineer/internal/approval#TOKEN` presents a read-only review page without account login. The fragment never enters HTTP URLs/access logs. Browser code removes it from visible history and sends it only in JSON request bodies. The page has no external assets, a fixed-script CSP, no-store and no-referrer. Untrusted artifact text uses textContent.

Approval needs an explicit button, review nonce and matching Origin. Active admin/project approver rights and task revision are rechecked, then an atomic Redis compare/delete permits one action. Task transitions use CAS. Merges retain GitHub clean/protection checks and send the reviewed SHA in the merge request. Invalid, revoked, used, expired or stale grants fail closed. A link holder can approve its one step; do not forward links. Opening links does not approve.

The legacy module host may supply Redis asynchronously; approval routes await that adapter. If omitted, they use the host's existing ioredis queue dependency and REDIS_URL. Credential values and tokens are not logged. Actual review was verified anonymously on Studio; the test grant was revoked without approving a run.
