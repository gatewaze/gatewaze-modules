-- §10: connected tools (MCP). Per-project MCP server config, sealed like any other credential
-- because it can carry bearer tokens (Jira/Slack). SDK-shaped JSON `{ servers: { name: {...} } }`.
-- Empty/absent → the agent runs with no external tool servers (behaviour-neutral default).
alter table if exists public.se_projects
  add column if not exists mcp_config_ciphertext text;

comment on column public.se_projects.mcp_config_ciphertext is
  'AES-256-GCM sealed JSON { servers: {...} } of MCP servers exposed to this project''s agents (§10). NULL = none.';

-- Presence flag so the admin API can report "MCP configured" without ever selecting the sealed blob.
alter table if exists public.se_projects
  add column if not exists has_mcp_config boolean
  generated always as (mcp_config_ciphertext is not null) stored;
