-- ============================================================================
-- 020: email_send_log.content_html retention support
--
-- The send engine now stores the exact rendered per-recipient HTML in
-- content_html for newsletter and broadcast sends (so People > Emails can show
-- exactly what a person was sent). That column is large (~32 KB/row), so a
-- background job (bulk-emailing:prune-content-html) nulls it out for rows past
-- a retention window (EMAIL_CONTENT_HTML_RETENTION_DAYS, default 180). The row
-- and all its tracking stay; only the HTML body is dropped.
--
-- Partial index so the prune job finds prunable rows (content retained, old)
-- without scanning the whole multi-million-row table each run. Only rows that
-- actually carry content_html are indexed, so it stays small.
--
-- NOTE: on the populated production table, build this with
-- CREATE INDEX CONCURRENTLY out-of-band (a plain build takes a ShareLock that
-- blocks send inserts while it scans). The IF NOT EXISTS then no-ops when this
-- migration is applied.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_esl_content_html_prune
  ON public.email_send_log (sent_at)
  WHERE content_html IS NOT NULL;
