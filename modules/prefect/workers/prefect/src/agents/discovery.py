"""Discovery agent — Phase 1 + Phase 2 (github_search wiring).

Runs a Claude Agent SDK session with a narrow tool allowlist:
  - rss_fetch         (custom, feedparser-backed)
  - firecrawl_scrape  (custom, self-hosted Firecrawl)
  - github_search     (custom, rate-limited)
  - WebSearch         (built-in Claude SDK tool)

Every turn's token usage is recorded in the CostGuard, which aborts the
session when spend crosses DISCOVERY_COST_BUDGET_USD.

The agent's final structured output is parsed into `DiscoveryRunOutput`
before anything is written to the DB.
"""

from __future__ import annotations

from claude_agent_sdk import ClaudeAgentOptions, create_sdk_mcp_server, query, tool
from pydantic import ValidationError

from ..clients.firecrawl import FirecrawlClient
from ..config import load_config
from ..cost_guard import CostExceeded, CostGuard
from ..schemas.discovery import DiscoveryRunOutput
from ..tools.github_search import github_search
from ..tools.rss_fetch import rss_fetch
from ._common import extract_json_block, extract_text, record_usage
from .prompts import DISCOVERY_SYSTEM_PROMPT, wrap_scraped


def _build_mcp_server(firecrawl: FirecrawlClient):
    """Register the discovery stage's tool allowlist as an in-process MCP server."""

    @tool(
        "rss_fetch",
        "Fetch and parse an RSS or Atom feed. Returns recent entries with title, URL, publication date, and a short summary.",
        {"feed_url": str, "max_entries": int},
    )
    async def rss_fetch_tool(args: dict) -> dict:
        feed_url = args["feed_url"]
        max_entries = int(args.get("max_entries", 50))
        raw = await rss_fetch(feed_url, max_entries=max_entries)
        # Wrap entries in the scraped-content envelope so the agent treats
        # titles/summaries as data.
        raw["wrapped"] = wrap_scraped(
            "\n".join(f"- {e['title']} — {e['url']}" for e in raw["entries"]),
            source=feed_url,
        )
        return {"content": [{"type": "text", "text": str(raw)}]}

    @tool(
        "firecrawl_scrape",
        "Scrape a single URL via the self-hosted Firecrawl service. Returns markdown, canonical URL, OG URL, final URL, and HTML title.",
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

    @tool(
        "github_search",
        "Search GitHub for repositories, issues, or code. Use this for github_topic and github_repo sources. Rate-limited to 5000 req/hr across all worker replicas.",
        {"query": str, "kind": str, "max_results": int},
    )
    async def github_search_tool(args: dict) -> dict:
        result = await github_search(
            query=args["query"],
            kind=args.get("kind", "repositories"),
            max_results=int(args.get("max_results", 25)),
        )
        return {"content": [{"type": "text", "text": str(result)}]}

    return create_sdk_mcp_server(
        name="discovery-tools",
        version="0.1.0",
        tools=[rss_fetch_tool, firecrawl_scrape_tool, github_search_tool],
    )


async def run_discovery_agent(
    *,
    source_ids: list[str] | None,
    user_instruction: str,
) -> DiscoveryRunOutput:
    """Run the discovery agent against the given sources.

    Raises:
        CostExceeded: if the session crosses the discovery cost budget.
        pydantic.ValidationError: if the final output fails schema validation.
    """
    cfg = load_config()
    guard = CostGuard(
        stage="discovery",
        model=cfg.models.default_model,
        budget_usd=cfg.costs.discovery_usd,
    )

    firecrawl = FirecrawlClient()
    try:
        mcp_server = _build_mcp_server(firecrawl)

        options = ClaudeAgentOptions(
            system_prompt=DISCOVERY_SYSTEM_PROMPT,
            mcp_servers={"discovery-tools": mcp_server},
            allowed_tools=[
                "mcp__discovery-tools__rss_fetch",
                "mcp__discovery-tools__firecrawl_scrape",
                "mcp__discovery-tools__github_search",
                "WebSearch",
            ],
            max_turns=cfg.agent_max_turns,
            permission_mode="bypassPermissions",  # pre-approved tool allowlist
        )

        source_scope = ",".join(source_ids) if source_ids else "all active sources"
        user_msg = (
            f"Discover new content for these sources: {source_scope}.\n\n"
            f"{user_instruction}\n\n"
            "When done, output a final JSON object matching the DiscoveryRunOutput schema."
        )

        chunks: list[str] = []
        async for message in query(prompt=user_msg, options=options):
            record_usage(message, guard)
            text = extract_text(message)
            if text:
                chunks.append(text)

        final_json = extract_json_block("".join(chunks))
        return DiscoveryRunOutput.model_validate_json(final_json)
    finally:
        await firecrawl.close()
