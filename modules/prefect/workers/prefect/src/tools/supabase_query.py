"""`supabase_query` custom MCP tool — read-only access to pipeline tables.

Uses the `agent_reader` Supabase client (spec A.8 #1), which has
`SELECT` grants on pipeline tables and nothing else. An agent that asks
for auth.users or newsletters_* will get an HTTP 401/403 at the
PostgREST layer — the role doesn't have permission even if the agent
names the table.

Exposes a narrow surface:
  - table: must be one of a whitelist we maintain here. (Defense in
    depth: even though the role is scoped, we don't want the agent
    reaching for tables we didn't intend it to see.)
  - columns: optional column projection
  - filters: list of {column, op, value} triples
  - order_by / limit: standard bounded query shape

The agent cannot execute raw SQL.
"""

from __future__ import annotations

from typing import Any, Literal

from ..clients.supabase import reader_client

# Whitelist: tables the agent is allowed to query. Tighter than the role's
# GRANTs so changes to the role's grants don't silently widen the agent's
# reach without a code review here.
ALLOWED_TABLES: frozenset[str] = frozenset(
    {
        "content_submissions",
        "content_queue",
        "content_items",
        "content_segments",
        "content_discovery_sources",
        "content_discovery_runs",
        "content_project_taxonomy",
        "content_topic_taxonomy",
    }
)

FilterOp = Literal[
    "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"
]


class SupabaseQueryError(ValueError):
    """Raised for agent-visible query validation failures."""


async def supabase_query(
    table: str,
    *,
    columns: list[str] | None = None,
    filters: list[dict[str, Any]] | None = None,
    order_by: str | None = None,
    ascending: bool = True,
    limit: int = 50,
) -> dict[str, Any]:
    """Execute a narrow SELECT against a whitelisted pipeline table.

    Returns:
        {"table": str, "rows": list[dict], "count": int, "truncated": bool}
    """
    if table not in ALLOWED_TABLES:
        raise SupabaseQueryError(
            f"Table {table!r} is not on the agent's read whitelist. "
            f"Allowed: {sorted(ALLOWED_TABLES)}"
        )
    if limit < 1 or limit > 500:
        raise SupabaseQueryError("limit must be between 1 and 500")

    client = reader_client()
    builder = client.table(table)

    col_expr = "*" if not columns else ",".join(columns)
    q = builder.select(col_expr)

    for f in filters or []:
        col = f.get("column")
        op = f.get("op")
        val = f.get("value")
        if not col or op not in ("eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "is", "in"):
            raise SupabaseQueryError(f"Invalid filter: {f!r}")
        q = _apply_filter(q, col, op, val)

    if order_by:
        q = q.order(order_by, desc=not ascending)

    # Request one extra row so we can report truncation without an
    # additional count round-trip.
    q = q.limit(limit + 1)

    result = q.execute()
    rows = result.data or []
    truncated = len(rows) > limit
    return {
        "table": table,
        "rows": rows[:limit],
        "count": min(len(rows), limit),
        "truncated": truncated,
    }


def _apply_filter(q: Any, col: str, op: FilterOp, val: Any) -> Any:
    """Thin switch over PostgREST filter builders.

    Intentionally verbose so the set of supported ops is explicit.
    """
    if op == "eq":
        return q.eq(col, val)
    if op == "neq":
        return q.neq(col, val)
    if op == "gt":
        return q.gt(col, val)
    if op == "gte":
        return q.gte(col, val)
    if op == "lt":
        return q.lt(col, val)
    if op == "lte":
        return q.lte(col, val)
    if op == "like":
        return q.like(col, val)
    if op == "ilike":
        return q.ilike(col, val)
    if op == "is":
        return q.is_(col, val)
    if op == "in":
        if not isinstance(val, (list, tuple)):
            raise SupabaseQueryError("'in' filter requires a list value")
        return q.in_(col, list(val))
    raise SupabaseQueryError(f"Unsupported op {op!r}")
