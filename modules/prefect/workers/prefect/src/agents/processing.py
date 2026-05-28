"""Processing agent — Phase 2.

Reads pending `content_queue` rows, scrapes each URL, generates
summary/hot_take/quality_score, tags with taxonomy, and emits a
`ProcessingRunOutput`. Orchestration in `flows/processing_pipeline.py`
validates the output and writes in bulk.

Tool allowlist (spec A.8 #3):
  - supabase_query      — read queue, items (for dedup), taxonomy
  - firecrawl_scrape    — required for every publish decision
  - WebSearch (built-in) — optional, for disambiguating author/date

Notably NOT in the allowlist:
  - supabase_insert_submission (discovery-only)
  - supabase_upsert_queue      (triage-only)
  - github_search, rss_fetch   (discovery-only)
"""

from __future__ import annotations

from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool
from pydantic import ValidationError

from ..clients.firecrawl import FirecrawlClient
from ..config import load_config
from ..cost_guard import CostGuard
from ..schemas.processing import ProcessingRunOutput
from ..tools.supabase_query import SupabaseQueryError, supabase_query
from ._common import extract_json_block, extract_text, record_usage
from .prompts import PROCESSING_SYSTEM_PROMPT, wrap_scraped


def _build_mcp_server(firecrawl: FirecrawlClient):
    """Register the processing stage's tool allowlist as an in-process MCP server."""

    @tool(
        "supabase_query",
        "Query a whitelisted pipeline table (SELECT only). Used here for cross-platform dedup against content_items and for looking up topic/project taxonomy slugs.",
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
        "Scrape a URL via self-hosted Firecrawl. Returns markdown + canonical_url, og_url, final_url, html_title. Required for every 'publish' decision — the agent must read actual content before deciding summary/hot_take/quality_score.",
        {"url": str},
    )
    async def firecrawl_scrape_tool(args: dict) -> dict:
        url = args["url"]
        result = await firecrawl.scrape(url)
        wrapped = wrap_scraped(result.markdown, source=url)
        return {
            "content": [
                {
                    "type": "text",
                    "text": (
                        f"canonical_url={result.canonical_url}\n"
                        f"og_url={result.og_url}\n"
                        f"final_url={result.final_url}\n"
                        f"html_title={result.html_title}\n\n"
                        f"{wrapped}"
                    ),
                }
            ]
        }

    return create_sdk_mcp_server(
        name="processing-tools",
        version="0.1.0",
        tools=[supabase_query_tool, firecrawl_scrape_tool],
    )


async def run_processing_agent(*, batch_size: int = 5) -> ProcessingRunOutput:
    """Run the processing agent over up to `batch_size` pending queue items.

    The CostGuard budget is per-batch (budget_usd * batch_size) — this
    matches the spec's `Processing: $0.30/item` intent when processing 5
    items at once.

    Raises:
        CostExceeded:    session crossed the processing cost budget.
        ValidationError: final output failed schema validation.
    """
    cfg = load_config()
    guard = CostGuard(
        stage="processing",
        model=cfg.models.default_model,
        # Per-item budget scaled by batch size. A single item that tries to
        # eat the whole batch budget will still trip the guard and abort.
        budget_usd=cfg.costs.processing_usd * batch_size,
    )

    firecrawl = FirecrawlClient()
    try:
        mcp_server = _build_mcp_server(firecrawl)

        options = ClaudeAgentOptions(
            system_prompt=PROCESSING_SYSTEM_PROMPT,
            mcp_servers={"processing-tools": mcp_server},
            allowed_tools=[
                "mcp__processing-tools__supabase_query",
                "mcp__processing-tools__firecrawl_scrape",
                "WebSearch",
            ],
            max_turns=cfg.agent_max_turns,
            permission_mode="bypassPermissions",
        )

        user_msg = (
            f"Process up to {batch_size} pending queue items. "
            "Start by querying content_queue where status='pending' "
            "ordered by priority ASC, created_at ASC (spec A.7 #1). "
            "For each item: scrape the URL, decide publish / reject / duplicate, "
            "fill the ProcessedItem fields per the schema.\n\n"
            "When done, output a final JSON object matching the "
            "ProcessingRunOutput schema."
        )

        chunks: list[str] = []
        async for message in query(prompt=user_msg, options=options):
            record_usage(message, guard)
            text = extract_text(message)
            if text:
                chunks.append(text)

        final_json = extract_json_block("".join(chunks))
        return ProcessingRunOutput.model_validate_json(final_json)
    finally:
        await firecrawl.close()
