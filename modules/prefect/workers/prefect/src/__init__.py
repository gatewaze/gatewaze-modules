"""Gatewaze Prefect worker package.

Runs content discovery + (Phase 3) newsletter generation flows against a
self-hosted Prefect Server whose metadata lives in a dedicated `prefect`
schema on the existing Supabase Postgres.

See the module README for layout.
"""

__version__ = "0.1.0"
