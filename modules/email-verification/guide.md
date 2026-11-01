# Email Verification

This module checks every person's email address and keeps bad addresses out of broadcasts. It is for outreach to prospects, where a list from Apollo, a conference or a partner can hold addresses that bounce. Bounces and spam traps hurt the sending domain's reputation with Google and Microsoft.

## What it checks

Every address gets the same free checks, whatever list it came from:

- The address format.
- Misspelt big-provider domains, e.g. `gmial.com`. The result suggests the address meant.
- Disposable-address domains, from a short list in the code.
- No-reply addresses, which are invalid, and team addresses such as `info@` or `sales@`, which are risky.
- DNS: the domain exists, it takes mail (MX records, or an address record as a fallback), and it has no null MX. The MX records also say who runs the inbox: Google (including Google Workspace company domains), Microsoft, Yahoo, Apple or other. DNS results are cached per domain for 30 days.

A hard bounce reported by the SendGrid webhook also marks the address invalid. It counts only with an SMTP code that says the mailbox does not exist (5.1.1 and similar), or a SendGrid drop for "Bounced Address" or "Invalid". Blocks for spam or reputation are ignored, because they are about the sender and not the address, and so are send-path errors.

## Paid mailbox checks

The free checks cannot tell whether the mailbox itself exists. Paid services can, and each one is its own module with an id starting `email-verification-`, e.g. `email-verification-debounce`. Enable one and set its API key, and the worker uses it for every address that passes the free checks.

With more than one enabled:

- **Order and fallback.** Set `provider_order`, e.g. `debounce, kickbox`. The first provider that answers decides. A provider that rejects its key, runs out of credits or is rate-limited is skipped for the rest of the run.
- **Escalation.** Set `escalation_provider`. A catch-all or unknown answer goes to it, and its definite answer replaces the first one. Use a provider that is good at catch-all company domains.
- **Compare.** Set `compare_provider` and `compare_percent`. That share of addresses also goes to the compare provider. Its answers are stored but never change a result, so you can see where two providers disagree.

`daily_paid_limit` caps paid checks per day across all providers (default 500). A provider module can set its own `daily_limit` too. When the limit is reached, addresses get the free result for now and a mailbox check the next day. After turning a provider on, use **Give domain-level results a mailbox check** on the admin page to queue the addresses that only have the free result.

## Results

- `email_verifications` holds one row per address: status (valid, risky, invalid), reason, level (domain, mailbox or delivery), who decided, the inbox provider, and when to check again (default 180 days).
- The same result is copied onto the person as `attributes.email_check`, `email_check_reason`, `email_check_level` and `email_provider`, so segments can filter on it, e.g. prospects with `email_check` equal to `valid`.
- With `suppress_invalid` on (the default), invalid addresses are added to broadcast suppressions under the email topics (`broadcasts` and `plays`), so email broadcasts and plays skip them. Slack broadcasts are not affected, because a Slack message does not depend on the address. The module never removes a suppression by itself, because the same row can also stand for an unsubscribe. An admin can lift one from the lookup on the admin page (**Allow broadcasts again**), which removes only rows this module added.
- A hard bounce stays invalid. A later check does not overwrite it.
- `email_verification_provider_results` keeps every paid answer for the audit trail.

## Writing a provider module

A provider module needs an `index.ts` with its settings (mark the API key `type: 'secret', encrypted: true`) and a `provider.ts` whose default export matches `VerificationProvider` in `lib/types.ts`:

- `label` and `concurrency` (most calls at once).
- `isConfigured(ctx)`, true when it has an API key.
- `verify(email, ctx)`, which returns `{ status, reason, suggestion?, raw? }` or throws an error with a `kind` of `auth`, `credits`, `rate_limit`, `temporary` or `bad_response`.

Keep `provider.ts` free of imports so the worker can load it from any module repository. Never put the API key in an error message or in `raw`.

## Privacy

A paid provider receives the email addresses it checks, so it is a data processor. Check its data processing agreement before enabling it for a brand.
