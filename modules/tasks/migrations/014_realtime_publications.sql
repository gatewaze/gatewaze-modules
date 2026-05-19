-- tasks module — 014 — Supabase Realtime publications (spec §3.10).
--
-- The supabase_realtime publication is created by Supabase as part of
-- platform setup. We add our tables to it. If the publication doesn't
-- exist (some self-host setups), we skip silently — Realtime is then
-- opt-in via the operator's own publication.

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.tasks;
    alter publication supabase_realtime add table public.task_comments;
    alter publication supabase_realtime add table public.task_activity;
    alter publication supabase_realtime add table public.task_notifications;
    alter publication supabase_realtime add table public.task_dependencies;
    alter publication supabase_realtime add table public.task_field_values;
    alter publication supabase_realtime add table public.task_boards;
    alter publication supabase_realtime add table public.board_statuses;
    alter publication supabase_realtime add table public.board_custom_fields;
    alter publication supabase_realtime add table public.task_links;
  end if;
exception
  when duplicate_object then null;   -- tables already in publication
end $$;
