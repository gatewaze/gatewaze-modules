-- Add content_category to scrapers table so scraped events can be auto-categorised.
-- Also update events_create and events_update RPC functions to accept content_category.

ALTER TABLE public.scrapers ADD COLUMN IF NOT EXISTS content_category varchar(100);

-- Drop old function signatures (without p_content_category) to avoid overload ambiguity
DROP FUNCTION IF EXISTS public.events_create(
    text, text, text, text, text, text[], text, text, text, text,
    text, text, text, timestamptz, timestamptz, timestamptz, text, text,
    timestamptz, text, text, text, integer, text, jsonb, text, text, text, jsonb, jsonb
);
DROP FUNCTION IF EXISTS public.events_update(
    uuid, text, text, text, text, text[], text, text, text, text,
    text, text, text, timestamptz, timestamptz, timestamptz, text, text,
    timestamptz, text, text, text, integer, text, jsonb, text, text, text, jsonb, jsonb
);

-- Recreate events_create with content_category parameter
CREATE OR REPLACE FUNCTION public.events_create(
    p_event_id text,
    p_event_title text,
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
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_id uuid;
    existing_event RECORD;
    normalized_link text;
BEGIN
    normalized_link := RTRIM(COALESCE(p_event_link, ''), '/');

    IF normalized_link IS NOT NULL AND normalized_link != '' THEN
        SELECT id, event_id, event_title INTO existing_event
        FROM events
        WHERE RTRIM(COALESCE(event_link, ''), '/') = normalized_link
        LIMIT 1;

        IF FOUND THEN
            RAISE EXCEPTION 'Duplicate event link: An event with this link already exists (ID: %, Title: "%")',
                existing_event.event_id, existing_event.event_title
                USING ERRCODE = '23505';
        END IF;
    END IF;

    INSERT INTO events (
        event_id, event_title, listing_intro, offer_result, offer_close_display,
        event_topics, offer_ticket_details, offer_value, event_city, event_country_code,
        event_link, event_logo, offer_slug, offer_close_date, event_start, event_end,
        event_region, event_location, event_type, content_category,
        venue_address, scraped_by, scraper_id, source_type, source_details, event_timezone,
        luma_event_id, source_event_id, luma_page_data, meetup_page_data, created_at, updated_at
    ) VALUES (
        p_event_id, p_event_title, p_listing_intro, p_offer_result, p_offer_close_display,
        p_event_topics, p_offer_ticket_details, p_offer_value, p_event_city, p_event_country_code,
        CASE WHEN normalized_link = '' THEN NULL ELSE normalized_link END,
        p_event_logo, p_offer_slug, p_offer_close_date, p_event_start, p_event_end,
        p_event_region, p_event_location, p_event_type, p_content_category,
        p_venue_address, p_scraped_by, p_scraper_id, p_source_type, p_source_details, p_event_timezone,
        p_luma_event_id, p_source_event_id, p_luma_page_data, p_meetup_page_data, NOW(), NOW()
    ) RETURNING id INTO new_id;

    RETURN new_id;
END;
$$;

-- Recreate events_update with content_category parameter
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
        event_type = COALESCE(p_event_type, event_type),
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
