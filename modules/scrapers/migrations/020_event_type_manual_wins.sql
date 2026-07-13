-- ============================================================================
-- scrapers_020_event_type_manual_wins
--
-- events_update stamped the scraper's configured event_type on every run
-- (COALESCE(p_event_type, event_type)), so re-classifying an event in the
-- admin was reverted by the next scrape. The scraper's type now only fills a
-- NULL event_type; an existing value — scraper-seeded or admin-set — is kept.
-- events_create is unchanged (first write still records the scraper's type).
--
-- Idempotent / safe to re-run.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.events_update(
    p_id uuid,
    p_event_title text DEFAULT NULL,
    p_listing_intro text DEFAULT NULL,
    p_offer_result text DEFAULT NULL,
    p_offer_close_display text DEFAULT NULL,
    p_event_topics text[] DEFAULT NULL,
    p_offer_ticket_details text DEFAULT NULL,
    p_offer_value text DEFAULT NULL,
    p_event_city text DEFAULT NULL,
    p_event_country_code text DEFAULT NULL,
    p_event_link text DEFAULT NULL,
    p_event_logo text DEFAULT NULL,
    p_offer_slug text DEFAULT NULL,
    p_offer_close_date timestamptz DEFAULT NULL,
    p_event_start timestamptz DEFAULT NULL,
    p_event_end timestamptz DEFAULT NULL,
    p_event_region text DEFAULT NULL,
    p_event_location text DEFAULT NULL,
    p_event_topics_updated_at timestamptz DEFAULT NULL,
    p_event_type text DEFAULT NULL,
    p_venue_address text DEFAULT NULL,
    p_scraped_by text DEFAULT NULL,
    p_scraper_id integer DEFAULT NULL,
    p_source_type text DEFAULT NULL,
    p_source_details jsonb DEFAULT NULL,
    p_event_timezone text DEFAULT NULL,
    p_luma_event_id text DEFAULT NULL,
    p_source_event_id text DEFAULT NULL,
    p_luma_page_data jsonb DEFAULT NULL,
    p_meetup_page_data jsonb DEFAULT NULL,
    p_content_category text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE events
    SET
        event_title = COALESCE(p_event_title, event_title),
        listing_intro = COALESCE(p_listing_intro, listing_intro),
        offer_result = COALESCE(p_offer_result, offer_result),
        offer_close_display = COALESCE(p_offer_close_display, offer_close_display),
        event_topics = COALESCE(p_event_topics, event_topics),
        offer_ticket_details = COALESCE(p_offer_ticket_details, offer_ticket_details),
        offer_value = COALESCE(p_offer_value, offer_value),
        event_city = COALESCE(p_event_city, event_city),
        event_country_code = COALESCE(p_event_country_code, event_country_code),
        event_link = COALESCE(p_event_link, event_link),
        event_logo = COALESCE(p_event_logo, event_logo),
        offer_slug = COALESCE(p_offer_slug, offer_slug),
        offer_close_date = COALESCE(p_offer_close_date, offer_close_date),
        event_start = COALESCE(p_event_start, event_start),
        event_end = COALESCE(p_event_end, event_end),
        event_region = COALESCE(p_event_region, event_region),
        event_location = COALESCE(p_event_location, event_location),
        -- Manual classification WINS: scrapers pass their configured type on
        -- every run, which used to clobber admin-set types on each re-scrape
        -- (e.g. Voice Agents Forum reverting to 'meetup' nightly). Fill-only.
        event_type = COALESCE(event_type, p_event_type),
        content_category = COALESCE(p_content_category, content_category),
        venue_address = COALESCE(p_venue_address, venue_address),
        scraped_by = COALESCE(p_scraped_by, scraped_by),
        scraper_id = COALESCE(p_scraper_id, scraper_id),
        source_type = COALESCE(p_source_type, source_type),
        source_details = COALESCE(p_source_details, source_details),
        event_timezone = COALESCE(p_event_timezone, event_timezone),
        luma_event_id = COALESCE(p_luma_event_id, luma_event_id),
        source_event_id = COALESCE(p_source_event_id, source_event_id),
        luma_page_data = COALESCE(p_luma_page_data, luma_page_data),
        meetup_page_data = COALESCE(p_meetup_page_data, meetup_page_data),
        updated_at = NOW()
    WHERE id = p_id;

    RETURN FOUND;
END;
$$;
