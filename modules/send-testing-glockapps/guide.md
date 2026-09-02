# Send Testing — GlockApps

Inbox-placement reporting for send tests. Optional add-on to `send-testing`.

## What this answers

The core `send-testing` module tells you whether the pipeline got through the
batch and how fast. It cannot tell you where the message **landed**, because
nothing inside the send pipeline can: a message can be delivered perfectly and
still sit in spam.

That needs an outside observer in real mailboxes at real providers, which is
what a GlockApps seed list is — roughly 70 mailboxes across Gmail, Outlook,
Yahoo, AOL and corporate providers, reporting Inbox / Tabs / Spam per provider.

This is a separate module because GlockApps is a paid subscription that most
installs will not have. The core module delivers its whole value without it.

## Two modes

| | Manual | API |
|---|---|---|
| Requires | Nothing | An API key whose plan allows API access |
| Seed addresses | Paste from the dashboard | Returned when a test is created |
| Results | Typed in from the dashboard | Polled every 10 minutes |

**Manual mode is the committed floor.** If the API rejects the key with 401/403,
polling stops rather than retrying forever, the run panel says so, and manual
entry stays available.

## How the GlockApps API actually works

Worth understanding, because it is not the shape you would guess.

- Base URL is `https://api.glockapps.com/gateway/spamtest-v2/api`, and auth is
  an **`x-api-key` header** — not a bearer token.
- Every endpoint is **project-scoped** (`/projects/{projectId}/...`). Set
  `project_id` in the module config; the status endpoint lists the projects the
  key can see.
- **There is no standing seed list to fetch.** Seed addresses belong to a test:
  `POST /projects/{id}/manualTest` returns the addresses to send to, a `testId`,
  and a correlation code (`insertHeader` / `insertInBody`).
- Results are read off the test row in `GET /projects/{id}/tests`: `stats`
  carries the whole-test totals (inbox / other / spam / notDelivered) and
  `inboxes` carries one row per seed mailbox, including per-seed SPF, DKIM and
  DMARC verdicts.

**The correlation code needs a human.** GlockApps uses it to match a message to
a test, and this module never sends, so it cannot insert it. Starting a test
shows the code in the run panel; paste it into the campaign before sending.

## Seed addresses

Import them from **Send Testing → Placement testing**, either by fetching from
the API or by pasting from the dashboard.

Seed lists **rotate**. Refresh before each run — a stale list silently measures
placement for mailboxes GlockApps is no longer watching.

Notes on how seeds are stored:

- They get **no timezone attribute**, so a timezone-aware send dispatches to them
  immediately instead of holding them for a local-time window. You want the
  placement answer now, not spread over 24 hours.
- They are marked `attributes.is_test`, so they stay out of the People
  dashboard alongside the synthetic population.
- They carry `acquisition_source = 'send_testing_glockapps'`, which keeps them
  independent of the synthetic people: refreshing seeds never disturbs the test
  population, and deleting the test population never removes the seeds.
- `contact_kind` is `member`, the same as the synthetic population. These are
  third-party **service mailboxes, not natural persons** — the classification
  exists only to pass send gates and asserts nothing about lawful basis, which
  the provenance markers record instead.

## Running a placement test

1. Open a run in the core module as usual.
2. In the **Inbox placement** panel on the run page, start a test (API mode) or
   paste the GlockApps test id (manual).
3. Send.
4. Results appear as GlockApps' seed mailboxes classify the message. This takes
   minutes to hours, not seconds — polling runs every 10 minutes and stops after
   24 hours.

**Keep the campaign's real subject line.** Artificial subject markers can change
how a provider classifies a message, which is exactly what is being measured
here. (For the synthetic population there is no spam filter anywhere in the
loop, so markers are harmless there — this constraint is specific to placement.)

## Reading the results

Per provider: how many seed mailboxes saw the message in the inbox, in a tab
(Promotions and similar), in spam, or not at all. A non-zero **spam** count at a
major provider before a 60k send is the signal this whole exercise exists to
surface.

Manual and API results share one table, keyed by run and provider. API results
overwrite manual ones for the same provider — the paste-in form is a fallback,
never a competing source of truth.
