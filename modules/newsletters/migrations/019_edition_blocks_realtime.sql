-- Enable Supabase realtime on newsletter edition blocks so the admin
-- AI Content editor can live-update when output.html lands (via the
-- newsletter-helix-output-sync edge function or any other writer).
-- Without this, users have to refresh the page after a sync to see
-- the imported content.

ALTER PUBLICATION supabase_realtime ADD TABLE public.newsletters_edition_blocks;
