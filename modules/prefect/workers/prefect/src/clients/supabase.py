"""Scoped Supabase clients for agent DB access.

Two clients, corresponding to the two Postgres roles created in
migration 001_prefect_schema.sql:

- `reader_client()` — authenticates as `agent_reader` (SELECT-only).
- `writer_client()` — authenticates as `agent_writer` (INSERT + narrow UPDATE).

Both go through the Supabase REST API. No direct Postgres connection
from agent tools, which keeps the blast radius inside Supabase's
RLS + GRANT system.

The Prefect worker itself (orchestration code, NOT agent tools) uses
`service_client()` with the service role key for operations like
writing to `content_discovery_runs` or reading configuration.
"""

from __future__ import annotations

from functools import cache

from supabase import Client, create_client

from ..config import load_config


@cache
def reader_client() -> Client:
    """Supabase client for the `agent_reader` role.

    Call this from the supabase_query custom MCP tool.
    """
    cfg = load_config()
    return create_client(cfg.supabase.url, cfg.supabase.agent_reader_key)


@cache
def writer_client() -> Client:
    """Supabase client for the `agent_writer` role.

    Call this from the supabase_insert_submission, supabase_upsert_queue,
    and supabase_upsert_item custom MCP tools.
    """
    cfg = load_config()
    return create_client(cfg.supabase.url, cfg.supabase.agent_writer_key)


@cache
def service_client() -> Client:
    """Supabase client for the Prefect worker itself (service role).

    NEVER pass this into an agent tool. Use this only for orchestration
    code — writing to content_discovery_runs, reading sources, etc.
    """
    import os

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise RuntimeError(
            "service_client() requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to be set"
        )
    return create_client(url, key)
