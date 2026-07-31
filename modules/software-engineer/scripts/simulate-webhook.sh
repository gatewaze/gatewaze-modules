#!/usr/bin/env bash
# Simulate a GitHub "issue labelled agent:build" webhook delivery to the LOCAL software-engineer
# endpoint — so you can test without exposing localhost to GitHub. Signs the payload with HMAC
# exactly as GitHub does.
#
# Usage:
#   WEBHOOK_SECRET='...' ./simulate-webhook.sh <owner> <repo> <issue_number> [sender_login] [api_url]
#
#   WEBHOOK_SECRET  the module's github_webhook_secret (set in the module config / SE deployment)
#   owner/repo      your REAL test repo (must have CLAUDE.md committed, and the issue must exist)
#   sender_login    the GitHub login applying the label (must be in the brand's allowed_labellers,
#                   or leave allowed_labellers empty); defaults to <owner>
#   api_url         defaults to http://localhost:3002
set -euo pipefail

OWNER="${1:?owner}"; REPO="${2:?repo}"; ISSUE="${3:?issue number}"
SENDER="${4:-$OWNER}"; API="${5:-http://localhost:3002}"
: "${WEBHOOK_SECRET:?set WEBHOOK_SECRET to the module github_webhook_secret}"

# Minimal payload — only the fields the webhook consumes (spec §9).
PAYLOAD=$(printf '{"action":"labeled","label":{"name":"agent:build"},"issue":{"number":%s,"node_id":"I_local_test","title":"Local test issue #%s","body":"Make a small, well-documented change per the repo rules."},"repository":{"name":"%s","owner":{"login":"%s"}},"sender":{"login":"%s"}}' \
  "$ISSUE" "$ISSUE" "$REPO" "$OWNER" "$SENDER")

SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | sed 's/^.*= *//')"

echo "POST ${API}/api/modules/software-engineer/internal/webhook"
curl -sS -D - -X POST "${API}/api/modules/software-engineer/internal/webhook" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issues" \
  -H "X-GitHub-Delivery: local-test-$$" \
  -H "X-Hub-Signature-256: ${SIG}" \
  --data-binary "$PAYLOAD"
echo
