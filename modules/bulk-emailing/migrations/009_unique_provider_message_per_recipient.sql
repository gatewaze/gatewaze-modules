-- ============================================================================
-- Module: bulk-emailing
-- Migration: 009_unique_provider_message_per_recipient
-- Description: Add a partial UNIQUE index on
--                (provider_message_id, recipient_email)
--              of public.email_send_log, scoped to rows where
--              provider_message_id IS NOT NULL.
--
-- Why this shape (composite, not bare provider_message_id):
--
--   * The newsletter send path (modules/newsletters/functions/newsletter-
--     send/index.ts) does one SendGrid POST per recipient and stores the
--     returned x-message-id on its own per-recipient email_send_log row.
--     That side of the system has always been one-row-per-(message_id),
--     so a bare UNIQUE on provider_message_id would be safe today.
--
--   * The bulk-emailing batch-send path historically POSTs ONE request
--     with multiple `personalizations`, and SendGrid returns ONE
--     x-message-id that covers every recipient in that POST. Those rows
--     legitimately share a provider_message_id across DIFFERENT
--     recipient_emails. As of this migration AAIF prod has 222 such
--     legacy pairs, all from March 2026, all with newsletter_send_id
--     NULL. A bare UNIQUE on provider_message_id would reject the
--     index build.
--
--   * (provider_message_id, recipient_email) is the natural "this one
--     email" key for either path: each tuple identifies exactly one
--     delivered envelope. Cross-talk — the failure mode this migration
--     prevents — would be two rows sharing both columns, which means
--     two ostensibly-distinct logs for the same actual email; a bug.
--
-- Companion code change (same release): the email-webhook handler in
-- modules/bulk-emailing/functions/email-webhook/index.ts changes its
-- log lookup from `.eq(provider_message_id).single()` to
-- `.eq(provider_message_id).eq(recipient_email).maybeSingle()`, which
-- the SendGrid event payload (includes `email`) makes possible. The
-- old single-column lookup silently dropped events whenever a batched
-- row matched two recipients; the new path attributes each event to
-- exactly the right log row.
-- ============================================================================

-- Defensive — if a previous run created an index with this name, drop it
-- so the CREATE below succeeds in either state.
DROP INDEX IF EXISTS public.email_send_log_provider_msg_recipient_unique;

CREATE UNIQUE INDEX email_send_log_provider_msg_recipient_unique
  ON public.email_send_log (provider_message_id, recipient_email)
  WHERE provider_message_id IS NOT NULL;

COMMENT ON INDEX public.email_send_log_provider_msg_recipient_unique IS
  'Per-(provider_message_id, recipient_email) uniqueness. Prevents future webhook attribution cross-talk while remaining compatible with legacy batch-send rows where one SendGrid message_id covers multiple recipients.';
