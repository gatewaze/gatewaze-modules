-- Per-project memory git-sync target. The memory module was always designed around a
-- "per-project git-sync repo" (lib/memory.ts §22) but nothing wrote to it — memory only lived in
-- the AI wiki. This column names the dedicated repo (format "owner/name", e.g.
-- danthebaker/gatewaze-memory) that lib/memory-git.ts syncs the project's APPROVED memory + specs to
-- after each approveMemory / approveSpec. Null = no sync.
alter table public.se_projects add column if not exists memory_repo text;

comment on column public.se_projects.memory_repo is
  'Dedicated memory repo (owner/name) the SE module git-syncs approved memory to after each commit to memory; null disables the sync.';
