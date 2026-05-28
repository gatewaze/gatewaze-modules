# Email Bot Detector: Signal-Based

Heuristic signal-based bot detection for email interactions. Identifies non-human email opens and clicks from Apple Mail Privacy Protection, corporate security scanners, link prefetchers, and automated crawlers.

## Why Bot Detection Matters

Email engagement metrics (open rates, click rates) are heavily polluted by non-human activity:

- **Apple Mail Privacy Protection** pre-fetches all images for Apple Mail users, generating fake "opens" for every delivered email
- **Corporate security scanners** (Barracuda, Mimecast, Proofpoint, etc.) click every link in an email before delivering it to the recipient
- **Gmail image proxy** caches and re-serves tracking pixels, obscuring real open times
- **Link prefetchers** in some email clients load URLs before the user clicks them

Without filtering, open rates can be inflated by 30-60% and click rates by 10-20%. This module scores each interaction for human likelihood so you can see both raw and filtered metrics.

## How It Works

Every open and click event is scored at webhook ingestion time. The detector evaluates multiple **signals** — each adds or subtracts from a base confidence score of 1.0. The final score is clamped to [0.0, 1.0]:

- **Score >= 0.3** — classified as human
- **Score < 0.3** — classified as bot (`is_bot = true`)

### Detection Signals

| Signal | Adjustment | What It Detects |
|--------|-----------|-----------------|
| Instant open (< 2s after delivery) | -0.70 | Image prefetchers (Apple MPP, Gmail proxy) |
| Fast open (< 5s after delivery) | -0.40 | Likely automated prefetch |
| Bulk clicks (3+ within 5s) | -0.80 | Security scanners clicking all links |
| Click before open | -0.60 | Link prefetching without image load |
| Apple MPP proxy IP | -0.50 | Apple Mail Privacy Protection |
| Known scanner user-agent | -0.90 | Barracuda, Mimecast, Proofpoint, etc. |
| Generic bot user-agent | -0.90 | User-agents containing "bot", "crawler", "spider" |
| Missing user-agent | -0.20 | Slightly suspicious but inconclusive |
| Known proxy IP range | -0.60 | Apple, Google proxy infrastructure |
| All links clicked | -0.70 | Exhaustive security scanning |
| Sequential click pattern | -0.40 | Clicks in perfect DOM order with uniform timing |
| Open then specific click (30s+) | **+0.30** | Strong human behavior pattern |
| Repeat human opener (3+ prior) | **+0.20** | Established engagement history |

Signals are additive. A single strong signal (e.g., known scanner at -0.90) is enough to flag as bot. Multiple weak signals can also accumulate past the threshold.

## Configuration

This module has no configuration settings. Install it and enable it — it will automatically score all incoming email interactions.

The Bulk Emailing module's `EMAIL_BOT_DETECTOR` setting controls which detector is active (defaults to `signals`, which is this module's ID).

## Viewing Results

### Per-Campaign

The `v_campaign_engagement` view provides both raw and filtered metrics:

- `raw_opens` / `raw_clicks` — all interactions including bots
- `human_opens` / `human_clicks` — bot-filtered
- `human_open_rate` / `human_click_rate` — percentages against delivered count

### Per-Recipient

The `v_recipient_engagement` view includes an `engagement_score` (0-100) based on the percentage of delivered emails with human interaction.

### Interaction Detail

Each interaction in `email_interactions` has:
- `human_confidence` — 0.0 to 1.0 score
- `is_bot` — boolean (true when confidence < 0.3)
- `bot_signals` — JSON array of detected signals with explanations
- `scorer_id` — identifier of which detector produced the score (`signals-v1`)

## Comparing Detectors

You can install multiple bot detector modules and compare their accuracy:

1. Install a second detector (e.g., a future `email-bot-detector-ml`)
2. The new detector can batch-rescore existing interactions
3. Scores from each detector are stored in `email_interaction_scores` with their `scorer_id`
4. Compare `human_confidence` distributions between detectors
5. Switch the active detector by changing `EMAIL_BOT_DETECTOR` in the Bulk Emailing config

The `email_interactions.human_confidence` column always reflects the **active** detector's score. The `email_interaction_scores` table preserves all scores for comparison.

## Known Proxy IP Ranges

The detector monitors these IP ranges:

| CIDR | Owner |
|------|-------|
| `17.0.0.0/8` | Apple (MPP, iCloud Private Relay) |
| `66.102.0.0/20` | Google Image Proxy |
| `66.249.64.0/19` | GoogleBot |
| `209.85.128.0/17` | Google infrastructure |

## Known Scanner User-Agents

Barracuda, Mimecast, Proofpoint, FortiGuard, Forcepoint, Zscaler, Symantec, FireEye, TrendMicro, Sophos, IronPort, MessageLabs, SpamHaus, Cloudmark, Microsoft Outlook (prefetch).

## Privacy

IP addresses and user-agents used for scoring are automatically anonymized (set to NULL) after 90 days by the Bulk Emailing module's scheduled cleanup job. The bot detection scores and signals are retained indefinitely for analytics.
