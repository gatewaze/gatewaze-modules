-- The import row's source_kind was constrained to 'sched' when sched.com was
-- the only parser. Sessionize imports have been running since October with
-- the row still saying 'sched', and writing the real kind was rejected by
-- this CHECK. Allow every registered kind; the registry
-- (lib/schedule-sources/index.ts) is the source of truth for the list.
ALTER TABLE public.events_schedule_imports
  DROP CONSTRAINT IF EXISTS events_schedule_imports_source_kind_check;
ALTER TABLE public.events_schedule_imports
  ADD CONSTRAINT events_schedule_imports_source_kind_check
  CHECK (source_kind IN ('sched', 'sessionize'));
