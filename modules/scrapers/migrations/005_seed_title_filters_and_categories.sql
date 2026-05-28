-- Set content_category and title filters on seeded scrapers.
-- Example scrapers default to the 'community' category and pick up
-- Agent/MCP title filters. Adjust these to match your own taxonomy.

UPDATE public.scrapers
SET content_category = COALESCE(content_category, 'community'),
    config = config || '{"titleFilters": ["Agent", "MCP"]}'::jsonb
WHERE account = 'example';
