-- Environment log explorer (follow-up to 025): keyset paging + a rotation-safe
-- ingest cursor.
--
-- 1. se_env_events_ts_id_idx — the explorer pages newest-first with a keyset
--    cursor on (ts desc, id desc). The 025 index on (ts desc) alone cannot
--    serve the tie-break leg, and ties are common: the host tailers bucket
--    visits/service errors on a 60s clock and stamp whole seconds, so a busy
--    minute lands many rows on the same ts.
--
-- 2. se_env_events_cursor.file_id — the ingester tracks a byte offset into
--    /staging-control/events.jsonl. A shrink (copy-truncate) is already
--    detected by comparing the offset to the file length, but a *rename*
--    rotation (events.jsonl → events.jsonl.1, fresh file created) is not: if
--    the replacement grows past the stale offset between two polls, ingestion
--    resumes mid-file and skips — or worse, mid-line and misparses. file_id is
--    the filesystem identity ("<dev>:<ino>") of the file the offset belongs to;
--    a mismatch restarts at 0. Nullable so the column can land before or after
--    the code that writes it (the ingester tolerates both directions).
create index if not exists se_env_events_ts_id_idx on public.se_env_events(ts desc, id desc);

alter table public.se_env_events_cursor add column if not exists file_id text;

-- Retention: the explorer prunes rows older than the retention window from the
-- ingest path (lib/env-events.ts, SE_ENV_EVENTS_RETENTION_DAYS, default 14) so
-- the table cannot grow unbounded. This index makes that delete an index scan
-- rather than a seq scan once the table is large.
create index if not exists se_env_events_ts_asc_idx on public.se_env_events(ts);
