"""Triage agent — Phase 2.

Reads pending `content_submissions`, classifies each, emits a
`TriageRunOutput` that the orchestration task in
`flows/triage_pipeline.py` validates and writes in bulk.

Tool allowlist (spec A.8 #3):
  - supabase_query      — read submissions, items, sources, taxonomy
  - firecrawl_scrape    — canonical URL extraction only (light touch)

Notably NOT in the allowlist:
  - supabase_insert_submission (discovery-only)
  - github_search, rss_fetch   (discovery-only)
  - supabase_upsert_item       (processing-only)
"""

from __future__ import annotations

from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool
from pydantic import ValidationError

from ..clients.firecrawl import FirecrawlClient
from ..config import load_config
from ..cost_guard import CostGuard
from ..schemas.triage import TriageRunOutput
from ..tools.supabase_query import SupabaseQueryError, supabase_query
from ._common import extract_json_block, extract_text, record_usage
from .prompts import TRIAGE_SYSTEM_PROMPT, wrap_scraped


def _build_mcp_server(firecrawl: FirecrawlClient):
    """Register the triage stage's tool allowlist as an in-process MCP server."""

    @tool(
        "supabase_query",
        "Query a whitelisted pipeline table (SELECT only). Supports column projection, filters (eq/neq/gt/gte/lt/lte/like/ilike/is/in), order_by, and limit.",
        {
            "table": str,
            "columns": list,
            "filters": list,
            "order_by": str,
            "ascending": bool,
            "limit": int,
        },
    )
    async def supabase_query_tool(args: dict) -> dict:
        try:
            result = await supabase_query(
                table=args["table"],
                columns=args.get("columns") or None,
                filters=args.get("filters") or None,
                order_by=args.get("order_by") or None,
                ascending=bool(args.get("ascending", True)),
                limit=int(args.get("limit", 50)),
            )
        except SupabaseQueryError as exc:
            return {
                "content": [{"type": "text", "text": f"supabase_query error: {exc}"}],
                "is_error": True,
            }
        return {"content": [{"type": "text", "text": str(result)}]}

    @tool(
        "firecrawl_scrape",
        "Scrape a URL via self-hosted Firecrawl. Use ONLY to extract canonical_url / og_url when the submission URL looks redirected. Do NOT re-scrape full pages — processing handles that.",
        {"url": str},
    )
    async def firecrawl_scrape_tool(args: dict) -> dict:
        url = args["url"]
        result = await firecrawl.scrape(url)
        # For triage we return metadata only, NOT the full markdown — keeps
        # context lean and discourages the agent from doing processing work.
        return {
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"canonical_url={result.canonical_url}\n"
                        f"og_url={result.og_url}\n"
                        f"final_url={result.final_url}\n"
                        f"html_title={result.html_title}"
                    ),
                }
            ]
        }

    return create_sdk_mcp_server(
        name="triage-tools",
        version="0.1.0",
        tools=[supabase_query_tool, firecrawl_scrape_tool],
    )


async def run_triage_agent(*, batch_size: int = 20) -> TriageRunOutput:
    """Run the triage agent over up to `batch_size` pending submissions.

    Raises:
        CostExceeded:    session crossed the triage cost budget.
        ValidationError: final output failed schema validation.
    """
    cfg = load_config()
    guard = CostGuard(
        stage="triage",
        model=cfg.models.default_model,
        budget_usd=cfg.costs.triage_usd,
    )

    firecrawl = FirecrawlClient()
    try:
        mcp_server = _build_mcp_server(firecrawl)

        options = ClaudeAgentOptions(
            system_prompt=TRIAGE_SYSTEM_PROMPT,
            mcp_servers={"triage-tools": mcp_server},
            allowed_tools=[
                "mcp__triage-tools__supabase_query",
                "mcp__triage-tools__firecrawl_scrape",
            ],
            max_turns=cfg.agent_max_turns,
            permission_mode="bypassPermissions",
        )

        user_msg = (
            f"Triage up to {batch_size} pending submissions. "
            "Start by querying content_submissions where status='pending' "
            "ordered by priority DESC, created_at ASC. For each, decide "
            "queue / reject / duplicate and fill the TriagedItem fields.\n\n"
            "When done, output a final JSON object matching the "
            "TriageRunOutput schema."
        )

        chunks: list[str] = []
        async for message in query(prompt=user_msg, options=options):
            record_usage(message, guard)
            text = extract_text(message)
            if text:
                chunks.append(text)

        final_json = extract_json_block("".join(chunks))
        return TriageRunOutput.model_validate_json(final_json)
    finally:
        await firecrawl.close()
