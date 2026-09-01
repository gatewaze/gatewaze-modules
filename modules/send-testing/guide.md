# Send Testing

Rehearse a large send at close to real scale, then measure what actually
arrived.

This module answers the mechanical question — did every recipient get processed,
how long did the batch take, where did it stall. Inbox placement is a different
question and lives in the optional `send-testing-glockapps` add-on.

## The one thing to understand first

**This module does not send anything.** It creates synthetic recipients as
ordinary people rows on an ordinary list, and you point an existing sender at
that list. What gets tested is therefore the real pipeline — fan-out, drip
engine, per-recipient state, provider webhooks — rather than a parallel harness
that could behave differently on the day.

Three ways to use the list once it exists:

- A **broadcast** or **newsletter**, selecting *Bulk Send Testing* in its normal
  audience picker.
- An **external system** (LFX, another ESP): export the list as CSV and send to
  it from there.
- Anything else that can target a list.

## Setup

Nothing works until the inbound domain is configured. In module config:

| Setting | What it is |
|---|---|
| `inbound_domain` | A domain you control, e.g. `sendtest.example.org`. Every synthetic address lives here. |
| `inbound_token` | A secret embedded in the Inbound Parse URL. |
| `default_population_size` | Pre-filled target when provisioning. |
| `timezone_distribution` | JSON of IANA zone → relative weight. Optional. |
| `inspectable_count` | How many recipients keep message bodies (default 20). |
| `postmaster_url` / `snds_url` | Link-outs for ongoing reputation monitoring. |

Then:

1. Point the domain's **MX records** at SendGrid Inbound Parse.
2. Add an Inbound Parse binding for that host, targeting the `send-test-inbound`
   edge function, with the token in the URL:
   `https://<project>.supabase.co/functions/v1/send-test-inbound/<inbound_token>`
3. **Send one probe message** to `st-000001@<your domain>` and confirm it shows
   up, before provisioning 25,000 people. A wrong MX record bounces everything,
   which will trip the drip engine's bounce guard and halt the send — correct
   behaviour, but you want to discover it with one message, not 25,000.

On authentication: SendGrid Inbound Parse has **no request signing**. The signed
webhook mechanism is for the Event Webhook only. The URL token is therefore the
strongest authentication this endpoint can have — treat it as a secret, and do
not go looking for a signature header.

Why a dedicated domain rather than a subdomain of your sending domain: it keeps
the reputation of the test traffic separate. The trade-off is that SPF/DKIM
alignment differs slightly from the real send, so alignment is worth checking on
the real domain too.

## Choosing a domain that cannot reach a human

The safety property that makes "real people rows in the production database"
acceptable is that the test domain routes **only** to the parse webhook. A
mis-targeted send wastes a send; it cannot email a real person. Do not point the
domain at a real mailbox.

## Provisioning

*Provision test people* creates synthetic people up to a target total and
subscribes them to the list. It is a top-up: a smaller number does nothing, and
shrinking is a separate delete action.

Each person gets:

- `contact_kind = 'member'` — this is deliberate. `prospect` is excluded from
  broadcast sends by default, and a silently dropped recipient would corrupt the
  completion metric. Do not "fix" these to prospect.
- `acquisition_source = 'send_testing'` and `attributes.is_test = true` —
  provenance, and the marker the People admin filters on.
- A deterministic name and an `attributes.timezone` drawn from the configured
  distribution.

**Timezones are the point of that last one.** The broadcast and newsletter
fan-out reads `people.attributes->>'timezone'`, so a timezone-aware (`tz_local`)
send against this list exercises real per-zone scheduling, and the arrivals
chart shows the delivery waves. Zones must exist in `pg_timezone_names` or the
fan-out silently falls back to the send default.

Deletion is available from the module page: all of them, or shrink to a count
(highest sequence first, so surviving addresses stay stable). It is double
filtered on `acquisition_source` **and** the test domain, so it cannot touch a
real person under any argument.

## Running a test

1. **Start test run** from the module page. This snapshots the expected
   recipient count — people provisioned later will not change it, because the
   denominator has to match what the send actually targeted.
2. Send from wherever you like.
3. Watch arrivals land on the run page.
4. **Close the run.** This attributes the arrivals and computes the metrics.

### The broadcast trap

A broadcast's audience is **intersected** with its unsubscribe category list. If
you target *Bulk Send Testing* but leave the category list as something else,
the audience resolves to **zero recipients** and the run reports 0% — identical
to a pipeline that never ran. Set the category list to *Bulk Send Testing* too.

The run page warns about this: if nothing has been dispatched to a test address
ten minutes after opening, it says "No sends detected" rather than letting you
wait out a run that never fired.

### Why attribution happens after close

The receiver inserts arrivals with no run attached, and attribution runs
afterwards over the run's time window. Greylisting can delay a message by hours;
if the receiver stamped the currently-open run at ingest, a straggler from the
previous send would be counted against the next one.

Late arrivals are therefore normal. The run page shows how many unattributed
arrivals fall inside the window, and **Re-attribute & recompute** folds them in.
It is idempotent and safe to run repeatedly.

For back-to-back runs, set a **subject filter** when opening the run: attribution
then requires both the time window and a subject match. Every send already has a
distinctive subject, so this costs nothing. Note that for placement runs you must
keep the campaign's real subject — artificial markers can change how a provider
classifies the message.

## Reading the results

- **Completion** — distinct confirmed arrivals over the expected count. A
  duplicate delivery to one address is not extra completion.
- **Latency** — p50/p90/p99/max, from dispatch to arrival. Only available for
  platform sends; an external send has no send-side timestamps in this database,
  so latency reads as unavailable rather than as zero.
- **Arrivals over time** — the shape matters more than the numbers. Timezone
  waves should be visible; a flat gap is a stall no percentile would reveal.
- **Authentication results** — SPF/DKIM/DMARC pass rates read from what arrived.
  A cheap leading indicator: if DKIM fails here it will fail at Gmail too.

## Test inboxes and unsubscribe testing

The first `inspectable_count` recipients keep the delivered HTML. Their messages
can be opened from **Test inboxes**, and the links in them are real.

Clicking the unsubscribe link runs the genuine flow and **actually unsubscribes
that test person**. That is the feature. Consequences:

- The next run's expected count drops by one.
- Subscriptions are **not** silently restored. Automatic re-subscription would
  undo a deliberate unsubscribe test mid-verification, so it only happens during
  a provisioning job or when you press **Reset subscriptions**.

The module page shows how many test people are currently unsubscribed.

## Reputation monitoring

Google Postmaster Tools and Microsoft SNDS need **no test recipients at all** —
Postmaster is enabled by DNS-verifying the sending domain, SNDS by registering
the sending IPs. Both report on accumulated real traffic, so register before the
real send and treat them as ongoing monitors rather than per-test verdicts. The
module only stores link-outs.

## Operational notes

- Provisioning runs as a background job in chunks of 500. If it fails, re-post
  the same target: the underlying RPC is idempotent on email, so it resumes.
- The receiver returns 5xx on a database failure so SendGrid retries. A lost
  arrival would read as a pipeline failure, which is the wrong thing to be wrong
  about.
- Arrivals are deduplicated on `(recipient_email, message_id)`, with a
  deterministic synthetic key when a relay strips the Message-ID header.
- The module does not call `people_import_batch`. That RPC is gated on
  `is_admin()`, which reads `auth.uid()` and therefore always fails for a
  service-role worker. The module ships its own domain-guarded equivalents.
