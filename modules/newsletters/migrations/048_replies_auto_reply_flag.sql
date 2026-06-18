-- ============================================================================
-- Module: newsletters
-- Migration: 048_replies_auto_reply_flag
-- Description: Mark inbound replies that look like auto-replies (OOO, bounces,
-- vacation responders) so the admin replies tab can hide them by default
-- without losing the data.
--
-- The classifier runs in the email-inbound-parse Edge Function (uses the raw
-- SendGrid headers blob the handler already receives — we just never read
-- anything other than In-Reply-To from it before). Detection cascade:
--   1. Auto-Submitted: <not 'no'>            ← RFC 3834, the canonical signal
--   2. X-Auto-Response-Suppress present      ← Exchange
--   3. Precedence: bulk|auto_reply|junk      ← older but still common
--   4. X-Autoreply / X-Autorespond           ← Lotus / qmail / cPanel
--   5. Return-Path: <>                       ← DSN / bounce
--   6. Subject ~ /^(Out of Office|Automatic reply|Auto-?Reply|Vacation|On leave)/i
--   7. From mailer-daemon@ / postmaster@     ← bounce from misconfigured systems
--
-- The reason string lets us audit misclassifications later — e.g. find replies
-- where the operator manually marked is_auto_reply=false to refine the rules.
-- Existing rows default to false; we don't try to retro-classify (we never
-- stored full headers, so we can't).
-- ============================================================================

ALTER TABLE public.newsletter_replies
  ADD COLUMN IF NOT EXISTS is_auto_reply boolean NOT NULL DEFAULT false;

ALTER TABLE public.newsletter_replies
  ADD COLUMN IF NOT EXISTS auto_reply_reason text;

CREATE INDEX IF NOT EXISTS idx_newsletter_replies_human
  ON public.newsletter_replies (collection_id, created_at DESC)
  WHERE is_auto_reply = false;

COMMENT ON COLUMN public.newsletter_replies.is_auto_reply IS
  'true when the email-inbound-parse classifier flagged this as an OOO / vacation responder / bounce. Hidden by default in the admin replies tab; never discarded.';
COMMENT ON COLUMN public.newsletter_replies.auto_reply_reason IS
  'Which signal triggered the auto-reply classification (e.g. auto-submitted, precedence-bulk, subject-pattern, dsn). Null when is_auto_reply = false.';
