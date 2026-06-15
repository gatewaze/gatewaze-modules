-- Cross-edition "confirmed human" corroboration (spec §6, Part C).
--
-- Apple MPP proxies/prefetches every open, so an open alone can't prove a human
-- opened it. A CLICK can — and human identity persists across editions: if a
-- recipient ever clicks (in ANY imported edition), they are provably a human,
-- and their opens elsewhere are human-attributable. This RPC counts, for one
-- edition, how many of its openers are corroborated-human via a click anywhere.
-- It is a defensible LOWER BOUND on human opens (Customer.io's higher figure
-- additionally attributes human-ness to no-click MPP opens, which can't be
-- verified from open data alone).

CREATE OR REPLACE FUNCTION public.edition_corroborated_engagement(p_edition_id uuid)
RETURNS TABLE (
  openers                   bigint,
  human_via_click_xedition  bigint,  -- opened this edition AND clicked in any edition
  clicked_this_edition      bigint,
  total_ever_clickers       bigint   -- distinct recipients who clicked in any edition
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH sends AS (
    SELECT id FROM public.newsletter_sends WHERE edition_id = p_edition_id
  ),
  edition_openers AS (
    SELECT DISTINCT l.recipient_email
    FROM public.email_send_log l
    JOIN sends s ON l.newsletter_send_id = s.id
    WHERE l.first_opened_at IS NOT NULL
  )
  SELECT
    (SELECT count(*) FROM edition_openers),
    -- Confirmed human: opened this edition AND clicked somewhere in the FULL
    -- Customer.io weekly history (cio_recipient_engagement, all 143 weeklies).
    (SELECT count(*) FROM edition_openers o
       JOIN public.cio_recipient_engagement r ON r.recipient_email = o.recipient_email
       WHERE r.editions_clicked > 0),
    (SELECT count(DISTINCT l.recipient_email)
       FROM public.email_send_log l JOIN sends s ON l.newsletter_send_id = s.id
       WHERE l.first_clicked_at IS NOT NULL),
    (SELECT count(*) FROM public.cio_recipient_engagement WHERE editions_clicked > 0);
$$;

GRANT EXECUTE ON FUNCTION public.edition_corroborated_engagement(uuid) TO authenticated;

COMMENT ON FUNCTION public.edition_corroborated_engagement(uuid) IS
  'Cross-edition click corroboration: defensible lower-bound human openers for an edition (spec §6 Part C).';
